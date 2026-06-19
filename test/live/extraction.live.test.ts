import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Container } from '../../src/composition/container.js';

/**
 * LIVE smoke tests — these hit the real internet (Playwright fetch) and the real
 * LLM (Anthropic). They catch "the live WORLD changed": a site's markup changed,
 * a feed moved, or the model drifted so our extraction degrades. They are
 * NON-deterministic, cost money, and need a real API key, so they:
 *   - self-skip unless `RUN_LIVE_TESTS=1` AND a provider key is configured;
 *   - run on a schedule (nightly) / on a `live-test` PR label, NEVER on the
 *     normal PR gate (see `.github/workflows/live.yml`).
 * Use generous timeouts: real fetch + LLM round-trips.
 */
const enabled =
  process.env.RUN_LIVE_TESTS === '1' &&
  (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

const suite = enabled ? describe : describe.skip;
const MINUTE = 60_000;

suite('live extraction smoke', () => {
  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  function liveContainer(): Container {
    // Real adapters; no persistence (we assert the in-memory candidate, write nothing).
    return new Container(loadConfig(), { usePersistence: false });
  }

  it(
    'Spotify Premium (DE) still yields a grounded subscription candidate',
    async () => {
      container = liveContainer();
      const fetched = await container.fetcher.fetch('https://www.spotify.com/de/premium/', {
        timeoutMs: container.config.fetcher.timeoutMs,
        userAgent: container.config.fetcher.userAgent,
      });
      // If Spotify blocks/login-walls the bot, that's a routing outcome, not a
      // hard failure of OUR code — surface it but don't assert a candidate.
      if (fetched.outcome !== 'ok') {
        console.warn(`Spotify live fetch outcome: ${fetched.outcome} — skipping extraction assert`);
        return;
      }

      const result = await container.extract.execute({
        pageText: fetched.text,
        sourceUrl: fetched.finalUrl,
        targetService: 'Spotify',
        vocabulary: container.vocabulary,
      });

      expect(result.candidates.length).toBeGreaterThan(0);
      // Every candidate must carry grounding (the trust contract) and a sane price.
      for (const c of result.candidates) {
        expect(c.deal.grounding.length).toBeGreaterThan(0);
        expect(c.deal.confidence).toBeGreaterThan(0);
        expect(c.deal.price.currency).toBe('EUR');
      }
    },
    3 * MINUTE,
  );

  it(
    'a mydealz RSS feed still parses into lead items with links',
    async () => {
      container = liveContainer();
      const items = await container.feedReader.read('https://www.mydealz.de/rss', {
        timeoutMs: container.config.fetcher.timeoutMs,
        userAgent: container.config.fetcher.userAgent,
      });
      // The feed format is what we depend on; assert it still yields linked items.
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => /^https?:\/\//.test(i.link))).toBe(true);
    },
    1 * MINUTE,
  );
});
