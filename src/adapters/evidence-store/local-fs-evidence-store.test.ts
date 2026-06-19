import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalFsEvidenceStore, EvidenceStoreError } from './local-fs-evidence-store.js';
import { evidenceStoreContract } from '../../../test/contracts/evidence-store-contract.js';
import type { EvidenceCapture } from '../../domain/index.js';

/**
 * Run the shared EvidenceStore contract against the local-fs adapter, proving it
 * is substitutable behind the port (LSP / `testing.md`: adapter contract tests).
 * A fresh temp dir per store keeps the write-once bundles isolated.
 */
evidenceStoreContract(
  'LocalFsEvidenceStore',
  () => new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-contract-'))),
);

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

describe('LocalFsEvidenceStore atomic write + integrity', () => {
  let baseDir: string;
  let store: LocalFsEvidenceStore;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'ev-atomic-'));
    store = new LocalFsEvidenceStore(baseDir);
  });

  it('leaves no staging dir behind after a successful save (atomic publish)', async () => {
    const ev = await store.save(makeCapture());
    const entries = await readdir(baseDir);
    // Only the final bundle dir should remain — no `.tmp-*` staging dir leaked.
    expect(entries).toEqual([ev.id]);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
  });

  it('a get sees a fully-formed bundle (the rename publishes all files at once)', async () => {
    const ev = await store.save(makeCapture());
    const files = await readdir(join(baseDir, ev.id));
    expect(files.sort()).toEqual(
      ['evidence.json', 'page.html', 'screenshot.png', 'terms.txt'].sort(),
    );
  });

  it('rejects a bundle whose referenced body file is missing (partial restore)', async () => {
    const ev = await store.save(makeCapture());
    // Simulate a partial restore that resurrected the metadata without its body.
    await rm(join(baseDir, ev.id, 'page.html'));
    await expect(store.get(ev.id)).rejects.toBeInstanceOf(EvidenceStoreError);
  });

  it('rejects a bundle whose referenced body file is empty (truncation / bit-rot)', async () => {
    const ev = await store.save(makeCapture());
    await writeFile(join(baseDir, ev.id, 'terms.txt'), '', 'utf8');
    await expect(store.get(ev.id)).rejects.toBeInstanceOf(EvidenceStoreError);
  });

  it('still returns null for an unknown id (and ignores stray staging dirs)', async () => {
    expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
