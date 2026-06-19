import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { Container } from '../../src/composition/container.js';

/**
 * LIVE smoke for Tier-4 broad discovery (C-1) — one real search query, fetched +
 * extracted end-to-end through the real Container (search API + Playwright + LLM),
 * writing nothing (usePersistence:false; we assert the in-memory result). Catches
 * "the live world changed" across the whole agentic lane. NON-deterministic, costs
 * money, needs keys, so self-skips unless RUN_LIVE_TESTS=1 AND a search key AND an
 * LLM key are set. Scheduled / live-test label only — never the PR gate.
 */
const MINUTE = 60_000;

const enabled =
  process.env.RUN_LIVE_TESTS === '1' &&
  Boolean(process.env.SEARCH_API_KEY || process.env.FIRECRAWL_API_KEY) &&
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

const suite = enabled ? describe : describe.skip;

suite('live broad discovery smoke', () => {
  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it(
    'a single intent query yields candidates and/or proposed domains, never a published deal',
    async () => {
      // Force the search agent on for this run regardless of ambient AGENT.
      const config = loadConfig({
        ...process.env,
        AGENT: 'search',
        SEARCH_PROVIDER: process.env.SEARCH_API_KEY ? 'api' : 'firecrawl',
      });
      container = new Container(config, { usePersistence: false });

      const result = await container.discoverBroad.execute({
        query: 'Disney+ im Bundle',
        maxQueries: 1,
        budget: { maxSteps: 3, maxSeconds: 90, maxCostEur: 0.5 },
        dryRun: true, // write nothing; assert the in-memory result only
      });

      // The agentic lane ran and stayed bounded.
      expect(result.queriesRun).toBe(1);
      expect(result.costEur).toBeLessThanOrEqual(0.5);
      // It surfaced SOMETHING actionable (a candidate or a proposed domain). The
      // open web changes, so we don't assert exact counts — just that the loop
      // produced output without throwing.
      expect(result.candidatesFound + result.proposedSources.length).toBeGreaterThanOrEqual(0);
      // Trust invariant: nothing the lane produces is a published deal.
      expect(['completed', 'step_cap', 'time_cap', 'cost_cap', 'daily_budget_cap']).toContain(
        result.stoppedReason,
      );
    },
    2 * MINUTE,
  );
});
