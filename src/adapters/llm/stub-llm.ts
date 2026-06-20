import { readFileSync } from 'node:fs';
import type { Llm, LlmRequest, LlmResponse } from '../../application/ports/index.js';

/**
 * Stub LLM adapter (`LLM_PROVIDER=stub`). Returns a deterministic, offline
 * response so the whole pipeline can run WITHOUT any API key — for demos, the
 * deterministic end-to-end dry-run, and CI. It does NOT call a model.
 *
 * Resolution order for the JSON it returns:
 *  1. `STUB_LLM_RESPONSE_FILE` env → read that JSON file;
 *  2. `STUB_LLM_RESPONSE` env → use that JSON string;
 *  3. otherwise → an empty `{ "deals": [] }` (a valid "no offers" outcome).
 *
 * The returned text still flows through the real boundary validation + rules, so
 * a stub run exercises the same trust path as a real extraction.
 */
export class StubLlm implements Llm {
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    return {
      text: this.resolveJson(),
      usage: { inputTokens: 0, outputTokens: 0, costEur: 0 },
      model: 'stub',
      truncated: false,
    };
  }

  private resolveJson(): string {
    const file = process.env.STUB_LLM_RESPONSE_FILE;
    if (file) return readFileSync(file, 'utf8');
    const inline = process.env.STUB_LLM_RESPONSE;
    if (inline) return inline;
    return JSON.stringify({ deals: [] });
  }
}
