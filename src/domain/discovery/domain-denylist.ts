/**
 * Domain deny-list for Tier-4 broad discovery (Phase C). Pure domain logic, no I/O.
 *
 * Open-web search surfaces a lot of noise: social networks, link aggregators,
 * marketplaces, and search engines themselves. Fetching or proposing those wastes
 * budget and pollutes the source-approval queue — they are never a *provider's*
 * own offer page. This is a configurable set of registrable domains the
 * broad-discovery use-case must never fetch OR propose.
 *
 * The default set is intentionally conservative (well-known noise only); operators
 * extend it via `DISCOVERY_DENY_DOMAINS` (comma-separated). It is NOT a content
 * filter or a substitute for human approval — just a cheap pre-filter so obvious
 * non-providers never reach the fetch loop or the approval queue.
 */
import { registrableDomain } from './links.js';

/** Well-known social / aggregator / search noise — never a provider offer page. */
export const DEFAULT_DENY_DOMAINS: readonly string[] = [
  // Social
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'reddit.com',
  'pinterest.com',
  'linkedin.com',
  // Search engines / portals
  'google.com',
  'google.de',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  // Marketplaces / generic aggregators (not a single provider's offer)
  'amazon.de',
  'amazon.com',
  'ebay.de',
  'wikipedia.org',
] as const;

/**
 * A reusable deny-list. Construct once (from the default set + any env-configured
 * extra domains) and pass into the use-case. Membership is by registrable domain,
 * so `www.facebook.com/foo` and `m.facebook.com` both match `facebook.com`.
 */
export class DomainDenylist {
  private readonly denied: Set<string>;

  constructor(domains: readonly string[] = DEFAULT_DENY_DOMAINS) {
    this.denied = new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0));
  }

  /** Build from the default set plus extra comma/whitespace-separated domains. */
  static fromConfig(extra: string | undefined): DomainDenylist {
    const extras = (extra ?? '')
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
    return new DomainDenylist([...DEFAULT_DENY_DOMAINS, ...extras]);
  }

  /** True when the URL's registrable domain is denied (or the URL is unparseable). */
  isDenied(url: string): boolean {
    const domain = registrableDomain(url);
    // An unparseable URL has no registrable domain — deny it (can't fetch/propose it).
    if (domain === null) return true;
    return this.denied.has(domain);
  }
}
