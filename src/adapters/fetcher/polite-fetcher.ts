import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import type { Logger } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';

/**
 * The minimal robots.txt fetch the politeness layer needs. A thin seam over
 * global `fetch` so the robots path is unit-testable without real network — the
 * composition root injects the default (global fetch); tests inject a scripted
 * client. Deliberately narrow (just what {@link PoliteFetcher.loadRobots} uses).
 */
export interface RobotsClient {
  fetch(url: string, init: { headers: Record<string, string> }): Promise<RobotsResponse>;
}
export interface RobotsResponse {
  ok: boolean;
  text(): Promise<string>;
}

/** Default RobotsClient: the platform global `fetch`. */
export const globalFetchRobotsClient: RobotsClient = {
  fetch: (url, init) => fetch(url, init),
};

/**
 * Politeness decorator around any `Fetcher` (Decorator pattern, behind the port).
 * Enforces the public-crawling guardrails the config promises:
 *  - **robots.txt**: when enabled, fetch + cache each origin's robots.txt and
 *    skip disallowed paths (returns a `blocked` outcome) for our user-agent;
 *  - **per-domain rate limit**: serialise requests to a host so we wait at least
 *    `minIntervalMs` between hits to the same domain.
 *
 * Composed in the composition root, so neither the crawl use-case nor the
 * concrete fetcher (Playwright/Firecrawl) changes.
 */
export class PoliteFetcher implements Fetcher {
  private readonly lastHitAt = new Map<string, number>();
  private readonly robotsCache = new Map<string, RobotsRules | null>();

  private readonly robotsClient: RobotsClient;

  constructor(
    private readonly inner: Fetcher,
    private readonly opts: {
      respectRobotsTxt: boolean;
      minIntervalMs: number;
      userAgent: string;
      logger: Logger;
      /** Injected for tests; defaults to global fetch in the composition root. */
      robotsClient?: RobotsClient;
    },
  ) {
    this.robotsClient = opts.robotsClient ?? globalFetchRobotsClient;
  }

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    if (this.opts.respectRobotsTxt && !(await this.isAllowed(url))) {
      this.opts.logger.info('skipped by robots.txt', { url });
      // Distinct from `blocked` (anti-bot): we deliberately declined per robots —
      // callers skip it silently rather than queue a non-actionable manual task.
      return outcomeOnly('robots_disallowed', url);
    }
    await this.throttle(url);
    const result = await this.inner.fetch(url, options);

    // A redirect can land on a path/origin we DIDN'T robots-check up front. Re-check
    // the final URL; if it's now disallowed, discard the captured content (we
    // already fetched it, but must not extract/store a page robots forbids) and
    // report robots_disallowed. The destination origin's robots is loaded+cached
    // here for the cross-origin case.
    if (
      this.opts.respectRobotsTxt &&
      result.outcome === 'ok' &&
      result.finalUrl !== url &&
      !(await this.isAllowed(result.finalUrl))
    ) {
      this.opts.logger.info('final URL disallowed by robots.txt after redirect; discarding', {
        requested: url,
        finalUrl: result.finalUrl,
      });
      return outcomeOnly('robots_disallowed', result.finalUrl);
    }
    return result;
  }

  /** Wait until at least `minIntervalMs` has elapsed since the last hit to this host. */
  private async throttle(url: string): Promise<void> {
    const host = hostOf(url);
    if (host === null || this.opts.minIntervalMs <= 0) return;
    const last = this.lastHitAt.get(host);
    const now = Date.now();
    if (last !== undefined) {
      const wait = this.opts.minIntervalMs - (now - last);
      if (wait > 0) await sleep(wait);
    }
    this.lastHitAt.set(host, Date.now());
  }

  private async isAllowed(url: string): Promise<boolean> {
    const origin = originOf(url);
    if (origin === null) return true;
    if (!this.robotsCache.has(origin)) {
      this.robotsCache.set(origin, await this.loadRobots(origin));
    }
    const rules = this.robotsCache.get(origin) ?? null;
    if (rules === null) return true; // no robots / unreachable → allowed
    return rules.isAllowed(pathOf(url));
  }

  private async loadRobots(origin: string): Promise<RobotsRules | null> {
    try {
      const res = await withTimeout(
        this.robotsClient.fetch(`${origin}/robots.txt`, {
          headers: { 'user-agent': this.opts.userAgent },
        }),
        5000,
      );
      if (!res.ok) return null;
      return parseRobots(await res.text(), this.opts.userAgent);
    } catch {
      // Unreachable robots.txt must not block crawling — fail open, but logged.
      this.opts.logger.warn('robots.txt unreachable; proceeding', { origin });
      return null;
    }
  }
}

interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

/**
 * robots.txt rules for our user-agent, applying RFC 9309 longest-match
 * precedence: among the Allow/Disallow rules whose path is a prefix of the
 * request path, the most specific (longest) one wins; an Allow (or no match)
 * means the path is crawlable. So `Disallow: /` + `Allow: /angebote` correctly
 * permits `/angebote` instead of blocking the whole site.
 */
class RobotsRules {
  constructor(private readonly rules: RobotsRule[]) {}
  isAllowed(path: string): boolean {
    let best: RobotsRule | null = null;
    for (const rule of this.rules) {
      if (rule.path === '' || !path.startsWith(rule.path)) continue;
      if (best === null || rule.path.length > best.path.length) {
        best = rule;
      } else if (rule.path.length === best.path.length && rule.type === 'allow') {
        // RFC 9309: on an equal-length tie the least-restrictive rule (Allow) wins.
        best = rule;
      }
    }
    return best === null || best.type === 'allow';
  }
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/**
 * Parse robots.txt for the group matching our user-agent, falling back to `*`.
 * Handles Allow + Disallow with longest-match precedence (see {@link RobotsRules}).
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const productToken = productTokenOf(userAgent);
  const lines = text.split('\n').map((l) => l.replace(/#.*/, '').trim());
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ type: key === 'allow' ? 'allow' : 'disallow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // Match the robots product token as a prefix of OUR product token (RFC 9309),
  // not an arbitrary substring of the full UA — so a `bot` group doesn't capture
  // `dealroutebot`.
  const matching = groups.find((g) =>
    g.agents.some((a) => a !== '*' && productToken.startsWith(a)),
  );
  const wildcard = groups.find((g) => g.agents.includes('*'));
  return new RobotsRules((matching ?? wildcard)?.rules ?? []);
}

/** The product token of a user-agent: the part before the first '/', lowercased. */
function productTokenOf(userAgent: string): string {
  return userAgent.toLowerCase().split('/')[0]!.trim();
}

function outcomeOnly(outcome: FetchResult['outcome'], url: string): FetchResult {
  return { outcome, url, finalUrl: url, text: '', html: '', screenshot: new Uint8Array() };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
