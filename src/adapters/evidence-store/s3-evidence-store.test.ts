import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  type S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { S3EvidenceStore, S3EvidenceStoreError } from './s3-evidence-store.js';
import { evidenceStoreContract } from '../../../test/contracts/evidence-store-contract.js';
import type { EvidenceCapture } from '../../domain/index.js';

/**
 * In-memory fake of the S3 client at the SDK seam (the same pattern the
 * browser/network adapters use: a fake at the vendor boundary + a gated live
 * smoke). It implements `.send(command)` for the three commands the adapter
 * issues, honoring `IfNoneMatch: '*'` (write-once → 412 on collision) and a
 * NoSuchKey/NotFound-shaped 404 on a missing get/head. Bodies are stored as raw
 * bytes so HeadObject can report a real ContentLength.
 */
interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new Error(`fake S3: unsupported Body type ${typeof body}`);
}

/**
 * A 404-shaped error. `withName=false` (the DEFAULT) mirrors the harder, realistic
 * case some S3-compatible stores (R2/MinIO) produce: ONLY `$metadata.httpStatusCode`,
 * no canonical `.name` — so the adapter's status-based fallback is what's exercised.
 * `withName=true` covers AWS's modeled NoSuchKey/NotFound exceptions.
 */
function notFoundError(name: 'NoSuchKey' | 'NotFound', withName = false): Error {
  const err = new Error(`${name}: the specified key does not exist`);
  if (withName) err.name = name;
  (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
  return err;
}

/**
 * A 412 precondition failure. Real `@aws-sdk/client-s3` has NO modeled
 * `PreconditionFailed` exception — an `IfNoneMatch` collision surfaces as a generic
 * service exception with `$metadata.httpStatusCode: 412` and NO canonical `.name`.
 * So the fake omits `.name` by default, forcing the adapter's status-412 branch
 * (the path real S3 actually hits).
 */
function preconditionFailedError(withName = false): Error {
  const err = new Error('At least one of the preconditions failed');
  if (withName) err.name = 'PreconditionFailed';
  (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 412 };
  return err;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();
  /** When true, errors carry a canonical `.name` (AWS-modeled); default = status-only (R2/MinIO). */
  constructor(private readonly namedErrors = false) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) return this.put(command.input);
    if (command instanceof GetObjectCommand) return this.getObject(command.input);
    if (command instanceof HeadObjectCommand) return this.head(command.input);
    throw new Error(`fake S3: unsupported command ${(command as object)?.constructor?.name}`);
  }

  private put(input: PutObjectCommand['input']): Record<string, never> {
    const key = input.Key as string;
    // Write-once: a conditional put against an existing key fails with 412.
    if (input.IfNoneMatch === '*' && this.objects.has(key)) {
      throw preconditionFailedError(this.namedErrors);
    }
    this.objects.set(key, { body: toBytes(input.Body), contentType: input.ContentType });
    return {};
  }

  private getObject(input: GetObjectCommand['input']): {
    Body: {
      transformToString: () => Promise<string>;
      transformToByteArray: () => Promise<Uint8Array>;
    };
    ContentLength: number;
  } {
    const obj = this.objects.get(input.Key as string);
    if (!obj) throw notFoundError('NoSuchKey', this.namedErrors);
    // The real SDK Body exposes BOTH transforms; the adapter uses transformToString
    // for the meta JSON and transformToByteArray for raw artifact bytes (getArtifact).
    return {
      Body: {
        transformToString: async () => new TextDecoder().decode(obj.body),
        transformToByteArray: async () => obj.body,
      },
      ContentLength: obj.body.byteLength,
    };
  }

  private head(input: HeadObjectCommand['input']): { ContentLength: number } {
    const obj = this.objects.get(input.Key as string);
    if (!obj) throw notFoundError('NotFound', this.namedErrors);
    return { ContentLength: obj.body.byteLength };
  }
}

function makeStore(): { store: S3EvidenceStore; client: FakeS3Client } {
  const client = new FakeS3Client();
  // The adapter only uses `.send()`; the cast keeps it to the real seam shape.
  const store = new S3EvidenceStore({ client: client as unknown as S3Client, bucket: 'b' });
  return { store, client };
}

const TERMS = 'Disney+ ist im Tarif enthalten.';
function makeCapture(overrides: Partial<EvidenceCapture> = {}): EvidenceCapture {
  return {
    sourceUrl: 'https://www.telekom.de/magenta-tv',
    screenshot: new Uint8Array([137, 80, 78, 71]),
    html: '<html><body>Disney+ inklusive</body></html>',
    termsText: TERMS,
    capturedAt: '2026-06-19T00:00:00.000Z',
    contentHash: createHash('sha256').update(TERMS, 'utf8').digest('hex'),
    ...overrides,
  };
}

