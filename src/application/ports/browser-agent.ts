/**
 * BrowserAgent port — the bounded agentic lane (Tiers 3–4). Defined now so Phase
 * B/C slot in without editing existing code (OCP); Phase A ships a no-op adapter.
 *
 * Runs are CAPPED (max steps/seconds/EUR) by the caller via `AgentBudget`; the
 * adapter must stop when a cap is hit. Novel domains are returned as *proposed*
 * sources and require human approval before promotion into the deterministic
 * crawl (guardrails).
 *
 * The agent is THIN: it navigates (search + public fetch) and returns the fetched
 * page MATERIAL — it does NOT extract. Extraction stays in `ExtractUseCase` (the
 * one boundary that turns page text into validated candidates), so the LLM does
 * extraction/navigation only and the same trust gate applies as Lane A.
 */
import type { FetchResult } from './fetcher.js';

/**
 * A public page the agent fetched, as material for the use-case. Carries the full
 * `FetchResult` (text + html + screenshot) so the use-case can both EXTRACT (page
 * text) and CAPTURE EVIDENCE (screenshot/html/terms) without re-fetching — the
 * trust invariant "evidence required before any candidate" needs the bytes.
 */
export interface FetchedPage {
  sourceUrl: string;
  fetched: FetchResult;
}

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
  /**
   * Every page the agent fetched, carrying its `FetchResult.outcome`. The thin
   * agent does no DB I/O, so it does not route blocked pages itself — the
   * use-case dispatches on outcome: `ok` → extract + capture evidence; blocked/
   * login/captcha → manual-capture queue; robots_disallowed/error → skip.
   */
  pages: FetchedPage[];
  /** Novel domains seen — proposed for human approval, never auto-crawled. */
  proposedSources: ProposedSource[];
  stepsUsed: number;
  costEur: number;
  stoppedReason: 'completed' | 'step_cap' | 'time_cap' | 'cost_cap' | 'error';
}

export interface BrowserAgent {
  /** Run a bounded discovery task from a natural-language query. */
  run(query: string, budget: AgentBudget): Promise<AgentRunResult>;
}
