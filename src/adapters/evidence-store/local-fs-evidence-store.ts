import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EvidenceSchema, type Evidence, type EvidenceCapture } from '../../domain/index.js';
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
 */
const SCREENSHOT_FILE = 'screenshot.png';
const HTML_FILE = 'page.html';
const TERMS_FILE = 'terms.txt';
const META_FILE = 'evidence.json';

/**
 * Local-filesystem EvidenceStore — the dev default behind the {@link EvidenceStore}
 * port (S3/R2 is the production sibling). Each bundle gets its own directory
 * `<baseDir>/<id>/` holding the screenshot + HTML + terms text plus an
 * `evidence.json` metadata record that {@link get} reads back.
 *
 * Bundles are WRITE-ONCE (trust invariant: monitoring keeps old evidence rather
 * than overwriting it). A collision on the generated id — vanishingly unlikely —
 * fails loudly rather than silently clobbering prior evidence.
 */
export class LocalFsEvidenceStore implements EvidenceStore {
  constructor(private readonly baseDir: string) {}

  async save(capture: EvidenceCapture): Promise<Evidence> {
    const id = randomUUID();
    const dir = join(this.baseDir, id);

    // `recursive: false` makes a pre-existing id directory an error, enforcing
    // write-once. The base dir is created up-front (recursive) so first use works.
    await mkdir(this.baseDir, { recursive: true });
    try {
      await mkdir(dir, { recursive: false });
    } catch (err) {
      throw new EvidenceStoreError(
        `Evidence bundle ${id} already exists; refusing to overwrite (write-once).`,
        { cause: err },
      );
    }

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

    try {
      await Promise.all([
        writeFile(join(dir, SCREENSHOT_FILE), capture.screenshot),
        writeFile(join(dir, HTML_FILE), capture.html, 'utf8'),
        writeFile(join(dir, TERMS_FILE), capture.termsText, 'utf8'),
        writeFile(join(dir, META_FILE), JSON.stringify(validated, null, 2), 'utf8'),
      ]);
    } catch (err) {
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
    return parsed.data;
  }
}
