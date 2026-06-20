import { randomUUID } from 'node:crypto';
import {
  type S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  EvidenceSchema,
  assertCaptureComplete,
  EVIDENCE_SCREENSHOT_FILE,
  EVIDENCE_HTML_FILE,
  EVIDENCE_TERMS_FILE,
  EVIDENCE_META_FILE,
  type Evidence,
  type EvidenceCapture,
} from '../../domain/index.js';
import type { EvidenceStore } from '../../application/ports/index.js';

/**
 * Infrastructure failure writing/reading an S3/R2 evidence bundle. Local to this
 * adapter (the domain must not know about an object store) and carries the
 * underlying cause for diagnostics — the S3 sibling of the local-fs
 * `EvidenceStoreError`, so both stores fail loudly the same way.
 */
export class S3EvidenceStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'S3EvidenceStoreError';
  }
}

/**
 * Object-key suffixes inside a bundle. The `*_ref` pointers we store are the
 * id-prefixed keys below — the SAME shape local-fs uses — so `get()` /
 * `verifyBundleComplete` resolve them identically across both stores. The names
 * come from the domain {@link EVIDENCE_SCREENSHOT_FILE} et al. so the public read
 * API derives the same screenshot path it's stored under (single source of truth).
 */
const SCREENSHOT_FILE = EVIDENCE_SCREENSHOT_FILE;
const HTML_FILE = EVIDENCE_HTML_FILE;
const TERMS_FILE = EVIDENCE_TERMS_FILE;
const META_FILE = EVIDENCE_META_FILE;

const PNG_CONTENT_TYPE = 'image/png';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * S3/R2 EvidenceStore — the production sibling of {@link LocalFsEvidenceStore}
 * behind the {@link EvidenceStore} port. Each bundle is a set of object keys
 * under `<id>/` holding the screenshot + HTML + terms text plus an
 * `evidence.json` metadata object that {@link get} reads back.
 *
 * Bundles are WRITE-ONCE (trust invariant: monitoring keeps old evidence rather
 * than overwriting it). S3 has no atomic directory rename, so we reconstruct
 * local-fs's two guarantees from object semantics:
 *
 *  - **No partial bundle.** The three BODY objects are written FIRST, the META
 *    object (`evidence.json`) LAST. `get()` keys off the meta object, so a crash
 *    after bodies-but-before-meta leaves the bundle INVISIBLE (`get` returns
 *    null) — the same net guarantee as local-fs's staging-then-rename.
 *  - **Write-once.** The meta object is written with a conditional put
 *    (`IfNoneMatch: '*'`), so re-saving the same id can't clobber prior
 *    evidence; a collision (vanishingly unlikely with a random uuid) fails loudly.
 *
 * The {@link S3Client} is INJECTED (constructed once at the composition root) so
 * the adapter stays testable against a fake client and no vendor is `new`ed here.
 */
