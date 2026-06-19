import type { BrowserAgent, AgentBudget, AgentRunResult } from '../ports/index.js';

/**
 * Phase-A placeholder for the agentic lane (Tiers 3–4). It implements the
 * `BrowserAgent` port so the rest of the pipeline can depend on it now; the real
 * bounded agent (Browser Use / Stagehand) slots in for Phase B/C WITHOUT editing
 * any caller (OCP/LSP). It returns nothing and consumes no budget.
 */
export class NoopBrowserAgent implements BrowserAgent {
  async run(_query: string, _budget: AgentBudget): Promise<AgentRunResult> {
    return {
      pages: [],
      proposedSources: [],
      stepsUsed: 0,
      costEur: 0,
      stoppedReason: 'completed',
    };
  }
}
