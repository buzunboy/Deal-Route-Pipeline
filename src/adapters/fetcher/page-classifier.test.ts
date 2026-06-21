import { describe, it, expect } from 'vitest';
import { classifyPage } from './page-classifier.js';

describe('classifyPage (best-effort-read policy)', () => {
  const okText = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten. '.repeat(20);

  it('classifies a normal content page as ok with no signal', () => {
    expect(classifyPage({ httpStatus: 200, text: okText, hasPasswordField: false })).toEqual({
      outcome: 'ok',
    });
  });

  it('best-effort: a 403 login wall classifies ok with a login_wall signal (body is read anyway)', () => {
    expect(
      classifyPage({ httpStatus: 403, text: 'Bitte anmelden', hasPasswordField: true }),
    ).toEqual({ outcome: 'ok', signal: 'login_wall' });
  });

  it('best-effort: a 403 with no login/captcha signal classifies ok with a soft_block signal', () => {
    expect(classifyPage({ httpStatus: 403, text: 'Forbidden', hasPasswordField: false })).toEqual({
      outcome: 'ok',
      signal: 'soft_block',
    });
  });

  it('captcha STAYS non-ok (no offer content in a challenge page → manual capture)', () => {
    expect(
      classifyPage({
        httpStatus: 200,
        text: 'Please complete the captcha',
        hasPasswordField: false,
      }),
    ).toEqual({ outcome: 'captcha' });
    // …including at 401/403.
    expect(
      classifyPage({
        httpStatus: 403,
        text: 'Are you a robot? recaptcha',
        hasPasswordField: false,
      }),
    ).toEqual({ outcome: 'captcha' });
  });

  it('captcha detection is case-insensitive at 401/403 (uppercase CAPTCHA must still divert)', () => {
    // Regression guard: the 401/403 branch once matched raw-cased text, so an uppercase
    // captcha slipped through to a best-effort read. Trust-relevant — captcha must divert.
    expect(
      classifyPage({ httpStatus: 403, text: 'Please solve the CAPTCHA', hasPasswordField: false }),
    ).toEqual({ outcome: 'captcha' });
  });

  it('best-effort: an anti-bot interstitial (Cloudflare) at 200 classifies ok with soft_block', () => {
    expect(
      classifyPage({
        httpStatus: 200,
        text: 'Access denied by Cloudflare',
        hasPasswordField: false,
      }),
    ).toEqual({ outcome: 'ok', signal: 'soft_block' });
  });

  it('best-effort: a thin login-form page at 200 classifies ok with login_wall', () => {
    expect(
      classifyPage({ httpStatus: 200, text: 'Login\nPasswort', hasPasswordField: true }),
    ).toEqual({ outcome: 'ok', signal: 'login_wall' });
  });

  it('does NOT flag a rich page with an incidental password field (clean ok, no signal)', () => {
    expect(classifyPage({ httpStatus: 200, text: okText, hasPasswordField: true })).toEqual({
      outcome: 'ok',
    });
  });

  it('classifies 429/5xx as error (genuine non-fetch, no trustworthy body)', () => {
    expect(classifyPage({ httpStatus: 429, text: '', hasPasswordField: false })).toEqual({
      outcome: 'error',
    });
    expect(classifyPage({ httpStatus: 503, text: '', hasPasswordField: false })).toEqual({
      outcome: 'error',
    });
  });

  it('KEEPS the stale-content guard: a 200-OK soft-404 / maintenance / expired interstitial is error', () => {
    // This is a trust-CORRECTNESS guard, not a politeness rule — best-effort-read does
    // NOT override it (extracting a "page not found"/"expired" body manufactures a stale deal).
    expect(
      classifyPage({ httpStatus: 200, text: 'Seite nicht gefunden', hasPasswordField: false }),
    ).toEqual({ outcome: 'error' });
    expect(
      classifyPage({
        httpStatus: 200,
        text: 'Wir führen Wartungsarbeiten durch',
        hasPasswordField: false,
      }),
    ).toEqual({ outcome: 'error' });
    expect(
      classifyPage({
        httpStatus: 200,
        text: 'Dieses Angebot ist abgelaufen.',
        hasPasswordField: false,
      }),
    ).toEqual({ outcome: 'error' });
  });

  it('does NOT misclassify a rich offer page that merely mentions "maintenance"/"404" in prose', () => {
    // Guarded by thinness: a real content page with an incidental keyword stays a clean ok.
    const rich = okText + ' Wartung der Hardware inklusive. Fehlerseite 404 vermeiden. '.repeat(5);
    expect(classifyPage({ httpStatus: 200, text: rich, hasPasswordField: false })).toEqual({
      outcome: 'ok',
    });
  });
});
