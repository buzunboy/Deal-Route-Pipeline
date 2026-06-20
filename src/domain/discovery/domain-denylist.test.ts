import { describe, it, expect } from 'vitest';
import { DomainDenylist, DEFAULT_DENY_DOMAINS } from './domain-denylist.js';
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';

describe('DomainDenylist', () => {
  it('denies a default-set domain regardless of subdomain/path', () => {
    const dl = new DomainDenylist(tldtsSuffixOracle);
    expect(dl.isDenied('https://www.facebook.com/some-deal')).toBe(true);
    expect(dl.isDenied('https://m.youtube.com/watch?v=x')).toBe(true);
    expect(dl.isDenied('https://google.de/search?q=disney')).toBe(true);
  });

  it('allows a normal provider domain', () => {
    const dl = new DomainDenylist(tldtsSuffixOracle);
    expect(dl.isDenied('https://www.telekom.de/magenta-tv')).toBe(false);
    expect(dl.isDenied('https://o2online.de/angebote')).toBe(false);
  });

  it('denies an unparseable URL (cannot fetch/propose it)', () => {
    expect(new DomainDenylist(tldtsSuffixOracle).isDenied('not a url')).toBe(true);
  });

  it('fromConfig adds extra domains on top of the defaults', () => {
    const dl = DomainDenylist.fromConfig(tldtsSuffixOracle, 'spam.de, junk.com');
    expect(dl.isDenied('https://spam.de/x')).toBe(true);
    expect(dl.isDenied('https://junk.com/y')).toBe(true);
    // defaults still apply
    expect(dl.isDenied('https://facebook.com/z')).toBe(true);
    // unrelated domain still allowed
    expect(dl.isDenied('https://telekom.de/x')).toBe(false);
  });

  it('fromConfig tolerates empty / whitespace / mixed separators', () => {
    const dl = DomainDenylist.fromConfig(tldtsSuffixOracle, '  spam.de   junk.com,more.de , ');
    expect(dl.isDenied('https://spam.de')).toBe(true);
    expect(dl.isDenied('https://junk.com')).toBe(true);
    expect(dl.isDenied('https://more.de')).toBe(true);
  });

  it('fromConfig with undefined yields just the defaults', () => {
    const dl = DomainDenylist.fromConfig(tldtsSuffixOracle, undefined);
    expect(dl.isDenied('https://facebook.com')).toBe(true);
    expect(dl.isDenied('https://telekom.de')).toBe(false);
  });

  it('is case-insensitive on the configured domains', () => {
    const dl = DomainDenylist.fromConfig(tldtsSuffixOracle, 'SPAM.DE');
    expect(dl.isDenied('https://spam.de/x')).toBe(true);
  });

  it('the default set is non-empty (real noise sources)', () => {
    expect(DEFAULT_DENY_DOMAINS.length).toBeGreaterThan(0);
    expect(DEFAULT_DENY_DOMAINS).toContain('facebook.com');
  });
});
