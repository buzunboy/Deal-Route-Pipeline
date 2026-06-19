import { describe, it, expect } from 'vitest';
import { recoverJsonText } from './json-recovery.js';

/** Parse helper: recovery must yield text that JSON.parse accepts. */
function recoverable(raw: string): unknown {
  return JSON.parse(recoverJsonText(raw));
}

describe('recoverJsonText', () => {
  it('passes through clean JSON unchanged (incl. valid escapes)', () => {
    expect(recoverable('{"deals":[{"x":"a\\nb\\t\\"c\\""}]}')).toEqual({
      deals: [{ x: 'a\nb\t"c"' }],
    });
  });

  it('unwraps a ```json fence with trailing prose', () => {
    const raw = '```json\n{"deals":[]}\n```\n\nReasoning: the page was a 404.';
    expect(recoverable(raw)).toEqual({ deals: [] });
  });

  it('unwraps a fence with no language tag', () => {
    expect(recoverable('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('extracts the first balanced object when prose surrounds bare JSON', () => {
    expect(recoverable('Here you go: {"deals":[]} — hope that helps')).toEqual({ deals: [] });
  });

  it('repairs invalid backslash escapes (German gender-star), keeping valid ones', () => {
    // The model copied "Nutzer\*innen" verbatim — \* is not a valid JSON escape.
    const raw = '{"source_quote":"Es gilt nicht für Nutzer\\*innen, die\\nzahlen"}';
    expect(recoverable(raw)).toEqual({
      source_quote: 'Es gilt nicht für Nutzer*innen, die\nzahlen',
    });
  });

  it('preserves \\uXXXX unicode escapes', () => {
    expect(recoverable('{"s":"\\u00e9"}')).toEqual({ s: 'é' });
  });

  it('handles an escaped backslash followed by a non-escape char', () => {
    // "\\*" = a literal backslash then a star; must survive as backslash + star.
    expect(recoverable('{"s":"a\\\\*b"}')).toEqual({ s: 'a\\*b' });
  });

  it('leaves genuinely-unrecoverable text for the boundary parser to reject', () => {
    // Not JSON at all → returned as-is; downstream JSON.parse throws (by design).
    const out = recoverJsonText('totally not json');
    expect(() => JSON.parse(out)).toThrow();
  });
});
