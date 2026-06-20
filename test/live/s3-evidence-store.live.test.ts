import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from '../../src/adapters/evidence-store/s3-evidence-store.js';
import type { EvidenceCapture } from '../../src/domain/index.js';

/**
 * LIVE smoke for the S3/R2 EvidenceStore — round-trips a REAL bundle save→get
 * against a real bucket to confirm the write-once + bodies-then-meta + verify
 * path works against an actual object store (incl. R2/MinIO when S3_ENDPOINT is
 * set). NON-deterministic + needs credentials, so self-skips unless
 * RUN_LIVE_TESTS=1 AND S3_BUCKET are set. Scheduled / live-test label only.
 */
const enabled = process.env.RUN_LIVE_TESTS === '1' && Boolean(process.env.S3_BUCKET);
const suite = enabled ? describe : describe.skip;

suite('live S3EvidenceStore smoke', () => {
  it('round-trips a real bundle save -> get against a real bucket', async () => {
    const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
    const client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
    const store = new S3EvidenceStore({ client, bucket: process.env.S3_BUCKET as string });

    const terms = `live-smoke terms ${Date.now()}`;
    const capture: EvidenceCapture = {
      sourceUrl: 'https://www.telekom.de/magenta-tv',
      screenshot: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      html: '<html><body>live smoke</body></html>',
      termsText: terms,
      capturedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(terms, 'utf8').digest('hex'),
    };

    const saved = await store.save(capture);
    expect(saved.id).toBeTruthy();

    const fetched = await store.get(saved.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(saved.id);
    expect(fetched!.source_url).toBe(capture.sourceUrl);
    expect(fetched!.content_hash).toBe(capture.contentHash);

    // A never-saved id round-trips to null (not a throw).
    expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
