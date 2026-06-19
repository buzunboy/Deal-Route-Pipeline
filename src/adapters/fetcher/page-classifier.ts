import type { FetchOutcome } from '../../application/ports/index.js';

/**
 * Heuristic classification of a fetched page into a fetch outcome. Pure and
 * unit-tested so the (untestable) browser adapter stays thin. Login walls,
 * captchas, and anti-bot blocks are detected here and routed to manual capture —
 * we never automate logins (public-only v1).
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

const CAPTCHA_SIGNALS = ['captcha', 'recaptcha', 'hcaptcha', 'are you a robot', 'sind sie ein roboter'];

const BLOCK_SIGNALS = [
  'access denied',
  'request blocked',
  'you have been blocked',
  'cloudflare',
  'pardon our interruption',
  'zugriff verweigert',
];

export interface ClassifyInput {
  httpStatus: number;
  text: string;
  /** True when the page has a login form (password input present). */
  hasPasswordField: boolean;
}

export function classifyPage(input: ClassifyInput): FetchOutcome {
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    // Distinguish a true block from a login wall where we can.
    if (containsAny(input.text, CAPTCHA_SIGNALS)) return 'captcha';
    if (input.hasPasswordField || containsAny(input.text, LOGIN_SIGNALS)) return 'login_required';
    return 'blocked';
  }
  if (input.httpStatus === 429 || input.httpStatus >= 500) return 'error';

  const lower = input.text.toLowerCase();
  if (containsAny(lower, CAPTCHA_SIGNALS)) return 'captcha';
  if (containsAny(lower, BLOCK_SIGNALS)) return 'blocked';
  // A password field on an otherwise-OK page = a login-gated offer.
  if (input.hasPasswordField && isThinPage(input.text)) return 'login_required';
  return 'ok';
}

function containsAny(haystackLower: string, needles: string[]): boolean {
  return needles.some((n) => haystackLower.includes(n));
}

/** A page that is mostly a login form has very little content text. */
function isThinPage(text: string): boolean {
  return text.trim().length < 400;
}
