import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withRetry, withAbortableTimeout, TimeoutError } from '../shared/retry.js';
import { classifyPage } from './page-classifier.js';

/**
 * Byte caps so a runaway/hostile Firecrawl response can't OOM the worker. Mirrors
 * the Playwright adapter's bounds. The response body (markdown + HTML + a possibly
 * inlined screenshot data-URI) and a separately-downloaded screenshot are each
 * read with an early-abort stream cap (see readBoundedBytes) — a body that lies
 * about or omits Content-Length is aborted mid-stream once it exceeds the cap, so
 * it never fully buffers. Over the cap → an `error` outcome.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB (body carries text + html + maybe screenshot)
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB decoded screenshot

/**
 * Firecrawl fetcher — an alternative to Playwright (off by default; enabled via
 * `FETCHER=firecrawl`). Substitutable behind the `Fetcher` port (LSP). Uses the
 * Firecrawl HTTP API to return markdown + HTML + a screenshot.
 *
 * Implemented against the documented `/v1/scrape` shape; no Firecrawl SDK
 * dependency so the adapter stays swappable. Confirm the exact response shape
 * against the current API at integration time.
 */
export class FirecrawlFetcher implements Fetcher {
  constructor(
    private readonly apiKey: string,
    private readonly defaultTimeoutMs: number,
    private readonly baseUrl = 'https://api.firecrawl.dev',
  ) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const empty = emptyResult(url);
    try {
      const res = await withRetry(
        () =>
          withAbortableTimeout(
            (signal) =>
              fetch(`${this.baseUrl}/v1/scrape`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  url,
                  formats: ['markdown', 'html', 'screenshot'],
                }),
                signal,
              }),
            timeoutMs,
          ),
        // Only retry transient failures — a malformed-body 400 or a programming
        // error thrown before the response should not burn retries + budget.
        { retries: 2, baseDelayMs: 500, isRetryable: isTransientFetchError },
      );

      if (!res.ok) {
        const outcome = res.status === 401 || res.status === 403 ? 'blocked' : 'error';
        return { ...empty, outcome, error: `Firecrawl HTTP ${res.status}` };
      }

      // Reject an over-cap body. The declared Content-Length fails fast; for an
      // absent/lying length we read the stream with an early-abort byte cap so a
      // hostile multi-GB body never fully buffers (a true bound, not a post-hoc check).
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return {
          ...empty,
          outcome: 'error',
          error: `Firecrawl response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        };
      }
      const raw = await readBoundedText(res, MAX_RESPONSE_BYTES);
      if (raw === null) {
        return {
          ...empty,
          outcome: 'error',
          error: `Firecrawl response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        };
      }
      const body = JSON.parse(raw) as FirecrawlResponse;
      const data = body.data ?? {};
      const text = data.markdown ?? '';
      const html = data.html ?? '';

      const outcome = classifyPage({ httpStatus: 200, text, hasPasswordField: false });
      if (outcome !== 'ok') return { ...empty, outcome, finalUrl: data.url ?? url };

      // Evidence is REQUIRED before any candidate (a candidate is pinned to a
      // screenshot+html+terms bundle, and EvidenceStore.save rejects empty bytes).
      // So a missing/oversized/unreachable screenshot makes this an `error` fetch —
      // NOT an `ok` page with empty bytes that would later throw deep in save().
      const screenshot = await safeDownloadScreenshot(data.screenshot, timeoutMs);
      if (screenshot === null) {
        return {
          ...empty,
          outcome: 'error',
          finalUrl: data.url ?? url,
          error: 'Firecrawl returned no usable screenshot (missing/oversized); evidence required',
        };
      }

      return { outcome: 'ok', url, finalUrl: data.url ?? url, text, html, screenshot };
    } catch (err) {
      return {
        ...empty,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

interface FirecrawlResponse {
  data?: {
    markdown?: string;
    html?: string;
    /** Either a URL to the screenshot or a data URI, depending on API version. */
    screenshot?: string;
    url?: string;
  };
}

/**
 * Retry only transient network/timeout failures (TimeoutError, abort, or the
 * usual transient socket errors). A non-transient error — e.g. a thrown TypeError
 * from a bad body — is not worth retrying. HTTP-status non-retryables are handled
 * separately by the `res.ok` check, which returns rather than throws.
 */
function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
  }
  return false;
}

/**
 * Download the screenshot, returning `null` on any failure (missing ref / oversized
 * / unreachable). `null` (not empty bytes) so the caller can treat "no usable
 * screenshot" as an `error` fetch — a candidate must never be pinned to empty
 * evidence (the evidence-required invariant; save() rejects empty bytes).
 */
async function safeDownloadScreenshot(
  ref: string | undefined,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  if (!ref) return null;
  try {
    return await downloadBytes(ref, timeoutMs);
  } catch {
    return null;
  }
}

async function downloadBytes(ref: string, timeoutMs: number): Promise<Uint8Array> {
  if (ref.startsWith('data:')) {
    const base64 = ref.slice(ref.indexOf(',') + 1);
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(`screenshot data-URI exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
    }
    return bytes;
  }
  const res = await withAbortableTimeout((signal) => fetch(ref, { signal }), timeoutMs);
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_SCREENSHOT_BYTES) {
    throw new Error(`screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
  }
  const bytes = await readBoundedBytes(res, MAX_SCREENSHOT_BYTES);
  if (bytes === null) throw new Error(`screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
  return bytes;
}

/**
 * Read a response body to text with an early-abort byte cap: accumulates stream
 * chunks and bails (cancelling the stream) the moment the running total exceeds
 * `maxBytes`, so a hostile/absent-Content-Length body never fully buffers. Returns
 * null when over the cap. Falls back to a bounded `text()` if the body isn't a
 * stream (e.g. a test double).
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(res, maxBytes);
  return bytes === null ? null : new TextDecoder('utf-8').decode(bytes);
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // No stream (e.g. a mocked Response in tests): fall back to a buffered read,
    // then enforce the cap. Real runtime always has a stream.
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

function emptyResult(url: string): FetchResult {
  return { outcome: 'error', url, finalUrl: url, text: '', html: '', screenshot: new Uint8Array() };
}
