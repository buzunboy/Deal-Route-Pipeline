/**
 * Fetcher port — retrieves a page as text + screenshot + HTML.
 *
 * Concrete adapters (Playwright default, Firecrawl) live behind this port and are
 * injected from the composition root. Under the **best-effort-read policy**
 * (2026-06-21) the pipeline reads ANY page it can fetch a body from — including
 * login-walled / soft-anti-bot pages (these come back `ok` with `fetchSignal` set
 * so the extractor still runs and a human still reviews). Two cases are NOT read:
 * a `captcha` challenge (no offer content in the body → manual capture) and a
 * `robots_disallowed` skip (only when `RESPECT_ROBOTS_TXT=true`). The fetcher still
 * never logs in — no credential system exists yet (deferred).
 */

/**
 * `login_required`/`blocked` = a login-wall or soft anti-bot page WAS fetched; under
 * best-effort-read these are remapped to `ok` (body carried) with `fetchSignal` set,
 * not routed away. They remain as enum values for the `RESPECT_ROBOTS_TXT`/captcha
 * edges and back-compat. `captcha` = a challenge page with no readable offer content
 * → manual capture. `robots_disallowed` = robots.txt told us not to fetch (produced
 * only when robots is explicitly enabled); skipped silently, never a failure.
 */
export type FetchOutcome =
  | 'ok'
  | 'login_required'
  | 'captcha'
  | 'blocked'
  | 'robots_disallowed'
  | 'error';

/** Why an otherwise-`ok` page is lower-trust: it looked like a wall but a body came back. */
export type FetchSignal = 'login_wall' | 'soft_block';

export interface FetchResult {
  outcome: FetchOutcome;
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  /** Cleaned page text (markdown). Empty unless outcome === 'ok'. */
  text: string;
  /** Raw HTML. Empty unless outcome === 'ok'. */
  html: string;
  /** Full-page screenshot bytes (PNG). Empty unless outcome === 'ok'. */
  screenshot: Uint8Array;
  /** Populated when outcome === 'error'. */
  error?: string;
  /**
   * Best-effort-read marker: set on an `ok` result that the page-classifier flagged
   * as a login wall (`login_wall`) or soft anti-bot block (`soft_block`) but for which
   * a usable body was still captured. The body is extracted anyway (best-effort), and
   * this lets the lane log the degraded read. Absent on a clean `ok` page.
   */
  fetchSignal?: FetchSignal;
}

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export interface Fetcher {
  /** Fetch a single public URL. Timeout-bounded; resolves (never throws) on a
   *  reachable failure, returning an `error`/`blocked` outcome for the caller. */
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;

  /**
   * Apply the access gate to `url` WITHOUT fetching its body: the per-domain
   * rate-limit always, plus robots.txt IFF `RESPECT_ROBOTS_TXT=true`. Returns
   * `'robots_disallowed'` only when robots is enabled AND forbids the path, else
   * `'ok'`. Lets a caller that already has page content from elsewhere (e.g. a search
   * provider's inline scrape) reuse our guardrails before using that content — so the
   * SAME access policy applies whether or not WE did the fetch. Under the default
   * best-effort-read policy (robots off) this only throttles. Optional: only the
   * politeness layer implements it; a caller MUST treat an absent method as "no gate
   * available" and fall back to a real `fetch()` (which always gates).
   */
  checkAccess?(url: string): Promise<'ok' | 'robots_disallowed'>;
}
