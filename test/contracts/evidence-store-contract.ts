import { describe, it, expect } from 'vitest';
import type { EvidenceStore } from '../../src/application/ports/index.js';
import type { EvidenceCapture } from '../../src/domain/index.js';

/**
 * Shared contract suite for the EvidenceStore port. Every adapter (local-fs, s3,
 * the in-memory fake) must pass this, so any implementation is substitutable
 * behind the port (LSP, `testing.md`: adapter contract tests).
 */
export function evidenceStoreContract(
  name: string,
  makeStore: () => EvidenceStore | Promise<EvidenceStore>,
): void {
  describe(`EvidenceStore contract: ${name}`, () => {
    const capture: EvidenceCapture = {
      sourceUrl: 'https://www.telekom.de/magenta-tv',
      screenshot: new Uint8Array([137, 80, 78, 71]),
      html: '<html><body>Disney+ inklusive</body></html>',
      termsText: 'Disney+ ist im Tarif enthalten.',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'abc123',
    };

    it('save returns an Evidence with an id and resolved refs', async () => {
      const store = await makeStore();
      const ev = await store.save(capture);
      expect(ev.id).toBeTruthy();
      expect(ev.source_url).toBe(capture.sourceUrl);
      expect(ev.screenshot_ref).toBeTruthy();
      expect(ev.html_ref).toBeTruthy();
      expect(ev.terms_ref).toBeTruthy();
      expect(ev.content_hash).toBe('abc123');
    });

    it('get returns a previously saved bundle', async () => {
      const store = await makeStore();
      const saved = await store.save(capture);
      const fetched = await store.get(saved.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(saved.id);
      expect(fetched!.captured_at).toBe(capture.capturedAt);
    });

    it('get returns null for an unknown id', async () => {
      const store = await makeStore();
      expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('assigns distinct ids to separate saves (write-once bundles)', async () => {
      const store = await makeStore();
      const a = await store.save(capture);
      const b = await store.save(capture);
      expect(a.id).not.toBe(b.id);
    });

    // Trust invariant: evidence is required before any candidate. A hollow capture
    // (empty screenshot/html/terms bytes) is NOT evidence — every adapter must
    // reject it at save() time rather than persist a bundle that get() can't load.
    it('save rejects a hollow capture with an empty screenshot', async () => {
      const store = await makeStore();
      await expect(store.save({ ...capture, screenshot: new Uint8Array() })).rejects.toThrow();
    });

    it('save rejects a hollow capture with empty HTML', async () => {
      const store = await makeStore();
      await expect(store.save({ ...capture, html: '' })).rejects.toThrow();
    });

    it('save rejects a hollow capture with empty terms text', async () => {
      const store = await makeStore();
      await expect(store.save({ ...capture, termsText: '' })).rejects.toThrow();
    });

    // getArtifact (the gated reviewer evidence-fetch read path): every adapter returns
    // the saved bytes + the domain content-type for each kind, and null when absent.
    it('getArtifact returns the saved screenshot bytes + image/png', async () => {
      const store = await makeStore();
      const saved = await store.save(capture);
      const art = await store.getArtifact(saved.id, 'screenshot');
      expect(art).not.toBeNull();
      expect(art!.contentType).toBe('image/png');
      // Bytes round-trip exactly (the screenshot is binary — must not be mangled).
      expect(Array.from(art!.bytes)).toEqual(Array.from(capture.screenshot));
    });

    it('getArtifact returns the saved HTML text + text/html', async () => {
      const store = await makeStore();
      const saved = await store.save(capture);
      const art = await store.getArtifact(saved.id, 'html');
      expect(art).not.toBeNull();
      expect(art!.contentType).toBe('text/html; charset=utf-8');
      expect(new TextDecoder().decode(art!.bytes)).toBe(capture.html);
    });

    it('getArtifact returns the saved terms text + text/plain', async () => {
      const store = await makeStore();
      const saved = await store.save(capture);
      const art = await store.getArtifact(saved.id, 'terms');
      expect(art).not.toBeNull();
      expect(art!.contentType).toBe('text/plain; charset=utf-8');
      expect(new TextDecoder().decode(art!.bytes)).toBe(capture.termsText);
    });

    it('getArtifact returns null for an unknown id', async () => {
      const store = await makeStore();
      expect(
        await store.getArtifact('00000000-0000-0000-0000-000000000000', 'screenshot'),
      ).toBeNull();
    });
  });
}
