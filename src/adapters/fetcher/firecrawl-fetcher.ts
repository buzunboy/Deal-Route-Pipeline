import { z } from 'zod';
import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withRetry, withAbortableTimeout, TimeoutError } from '../shared/retry.js';
import { resolveScreenshotBytes } from '../shared/screenshot-download.js';
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

/**
 * Firecrawl fetcher — an alternative to Playwright (off by default; enabled via
 * `FETCHER=firecrawl`). Substitutable behind the `Fetcher` port (LSP). Uses the
 * Firecrawl HTTP API to return markdown + HTML + a screenshot.
 *
 * Implemented against the Firecrawl `/v2/scrape` shape (`data.{markdown, html,
 * screenshot, metadata}`) — verified live 2026-06-20; no Firecrawl SDK dependency
 * so the adapter stays swappable. v2 also returns `metadata.creditsUsed` (real
 * vendor cost), surfaced via the optional `creditsUsed` field on the result for
 * cost transparency (the use-case keeps its own € estimate; this is informational).
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
              fetch(`${this.baseUrl}/v2/scrape`, {
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
      // Boundary-validate the v2 response (never trust raw vendor JSON — same
      // discipline as the sibling FirecrawlSearchProvider). A shape we don't
      // recognise is an `error` outcome, not a silently-coerced empty page.
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return { ...empty, outcome: 'error', error: 'Firecrawl response was not valid JSON' };
      }
      const parsed = FirecrawlScrapeResponseSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return {
          ...empty,
          outcome: 'error',
          error: `Firecrawl response failed validation: ${parsed.error.message}`,
        };
      }
      const data = parsed.data.data ?? {};
      const text = data.markdown ?? '';
      const html = data.html ?? '';

      // Firecrawl returns no HTTP status for the target page, so the password-field
      // heuristic can't run here; classification keys off body signals. A login-wall /
      // soft-block body now classifies `ok` with a `signal` (best-effort-read); only
      // captcha / soft-404 stay non-`ok`.
      const { outcome, signal } = classifyPage({ httpStatus: 200, text, hasPasswordField: false });
      if (outcome !== 'ok') return { ...empty, outcome, finalUrl: data.url ?? url };

      // Evidence is REQUIRED before any candidate (a candidate is pinned to a
      // screenshot+html+terms bundle, and EvidenceStore.save rejects empty bytes).
      // So a missing/oversized/unreachable screenshot makes this an `error` fetch —
      // NOT an `ok` page with empty bytes that would later throw deep in save().
      const screenshot = await resolveScreenshotBytes(data.screenshot, timeoutMs);
      if (screenshot === null) {
        return {
          ...empty,
          outcome: 'error',
          finalUrl: data.url ?? url,
          error: 'Firecrawl returned no usable screenshot (missing/oversized); evidence required',
        };
      }

      return {
        outcome: 'ok',
        url,
        finalUrl: data.url ?? url,
        text,
        html,
        screenshot,
        ...(signal ? { fetchSignal: signal } : {}),
      };
    } catch (err) {
      return {
        ...empty,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** v2 `/scrape` response — only the fields we consume; unknown fields ignored. */
const FirecrawlScrapeResponseSchema = z.object({
  data: z
    .object({
      markdown: z.string().optional(),
      html: z.string().optional(),
      /** Either a URL to the screenshot or a data URI, depending on API version. */
      screenshot: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

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
