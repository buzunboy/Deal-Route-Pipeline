import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import type { Logger } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';

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

  constructor(
    private readonly inner: Fetcher,
    private readonly opts: {
      respectRobotsTxt: boolean;
      minIntervalMs: number;
      userAgent: string;
      logger: Logger;
    },
  ) {}

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    if (this.opts.respectRobotsTxt && !(await this.isAllowed(url))) {
      this.opts.logger.info('skipped by robots.txt', { url });
      return blocked(url);
    }
    await this.throttle(url);
    return this.inner.fetch(url, options);
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
        fetch(`${origin}/robots.txt`, { headers: { 'user-agent': this.opts.userAgent } }),
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

/** Minimal robots.txt rules: the Disallow paths that apply to our user-agent. */
class RobotsRules {
  constructor(private readonly disallow: string[]) {}
  isAllowed(path: string): boolean {
    return !this.disallow.some((rule) => rule !== '' && path.startsWith(rule));
  }
}

/**
 * Parse robots.txt for the group matching our user-agent, falling back to `*`.
 * Intentionally small (prefix Disallow rules only) — enough for the public pages
 * we crawl; a fuller parser can replace it behind the same decorator.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const lines = text.split('\n').map((l) => l.replace(/#.*/, '').trim());
  const groups: { agents: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const matching = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  return new RobotsRules((matching ?? wildcard)?.disallow ?? []);
}

function blocked(url: string): FetchResult {
  return { outcome: 'blocked', url, finalUrl: url, text: '', html: '', screenshot: new Uint8Array() };
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
