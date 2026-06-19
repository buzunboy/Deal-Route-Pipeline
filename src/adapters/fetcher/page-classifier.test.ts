import { describe, it, expect } from 'vitest';
import { classifyPage } from './page-classifier.js';

describe('classifyPage', () => {
  const okText = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten. '.repeat(20);

  it('classifies a normal content page as ok', () => {
    expect(classifyPage({ httpStatus: 200, text: okText, hasPasswordField: false })).toBe('ok');
  });

  it('classifies a 403 with login signals as login_required', () => {
    expect(
      classifyPage({ httpStatus: 403, text: 'Bitte anmelden', hasPasswordField: true }),
    ).toBe('login_required');
  });

  it('classifies a captcha page', () => {
    expect(
      classifyPage({ httpStatus: 200, text: 'Please complete the captcha', hasPasswordField: false }),
    ).toBe('captcha');
  });

  it('classifies an anti-bot block', () => {
    expect(
      classifyPage({ httpStatus: 200, text: 'Access denied by Cloudflare', hasPasswordField: false }),
    ).toBe('blocked');
  });

  it('classifies a thin login-form page as login_required', () => {
    expect(
      classifyPage({ httpStatus: 200, text: 'Login\nPasswort', hasPasswordField: true }),
    ).toBe('login_required');
  });

  it('does NOT treat a rich page with an incidental password field as login-gated', () => {
    expect(classifyPage({ httpStatus: 200, text: okText, hasPasswordField: true })).toBe('ok');
  });

  it('classifies 429/5xx as error', () => {
    expect(classifyPage({ httpStatus: 429, text: '', hasPasswordField: false })).toBe('error');
    expect(classifyPage({ httpStatus: 503, text: '', hasPasswordField: false })).toBe('error');
  });
});
