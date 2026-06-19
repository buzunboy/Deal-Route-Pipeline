import OpenAI from 'openai';
import type { Llm, LlmRequest, LlmResponse } from '../../application/ports/index.js';
import { withRetry, withTimeout } from '../shared/retry.js';
import { estimateCostEur } from './pricing.js';
import { recoverJsonText } from './json-recovery.js';

export interface OpenAiLlmOptions {
  apiKey: string;
  extractionModel: string;
  discoveryModel: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * OpenAI adapter for the `Llm` port. Substitutable with the Anthropic adapter
 * behind the same port (LSP); selected by `LLM_PROVIDER`. Uses native JSON mode
 * when requested.
 */
export class OpenAiLlm implements Llm {
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiLlmOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model =
      request.role === 'discovery' ? this.opts.discoveryModel : this.opts.extractionModel;

    const completion = await withRetry(
      () =>
        withTimeout(
          this.client.chat.completions.create({
            model,
            max_tokens: this.opts.maxOutputTokens,
            response_format: request.jsonMode ? { type: 'json_object' } : { type: 'text' },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
          this.opts.timeoutMs,
        ),
      { retries: 2, baseDelayMs: 500, isRetryable: isTransient },
    );

    const text = completion.choices[0]?.message?.content ?? '';
    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    return {
      // json_object mode rarely fences, but recover defensively for substitutability.
      text: recoverJsonText(text),
      usage: {
        inputTokens,
        outputTokens,
        costEur: estimateCostEur(model, inputTokens, outputTokens),
      },
      model,
    };
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    return err.status === 429 || err.status === undefined || err.status >= 500;
  }
  return true;
}
