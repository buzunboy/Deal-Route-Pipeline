import type { FetchOutcome, FetchSignal } from '../../application/ports/index.js';

/**
 * Heuristic classification of a fetched page into a fetch outcome. Pure and
 * unit-tested so the (untestable) browser adapter stays thin.
 *
 * **Best-effort-read policy (2026-06-21):** when a usable body came back, a login
 * wall or a soft anti-bot page is classified `ok` with a `signal` (`login_wall` /
 * `soft_block`) so the extractor still runs (best-effort) and a human still reviews —
 * we no longer divert these to manual capture. The two exceptions, where the body is
 * NOT offer content, stay non-`ok`: a `captcha` challenge page (→ manual capture) and
 * soft-404 / maintenance / expired interstitials (→ `error`, the stale-content guard).
 * We still never automate logins (no credential system yet).
 */

const LOGIN_SIGNALS = [
  'log in',
  'login',
  'sign in',
  'anmelden',
  'einloggen',
  'passwort',
  'password',
  'mein konto',
];

const CAPTCHA_SIGNALS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  'are you a robot',
  'sind sie ein roboter',
];

const BLOCK_SIGNALS = [
  'access denied',
  'request blocked',
  'you have been blocked',
  'cloudflare',
  'pardon our interruption',
  'zugriff verweigert',
];

/**
 * Soft-404 / maintenance / expired-offer interstitials served with HTTP 200.
 * These must NOT classify as `ok` — extracting from a "page not found" or
 * "maintenance" body would capture wrong/empty evidence and let a stale or
 * hallucinated record reach review. Routed to `error` (a contained skip: no
 * evidence, no candidate).
 */
const NON_CONTENT_SIGNALS = [
  'seite nicht gefunden',
  'seite wurde nicht gefunden',
  'page not found',
  '404',
  'nicht mehr verfügbar',
  'angebot abgelaufen',
  'angebot ist abgelaufen',
  'offer expired',
  'no longer available',
  'wartungsarbeiten',
  'wartung',
  'maintenance',
  "we'll be back",
  'temporarily unavailable',
  'vorübergehend nicht verfügbar',
];

export interface ClassifyInput {
  httpStatus: number;
  text: string;
  /** True when the page has a login form (password input present). */
  hasPasswordField: boolean;
}

/**
 * The classifier verdict. `outcome` drives routing; `signal` (best-effort-read)
 * marks an `ok` page that looked like a login wall / soft block but yielded a body —
 * the caller carries the body and extracts anyway, tagging the result low-trust.
 */
export interface PageClassification {
  outcome: FetchOutcome;
  signal?: FetchSignal;
}

export function classifyPage(input: ClassifyInput): PageClassification {
  // Lowercase once — every signal list is lowercase and `containsAny` does no folding.
  // (Pre-2026-06-21 the 401/403 branch matched raw-cased text, so an uppercase
  // "CAPTCHA"/"Login" slipped through; that miss is now trust-relevant because captcha
  // must still divert to manual capture, so the branch uses `lower` too.)
  const lower = input.text.toLowerCase();

  if (input.httpStatus === 401 || input.httpStatus === 403) {
    // A captcha challenge has no offer content → still route to manual capture.
    if (containsAny(lower, CAPTCHA_SIGNALS)) return { outcome: 'captcha' };
    // Best-effort-read: a 401/403 login wall or block still gave us a body — read it
    // anyway (best-effort), flagged low-trust via the signal. Login takes precedence
    // over a generic block when we can tell (password field / login copy).
    if (input.hasPasswordField || containsAny(lower, LOGIN_SIGNALS)) {
      return { outcome: 'ok', signal: 'login_wall' };
    }
    return { outcome: 'ok', signal: 'soft_block' };
  }
  // 429 / 5xx are genuine non-fetches (no trustworthy body) → contained failure.
  if (input.httpStatus === 429 || input.httpStatus >= 500) return { outcome: 'error' };

  // Captcha challenge page: body is the challenge, not an offer → manual capture.
  if (containsAny(lower, CAPTCHA_SIGNALS)) return { outcome: 'captcha' };
  // Soft anti-bot interstitial (Cloudflare etc.) at HTTP 200 — best-effort read it,
  // flagged low-trust; the extractor + human reviewer judge whether it's usable.
  if (containsAny(lower, BLOCK_SIGNALS)) return { outcome: 'ok', signal: 'soft_block' };
  // A password field on an otherwise-OK thin page = a login-gated offer — read best-effort.
  if (input.hasPasswordField && isThinPage(input.text)) {
    return { outcome: 'ok', signal: 'login_wall' };
  }
  // Soft-404 / maintenance / expired interstitial at HTTP 200. KEPT as `error` (the
  // stale-content guard — NOT a politeness rule): extracting a "page not found" /
  // "offer expired" body would manufacture a stale or wrong deal. Guarded by a thin
  // body so a real offer page that merely mentions "maintenance"/"404" in prose
  // isn't misclassified — these interstitials carry little other content.
  if (isThinPage(input.text) && containsAny(lower, NON_CONTENT_SIGNALS))
    return { outcome: 'error' };
  return { outcome: 'ok' };
}

function containsAny(haystackLower: string, needles: string[]): boolean {
  return needles.some((n) => haystackLower.includes(n));
}

/** A page that is mostly a login form has very little content text. */
function isThinPage(text: string): boolean {
  return text.trim().length < 400;
}
