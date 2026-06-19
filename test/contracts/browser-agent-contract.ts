import { describe, it, expect } from 'vitest';
import type { BrowserAgent } from '../../src/application/ports/index.js';

/**
 * Shared contract suite for the BrowserAgent port. Every adapter (NoopBrowserAgent,
 * SearchBrowserAgent, a future real-browser agent) must satisfy it, so any
 * implementation is substitutable behind the port (LSP, `testing.md`).
 *
 * The contract pins the SHAPE + the budget invariants every agent must honour;
 * adapter-specific behaviour (what it actually fetches) is covered by each
 * adapter's own unit tests.
 */
export function browserAgentContract(
  name: string,
  makeAgent: () => BrowserAgent | Promise<BrowserAgent>,
): void {
  describe(`BrowserAgent contract: ${name}`, () => {
    const budget = { maxSteps: 5, maxSeconds: 30, maxCostEur: 1 };

    it('returns a well-shaped AgentRunResult', async () => {
      const agent = await makeAgent();
      const result = await agent.run('Disney+ im Bundle', budget);
      expect(Array.isArray(result.pages)).toBe(true);
      expect(Array.isArray(result.proposedSources)).toBe(true);
      expect(typeof result.stepsUsed).toBe('number');
      expect(typeof result.costEur).toBe('number');
      expect(['completed', 'step_cap', 'time_cap', 'cost_cap', 'error']).toContain(
        result.stoppedReason,
      );
    });

    it('never exceeds the step budget', async () => {
      const agent = await makeAgent();
      const result = await agent.run('Disney+ im Bundle', { ...budget, maxSteps: 2 });
      expect(result.stepsUsed).toBeLessThanOrEqual(2);
    });

    it('never reports negative steps or cost', async () => {
      const agent = await makeAgent();
      const result = await agent.run('anything', budget);
      expect(result.stepsUsed).toBeGreaterThanOrEqual(0);
      expect(result.costEur).toBeGreaterThanOrEqual(0);
    });

    it('every fetched page carries its source url + fetch result', async () => {
      const agent = await makeAgent();
      const result = await agent.run('Disney+ im Bundle', budget);
      for (const page of result.pages) {
        expect(typeof page.sourceUrl).toBe('string');
        expect(page.fetched).toBeDefined();
        expect(typeof page.fetched.outcome).toBe('string');
      }
    });
  });
}