export class S3EvidenceStore implements EvidenceStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: { client: S3Client; bucket: string }) {
    this.client = opts.client;
    this.bucket = opts.bucket;
  }

  /**
   * Tear down the underlying S3 HTTP agent/sockets. The composition root registers
   * the store in `closables` so `Container.shutdown()` releases the connection pool
   * (the SDK exposes `destroy()`, not an async `close`, so we adapt it here).
   */
  async close(): Promise<void> {
    this.client.destroy();
  }

  async save(capture: EvidenceCapture): Promise<Evidence> {
    // Reject a hollow capture BEFORE any S3 write — exactly like local-fs. A
    // fetcher can return an ok-fetch with an empty screenshot (e.g. Firecrawl
    // omits it); persisting that would pin a candidate to evidence get() later
    // rejects as unloadable. Fail loudly at the chokepoint (trust-critical).
    assertCaptureComplete(capture);

    const id = randomUUID();
    const screenshotKey = `${id}/${SCREENSHOT_FILE}`;
    const htmlKey = `${id}/${HTML_FILE}`;
    const termsKey = `${id}/${TERMS_FILE}`;
    const metaKey = `${id}/${META_FILE}`;

    const evidence: Evidence = {
      id,
      source_url: capture.sourceUrl,
      // Refs are the id-prefixed object keys — the SAME shape local-fs stores —
      // so the bundle stays relocatable and get()/verifyBundleComplete resolve them.
      screenshot_ref: screenshotKey,
      html_ref: htmlKey,
      terms_ref: termsKey,
      captured_at: capture.capturedAt,
      content_hash: capture.contentHash,
    };

    // Validate our own output at the boundary before persisting it — a malformed
    // capture (e.g. empty url) must fail here, never become unreadable evidence.
    const validated = EvidenceSchema.parse(evidence);

    // Write the three BODY objects FIRST. If any fails, the catch surfaces it and
    // no meta object is ever written, so get() never surfaces a partial bundle.
    try {
      await Promise.all([
        this.putObject(screenshotKey, capture.screenshot, PNG_CONTENT_TYPE),
        this.putObject(htmlKey, capture.html, HTML_CONTENT_TYPE),
        this.putObject(termsKey, capture.termsText, TEXT_CONTENT_TYPE),
      ]);
    } catch (err) {
      throw new S3EvidenceStoreError(`Failed to write evidence bundle ${id}.`, { cause: err });
    }

    // Publish: write the META object LAST, conditionally (write-once). A
    // precondition failure means an object already lives at this key — a uuid
    // collision; fail loudly rather than silently clobber prior evidence.
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: metaKey,
          Body: JSON.stringify(validated, null, 2),
          ContentType: JSON_CONTENT_TYPE,
          IfNoneMatch: '*',
        }),
      );
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw new S3EvidenceStoreError(
          `Refusing to overwrite existing evidence bundle ${id} (write-once).`,
          { cause: err },
        );
      }
      throw new S3EvidenceStoreError(`Failed to publish evidence bundle ${id}.`, { cause: err });
    }

    return validated;
  }

  async get(id: string): Promise<Evidence | null> {
    const metaKey = `${id}/${META_FILE}`;
    let raw: string;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: metaKey }),
      );
      if (!res.Body) {
        throw new S3EvidenceStoreError(`Evidence bundle ${id} returned an empty meta body.`);
      }
      raw = await res.Body.transformToString('utf-8');
    } catch (err) {
      // A missing meta object means the bundle does not exist (or was never
      // published past its bodies) — mirror local-fs's ENOENT → null.
      if (isNotFound(err)) return null;
      if (err instanceof S3EvidenceStoreError) throw err;
      throw new S3EvidenceStoreError(`Failed to read evidence bundle ${id}.`, { cause: err });
    }

    // Re-validate on read: never trust stored data blindly (boundary discipline).
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new S3EvidenceStoreError(`Stored evidence ${id} is corrupt: invalid JSON.`, {
        cause: err,
      });
    }
    const parsed = EvidenceSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new S3EvidenceStoreError(`Stored evidence ${id} is corrupt: ${parsed.error.message}`);
    }

    // Structural-integrity check: every body object the metadata references must
    // exist and be non-empty. The bodies-then-meta ordering already makes a torn
    // bundle invisible; this is defense-in-depth against a partial restore that
    // resurrects the meta without its bodies — fail loudly, never serve a hollow
    // bundle. (Deliberately structural, NOT a content-hash recompute: see local-fs.)
    await this.verifyBundleComplete(id, parsed.data);
    return parsed.data;
  }

  private async putObject(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  private async verifyBundleComplete(id: string, evidence: Evidence): Promise<void> {
    const refs = [evidence.screenshot_ref, evidence.html_ref, evidence.terms_ref];
    for (const ref of refs) {
      let contentLength: number | undefined;
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: ref }),
        );
        contentLength = head.ContentLength;
      } catch (err) {
        if (isNotFound(err)) {
          throw new S3EvidenceStoreError(
            `Stored evidence ${id} is incomplete: missing referenced object ${ref}.`,
            { cause: err },
          );
        }
        throw new S3EvidenceStoreError(`Failed to verify evidence bundle ${id}.`, { cause: err });
      }
      if (contentLength === undefined || contentLength <= 0) {
        throw new S3EvidenceStoreError(
          `Stored evidence ${id} is corrupt: referenced object ${ref} is empty.`,
        );
      }
    }
  }
}

/**
 * S3/R2 returns a 404 for a missing key as `NoSuchKey` (GetObject) or `NotFound`
 * (HeadObject); some S3-compatible stores only set the HTTP status. Treat any of
 * these as "missing" so `get()` can return null instead of throwing.
 */
function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(err) === 404;
}

/** A conditional `IfNoneMatch: '*'` put rejects an existing key with HTTP 412. */
function isPreconditionFailed(err: unknown): boolean {
  return errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412;
}

function errorName(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    const meta = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    const code = meta?.httpStatusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}
