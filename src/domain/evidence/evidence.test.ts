import { describe, it, expect } from 'vitest';
import { assertCaptureComplete } from './evidence.js';
import { InvariantViolation } from '../errors/index.js';
import type { EvidenceCapture } from './evidence.js';

function makeCapture(overrides: Partial<EvidenceCapture> = {}): EvidenceCapture {
  return {
    sourceUrl: 'https://www.telekom.de/magenta-tv',
    screenshot: new Uint8Array([137, 80, 78, 71]),
    html: '<html><body>Disney+ inklusive</body></html>',
    termsText: 'Disney+ ist im Tarif enthalten.',
    capturedAt: '2026-06-19T00:00:00.000Z',
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('assertCaptureComplete', () => {
  it('accepts a complete capture', () => {
    expect(() => assertCaptureComplete(makeCapture())).not.toThrow();
  });

  it('rejects an empty screenshot', () => {
    expect(() => assertCaptureComplete(makeCapture({ screenshot: new Uint8Array() }))).toThrow(
      InvariantViolation,
    );
  });

  it('rejects empty HTML', () => {
    expect(() => assertCaptureComplete(makeCapture({ html: '' }))).toThrow(InvariantViolation);
  });

  it('rejects empty terms text', () => {
    expect(() => assertCaptureComplete(makeCapture({ termsText: '' }))).toThrow(InvariantViolation);
  });

  it('names every empty part in the error message', () => {
    try {
      assertCaptureComplete(makeCapture({ screenshot: new Uint8Array(), html: '', termsText: '' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantViolation);
      const msg = (err as Error).message;
      expect(msg).toContain('screenshot');
      expect(msg).toContain('html');
      expect(msg).toContain('termsText');
    }
  });
});
