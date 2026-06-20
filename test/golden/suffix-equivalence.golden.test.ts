import { describe, it, expect } from 'vitest';
import { tldtsSuffixOracle } from '../../src/adapters/suffix/tldts-suffix-oracle.js';

/**
 * Step 6 — the MERGE GATE for the PSL swap.
 *
 * Replacing the legacy "last two labels" registrable-domain rule with a real
 * Public Suffix List (`tldts`) must NOT change the value for any host the existing
 * DE corpus produces — otherwise the split-by-source dedupe key would churn and
 * existing deals would merge/split. `.de` (and `.com`, `.tv`, …) are single-label
 * public suffixes, so eTLD+1 == last-two-labels for them; this asserts that holds
 * byte-for-byte across a representative + adversarial single-label corpus.
 *
 * It ALSO asserts the multi-label cases the legacy rule got WRONG now resolve
 * correctly (the whole point of the change) — and that legacy genuinely got them
 * wrong, so the assertion can't silently pass against a no-op.
 */

/**
 * The legacy registrable-domain rule, kept here as the oracle-of-truth for the
 * single-label equivalence check. (This is the exact logic deleted from
 * `links.ts` in this step — preserved in the test, not in production.)
 */
function legacyLastTwoLabels(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const labels = u.hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/**
 * Representative single-label-suffix hosts (the DE v1 corpus is .de / .com / .tv /
 * .net) PLUS adversarial single-label forms: subdomains, deep nesting, uppercase,
 * a trailing dot, an explicit port, and an IDN punycode host. For ALL of these the
 * real PSL must agree with the legacy rule byte-for-byte (no dedupe churn).
 */
const SINGLE_LABEL_CORPUS = [
  'https://telekom.de',
  'https://www.telekom.de',
  'https://telekom.de/magenta-tv',
  'https://plus.rtl.de',
  'https://amazon.de',
  'https://wow.de',
  'https://o2online.de',
  'https://mydealz.de',
  'https://dealbunny.de',
  'https://mein-deal.com',
  'https://disneyplus.com',
  'https://netflix.com',
  'https://nordvpn.com',
  'https://dazn.com',
  // adversarial single-label forms:
  'https://X.DE', // uppercase host
  'https://a.b.deep.telekom.de', // deep subdomain nesting
  'https://x.de.', // trailing dot (FQDN form)
  'https://x.de:443', // explicit port
  'https://xn--mnchen-3ya.de', // IDN ALREADY in punycode → identical both ways
];

describe('suffix oracle — DE/single-label equivalence (no dedupe churn)', () => {
  it.each(SINGLE_LABEL_CORPUS)('resolves %s identically to the legacy rule', (url) => {
    expect(tldtsSuffixOracle(url)).toBe(legacyLastTwoLabels(url));
  });
});

describe('suffix oracle — multi-label TLDs the legacy rule got WRONG (the fix)', () => {
  const cases: Array<{ url: string; correct: string; legacyWrong: string }> = [
    { url: 'https://www.bbc.co.uk', correct: 'bbc.co.uk', legacyWrong: 'co.uk' },
    { url: 'https://shop.com.au', correct: 'shop.com.au', legacyWrong: 'com.au' },
    { url: 'https://example.co.jp', correct: 'example.co.jp', legacyWrong: 'co.jp' },
  ];
  it.each(cases)(
    '$url → $correct (PSL), not $legacyWrong (legacy)',
    ({ url, correct, legacyWrong }) => {
      expect(tldtsSuffixOracle(url)).toBe(correct);
      // Prove the legacy rule was genuinely wrong here — guards against a no-op fix.
      expect(legacyLastTwoLabels(url)).toBe(legacyWrong);
      expect(tldtsSuffixOracle(url)).not.toBe(legacyLastTwoLabels(url));
    },
  );
});

describe('suffix oracle — KNOWN divergence: a Unicode IDN label (no DE host today)', () => {
  // A DOCUMENTED, deliberate difference (not a DE-corpus churn risk): the legacy
  // rule resolved via `new URL().hostname`, which is always PUNYCODE; tldts.getDomain
  // returns the UNICODE form. So a host typed with raw umlaut/eszett diverges:
  //   müller.de → tldts 'müller.de'  vs  legacy 'xn--mller-kva.de'
  // The DE seed list has NO such IDN host (grep-confirmed), so there is no stored-key
  // churn today. Pinned here so the divergence is a CONSCIOUS decision, and tracked in
  // docs/KNOWN_ISSUES.md: before adding a raw-IDN German source, decide the canonical
  // form (likely normalise the oracle to punycode) so a deal can't split old↔new.
  it('a raw-Unicode IDN host resolves to the Unicode registrable domain', () => {
    expect(tldtsSuffixOracle('https://müller.de/x')).toBe('müller.de');
    expect(tldtsSuffixOracle('https://straße.de')).toBe('straße.de');
    // ...and that legacy would have produced the punycode form (the divergence).
    expect(legacyLastTwoLabels('https://müller.de/x')).toBe('xn--mller-kva.de');
  });
});

describe('suffix oracle — non-registrable hosts fold to null (safer than legacy)', () => {
  // An unparseable URL, a bare hostname with no registrable domain, and an IP
  // literal all have no eTLD+1 → null → "unknown source" / neutral downstream.
  // (Legacy returned a bogus 'localhost' / '0.1' for the latter two.)
  it.each(['not a url', 'https://localhost', 'https://192.168.0.1'])(
    'returns null for %s (→ unknown-source / neutral downstream)',
    (url) => {
      expect(tldtsSuffixOracle(url)).toBeNull();
    },
  );
});
