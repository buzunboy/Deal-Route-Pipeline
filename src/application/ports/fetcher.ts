/**
 * Fetcher port — retrieves a public page as text + screenshot + HTML.
 *
 * Concrete adapters (Playwright default, Firecrawl) live behind this port and are
 * injected from the composition root. Login-gated/blocked pages are signalled via
 * a typed result the caller routes to manual capture — the fetcher never logs in
 * (public-only v1).
 */

/**
 * `blocked` = anti-bot defences stopped us (route to manual capture).
 * `robots_disallowed` = robots.txt told us not to fetch this path — we CHOSE not
 * to, so it is skipped silently, never treated as a failure or manual-capture task.
 */
export type FetchOutcome =
  | 'ok'
  | 'login_required'
  | 'captcha'
  | 'blocked'
  | 'robots_disallowed'
  | 'error';

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
}

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export interface Fetcher {
  /** Fetch a single public URL. Timeout-bounded; resolves (never throws) on a
   *  reachable failure, returning an `error`/`blocked` outcome for the caller. */
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}
