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
});