// The S3 adapter must pass the SAME shared contract as local-fs / the fake
// (LSP), including the three hollow-capture rejections.
evidenceStoreContract('S3EvidenceStore', () => makeStore().store);

describe('S3EvidenceStore write-once + no-partial-bundle + integrity', () => {
  let store: S3EvidenceStore;
  let client: FakeS3Client;

  beforeEach(() => {
    ({ store, client } = makeStore());
  });

  it('hollow-capture guard fires BEFORE any S3 write', async () => {
    await expect(store.save(makeCapture({ html: '' }))).rejects.toThrow();
    // No body or meta object was written — the guard ran before the first put.
    expect(client.objects.size).toBe(0);
  });

  it('writes bodies first then meta last, with correct ContentTypes', async () => {
    const ev = await store.save(makeCapture());
    expect(client.objects.get(ev.screenshot_ref)?.contentType).toBe('image/png');
    expect(client.objects.get(ev.html_ref)?.contentType).toBe('text/html; charset=utf-8');
    expect(client.objects.get(ev.terms_ref)?.contentType).toBe('text/plain; charset=utf-8');
    expect(client.objects.get(`${ev.id}/evidence.json`)?.contentType).toBe('application/json');
  });

  it('is write-once: a conditional put on an existing meta key throws (IfNoneMatch)', async () => {
    const ev = await store.save(makeCapture());
    // Re-publish the SAME id's meta object — simulates a uuid collision. The
    // conditional put must refuse to clobber the prior evidence. The default fake
    // returns a STATUS-ONLY 412 (no canonical name), exactly as real S3 does, so
    // this exercises the adapter's httpStatus-412 branch (not a name match).
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: 'b',
          Key: `${ev.id}/evidence.json`,
          Body: '{}',
          IfNoneMatch: '*',
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
  });

  it('no partial bundle: get returns null when meta is absent even if bodies exist', async () => {
    const ev = await store.save(makeCapture());
    // Drop ONLY the meta object — bodies remain (a crash after bodies, before meta).
    client.objects.delete(`${ev.id}/evidence.json`);
    expect(await store.get(ev.id)).toBeNull();
  });

  it('get returns null (not throw) on a missing bundle (NoSuchKey)', async () => {
    expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('verifyBundleComplete throws when a referenced body object is missing', async () => {
    const ev = await store.save(makeCapture());
    client.objects.delete(ev.html_ref);
    await expect(store.get(ev.id)).rejects.toBeInstanceOf(S3EvidenceStoreError);
  });

  it('verifyBundleComplete throws when a referenced body object is zero-length', async () => {
    const ev = await store.save(makeCapture());
    client.objects.set(ev.terms_ref, { body: new Uint8Array(), contentType: 'text/plain' });
    await expect(store.get(ev.id)).rejects.toBeInstanceOf(S3EvidenceStoreError);
  });

  it('rejects corrupt stored meta JSON on read (boundary discipline)', async () => {
    const ev = await store.save(makeCapture());
    client.objects.set(`${ev.id}/evidence.json`, {
      body: new TextEncoder().encode('not json'),
      contentType: 'application/json',
    });
    await expect(store.get(ev.id)).rejects.toBeInstanceOf(S3EvidenceStoreError);
  });
});

// Both error-shape variants must work: status-only (R2/MinIO — the default fake,
// covered above) AND AWS-modeled canonical names (NoSuchKey/NotFound). This proves
// the adapter's isNotFound handles both branches.
describe('S3EvidenceStore — AWS-modeled (named) error shapes', () => {
  it('treats a NAMED NoSuchKey on the meta object as a missing bundle (get → null)', async () => {
    const client = new FakeS3Client(/* namedErrors */ true);
    const store = new S3EvidenceStore({ client: client as unknown as S3Client, bucket: 'b' });
    expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('write-once still fires with a NAMED PreconditionFailed', async () => {
    const client = new FakeS3Client(true);
    const store = new S3EvidenceStore({ client: client as unknown as S3Client, bucket: 'b' });
    const ev = await store.save(makeCapture());
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: 'b',
          Key: `${ev.id}/evidence.json`,
          Body: '{}',
          IfNoneMatch: '*',
        }),
      ),
    ).rejects.toMatchObject({ name: 'PreconditionFailed' });
  });
});
