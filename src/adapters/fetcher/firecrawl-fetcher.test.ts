import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirecrawlFetcher } from './firecrawl-fetcher.js';

const TEXT = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten und kostet 9,99 € pro Monat.';

/**
 * A Response-like with no `body` stream, so the adapter's bounded reader takes its
 * `arrayBuffer()` fallback (a real runtime Response always has a stream; the
 * fallback covers test doubles + caps the buffered read). `contentLength` sets the
 * declared header used by the fast-path cap.
 */
function jsonResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; contentLength?: number } = {},
) {
  const raw = JSON.stringify(body);
  const bytes = new TextEncoder().encode(raw);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: null,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-length' ? (opts.contentLength?.toString() ?? null) : null,
    },
    arrayBuffer: async () => bytes.buffer,
    text: async () => raw,
    json: async () => body,
  } as unknown as Response;
}

/** A binary Response-like (for screenshot downloads) with a settable byte length. */
function bytesResponse(byteLength: number, contentLength?: number) {
  return {
    ok: true,
    status: 200,
    body: null,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-length' ? (contentLength?.toString() ?? null) : null,
    },
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FirecrawlFetcher size caps', () => {
  it('maps a normal response (with a small screenshot) into an ok FetchResult', async () => {
    const smallBase64 = Buffer.from([137, 80, 78, 71]).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: {
            markdown: TEXT,
            html: `<html>${TEXT}</html>`,
            url: 'https://t.de/x',
            screenshot: `data:image/png;base64,${smallBase64}`,
          },
        }),
      ),
    );
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('ok');
    expect(r.text).toBe(TEXT);
    expect(r.screenshot.byteLength).toBe(4);
  });

  it('rejects a body whose declared Content-Length exceeds the cap (fail fast, no read)', async () => {
    const arrayBufferMock = vi.fn(async () => new ArrayBuffer(0));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: null,
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'content-length' ? String(100 * 1024 * 1024) : null,
            },
            arrayBuffer: arrayBufferMock,
            text: async () => '{}',
          }) as unknown as Response,
      ),
    );
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/exceeds/);
    expect(arrayBufferMock).not.toHaveBeenCalled(); // never read the body
  });

  it('rejects a body that lies about Content-Length (bounded read aborts)', async () => {
    const huge = 'x'.repeat(17 * 1024 * 1024); // > 16 MB, Content-Length absent
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: null,
            headers: { get: () => null },
            arrayBuffer: async () => new TextEncoder().encode(huge).buffer,
            text: async () => huge,
          }) as unknown as Response,
      ),
    );
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/exceeds/);
  });

  it('an oversized URL-ref screenshot makes the fetch an error (evidence required, not ok-with-empty)', async () => {
    // Page text scraped fine, but the screenshot download exceeds the 8 MB cap.
    // Evidence is required, so we must NOT return ok with empty bytes (that would
    // throw deep in EvidenceStore.save) — we return error and skip the page.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/shot.png')) return bytesResponse(0, 20 * 1024 * 1024); // declared over cap
      return jsonResponse({
        data: {
          markdown: TEXT,
          html: `<html>${TEXT}</html>`,
          screenshot: 'https://cdn.t.de/shot.png',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/screenshot/i);
  });

  it('a missing screenshot also makes the fetch an error (no candidate without evidence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: { markdown: TEXT, html: `<html>${TEXT}</html>` } })),
    );
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('error');
  });

  it('maps a 401 to blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, { ok: false, status: 401 })),
    );
    const f = new FirecrawlFetcher('key', 5000);
    const r = await f.fetch('https://t.de/x');
    expect(r.outcome).toBe('blocked');
  });
});
