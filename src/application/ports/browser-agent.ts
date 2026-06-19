/**
 * BrowserAgent port — the bounded agentic lane (Tiers 3–4). Defined now so Phase
 * B/C slot in without editing existing code (OCP); Phase A ships a no-op adapter.
 *
 * Runs are CAPPED (max steps/seconds/EUR) by the caller via `AgentBudget`; the
 * adapter must stop when a cap is hit. Novel domains are returned as *proposed*
 * sources and require human approval before promotion into the deterministic
 * crawl (guardrails).
 */
import type { LlmExtractedDeal } from '../../domain/index.js';

export interface AgentBudget {
  maxSteps: number;
  maxSeconds: number;
  maxCostEur: number;
}

export interface ProposedSource {
  url: string;
  rationale: string;
}

export interface AgentRunResult {
  candidates: LlmExtractedDeal[];
  proposedSources: ProposedSource[];
  stepsUsed: number;
  costEur: number;
  stoppedReason: 'completed' | 'step_cap' | 'time_cap' | 'cost_cap' | 'error';
}

export interface BrowserAgent {
  /** Run a bounded discovery task from a natural-language query. */
  run(query: string, budget: AgentBudget): Promise<AgentRunResult>;
}
