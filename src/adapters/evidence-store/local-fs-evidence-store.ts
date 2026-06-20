import { mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
 * Infrastructure failure writing/reading a local evidence bundle. Local to this
 * adapter (the domain must not know about a filesystem store) and carries the
 * underlying cause for diagnostics, mirroring `TimeoutError` in `shared/retry.ts`.
 */
export class EvidenceStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvidenceStoreError';
  }
}

/**
 * Filenames inside a bundle directory. The `*_ref` pointers we store are the
 * relative paths below; the adapter owns the layout, callers treat refs as opaque.
 * Names come from the domain {@link EVIDENCE_SCREENSHOT_FILE} et al. so the public
 * read API derives the same screenshot path it's stored under (single source of truth).
 */
const SCREENSHOT_FILE = EVIDENCE_SCREENSHOT_FILE;
const HTML_FILE = EVIDENCE_HTML_FILE;
const TERMS_FILE = EVIDENCE_TERMS_FILE;
const META_FILE = EVIDENCE_META_FILE;

/**
 * Local-filesystem EvidenceStore — the dev default behind the {@link EvidenceStore}
 * port (S3/R2 is the production sibling). Each bundle gets its own directory
 * `<baseDir>/<id>/` holding the screenshot + HTML + terms text plus an
 * `evidence.json` metadata record that {@link get} reads back.
 *
 * Bundles are WRITE-ONCE (trust invariant: monitoring keeps old evidence rather
 * than overwriting it). A collision on the generated id — vanishingly unlikely —
 * fails loudly rather than silently clobbering prior evidence.
 *
 * Writes are ATOMIC: every file is written into a sibling staging directory first,
 * then the staging dir is `rename`d into its final `<id>/` location in one step.
 * A crash or disk-full mid-write leaves only an orphaned `.tmp-*` staging dir that
 * {@link get} never looks at — never a half-written bundle that `get()` would
 * surface as valid evidence (the trust invariant: no partial evidence).
 */
export class LocalFsEvidenceStore implements EvidenceStore {
  constructor(private readonly baseDir: string) {}

  async save(capture: EvidenceCapture): Promise<Evidence> {
    // Reject a hollow capture BEFORE writing — the same way get()/verifyBundleComplete
    // rejects it on read. A fetcher can return an ok-fetch with an empty screenshot
    // (e.g. Firecrawl omits it), which would otherwise persist a candidate whose
    // evidence get() later rejects as unloadable. Fail loudly at the chokepoint so
    // no candidate is ever pinned to evidence that can't be loaded back.
    assertCaptureComplete(capture);

    const id = randomUUID();
    const finalDir = join(this.baseDir, id);
    // Staging dir is a sibling under the SAME base dir, so the final `rename` is a
    // same-filesystem move (atomic). A random suffix avoids a retry colliding.
    const stagingDir = join(this.baseDir, `.tmp-${id}-${randomUUID()}`);

    const evidence: Evidence = {
      id,
      source_url: capture.sourceUrl,
      // Refs are relative to the bundle dir so the store stays relocatable.
      screenshot_ref: join(id, SCREENSHOT_FILE),
      html_ref: join(id, HTML_FILE),
      terms_ref: join(id, TERMS_FILE),
      captured_at: capture.capturedAt,
      content_hash: capture.contentHash,
    };

    // Validate our own output at the boundary before persisting it — a malformed
    // capture (e.g. empty url) must fail here, never become unreadable evidence.
    const validated = EvidenceSchema.parse(evidence);

    await mkdir(this.baseDir, { recursive: true });
    await mkdir(stagingDir, { recursive: false });
    try {
      // Write the whole bundle into staging. If any of these fails, the catch
      // removes the staging dir and no `<id>/` bundle ever appears.
      await Promise.all([
        writeFile(join(stagingDir, SCREENSHOT_FILE), capture.screenshot),
        writeFile(join(stagingDir, HTML_FILE), capture.html, 'utf8'),
        writeFile(join(stagingDir, TERMS_FILE), capture.termsText, 'utf8'),
        writeFile(join(stagingDir, META_FILE), JSON.stringify(validated, null, 2), 'utf8'),
      ]);
      // Atomic publish: a fully-written staging dir becomes the bundle in one op.
      // `rename` onto an existing non-empty dir fails, preserving write-once.
      await rename(stagingDir, finalDir);
    } catch (err) {
      // Best-effort cleanup of the staging dir; never mask the original failure.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw new EvidenceStoreError(`Failed to write evidence bundle ${id}.`, { cause: err });
    }

    return validated;
  }

  async get(id: string): Promise<Evidence | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.baseDir, id, META_FILE), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new EvidenceStoreError(`Failed to read evidence bundle ${id}.`, { cause: err });
    }

    // Re-validate on read: never trust on-disk data blindly (boundary discipline).
    const parsed = EvidenceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new EvidenceStoreError(`Stored evidence ${id} is corrupt: ${parsed.error.message}`);
    }

    // Structural-integrity check: every file the metadata references must exist and
    // be non-empty. The atomic write already makes a torn bundle unreachable; this
    // is defense-in-depth against later bit-rot / a partial restore that resurrects
    // the metadata without its body — fail loudly rather than serve a hollow bundle.
    // (Deliberately structural, NOT a content-hash recompute: `content_hash` is the
    // monitoring fingerprint over the price/terms REGION, not necessarily the whole
    // terms file, so re-hashing here would couple the store to a producer detail.)
    await this.verifyBundleComplete(id, parsed.data);
    return parsed.data;
  }

  private async verifyBundleComplete(id: string, evidence: Evidence): Promise<void> {
    const refs = [evidence.screenshot_ref, evidence.html_ref, evidence.terms_ref];
    for (const ref of refs) {
      let size: number;
      try {
        // Refs are relative to baseDir (they embed the bundle id); resolve from there.
        size = (await stat(join(this.baseDir, ref))).size;
      } catch (err) {
        throw new EvidenceStoreError(
          `Stored evidence ${id} is incomplete: missing referenced file ${ref}.`,
          { cause: err },
        );
      }
      if (size === 0) {
        throw new EvidenceStoreError(
          `Stored evidence ${id} is corrupt: referenced file ${ref} is empty.`,
        );
      }
    }
  }
}
