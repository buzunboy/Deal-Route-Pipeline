import { withAbortableTimeout } from './retry.js';

/**
 * Cap on a downloaded/decoded screenshot — a hostile or runaway image must not OOM
 * the worker. Mirrors the Firecrawl fetcher's bound (kept in sync deliberately).
 */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Resolve a screenshot reference (an `http(s)` URL or a `data:` URI) to bounded
 * bytes, returning `null` on ANY failure (missing ref, oversized, unreachable).
 *
 * `null` — not empty bytes — is the contract: the evidence-required invariant means
 * a candidate must never be pinned to an empty screenshot (`assertCaptureComplete`
 * rejects empty bytes at `save()`), so a caller treats `null` as "no usable
 * screenshot" → an `error`/skip outcome rather than persisting hollow evidence.
 *
 * Shared by the Firecrawl fetcher (`/v2/scrape` screenshot) and the search-agent
 * inline-scrape path (search-time screenshot), so both resolve + bound it identically.
 */
export async function resolveScreenshotBytes(
  ref: string | undefined,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  if (!ref) return null;
  try {
    return await downloadBounded(ref, timeoutMs);
  } catch {
    return null;
  }
}

async function downloadBounded(ref: string, timeoutMs: number): Promise<Uint8Array> {
  if (ref.startsWith('data:')) {
    const base64 = ref.slice(ref.indexOf(',') + 1);
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(`screenshot data-URI out of bounds (${bytes.byteLength} bytes)`);
    }
    return bytes;
  }
  const res = await withAbortableTimeout((signal) => fetch(ref, { signal }), timeoutMs);
  if (!res.ok) throw new Error(`screenshot fetch HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_SCREENSHOT_BYTES) {
    throw new Error(`screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
  }
  const bytes = await readBounded(res, MAX_SCREENSHOT_BYTES);
  if (bytes === null || bytes.byteLength === 0) {
    throw new Error('screenshot empty or over cap');
  }
  return bytes;
}

/** Read a response body to bytes with an early-abort cap (cancels the stream over cap). */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
