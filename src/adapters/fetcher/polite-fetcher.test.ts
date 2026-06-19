import { describe, it, expect } from 'vitest';
import { parseRobots } from './polite-fetcher.js';

const UA = 'DealRouteBot/0.1';

describe('parseRobots', () => {
  it('applies wildcard Disallow rules to our agent', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /admin', UA);
    expect(rules.isAllowed('/public/page')).toBe(true);
    expect(rules.isAllowed('/private/x')).toBe(false);
    expect(rules.isAllowed('/admin')).toBe(false);
  });

  it('prefers a group that names our agent over the wildcard', () => {
    const txt = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: DealRouteBot',
      'Disallow: /secret',
    ].join('\n');
    const rules = parseRobots(txt, UA);
    expect(rules.isAllowed('/anything')).toBe(true);
    expect(rules.isAllowed('/secret/x')).toBe(false);
  });

  it('treats an empty Disallow as allow-all', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', UA);
    expect(rules.isAllowed('/anything')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# comment\nUser-agent: *\n\nDisallow: /x # inline', UA);
    expect(rules.isAllowed('/x/y')).toBe(false);
    expect(rules.isAllowed('/y')).toBe(true);
  });

  it('honours Allow with longest-match precedence over a broad Disallow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /angebote', UA);
    expect(rules.isAllowed('/angebote/disney')).toBe(true); // Allow is more specific
    expect(rules.isAllowed('/konto')).toBe(false); // only the Disallow:/ matches
  });

  it('does not match a robots group whose token is merely a substring of our UA', () => {
    // A `User-agent: bot` group must NOT capture `dealroutebot`.
    const rules = parseRobots('User-agent: bot\nDisallow: /\n', UA);
    expect(rules.isAllowed('/anything')).toBe(true);
  });
});
