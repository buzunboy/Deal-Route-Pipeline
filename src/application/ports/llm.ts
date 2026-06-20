/**
 * Llm port — provider-agnostic. The domain/application know nothing about
 * Anthropic or OpenAI; adapters implement this and are selected by env
 * (`LLM_PROVIDER`). Two model roles: a cheap/fast extractor and a stronger model
 * for ambiguous/agentic reasoning.
 */

export type LlmRole = 'extraction' | 'discovery';

export interface LlmRequest {
  role: LlmRole;
  system: string;
  user: string;
  /** Ask the provider to return strict JSON when supported. */
  jsonMode?: boolean;
}

export interface LlmResponse {
  /** Raw model text (expected to be JSON for extraction). Validated at the boundary. */
  text: string;
  /** Best-effort token + cost accounting for per-run cost logging (guardrails). */
  usage: {
    inputTokens: number;
    outputTokens: number;
    costEur: number;
  };
  model: string;
  /**
   * True when the model stopped because it hit the output-token limit
   * (Anthropic `stop_reason==='max_tokens'`, OpenAI `finish_reason==='length'`).
   * A truncated reply is usually invalid JSON that the boundary then rejects as a
   * silent zero-candidate outcome — surfacing the flag lets the caller log/flag it
   * (so a "this source extracts nothing" regression is visible, not silent).
   */
  truncated: boolean;
}

export interface Llm {
  /** Single timeout-bounded completion. Retries/backoff live in the adapter. */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
