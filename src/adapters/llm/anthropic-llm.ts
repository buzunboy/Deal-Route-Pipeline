import Anthropic from '@anthropic-ai/sdk';
import type { Llm, LlmRequest, LlmResponse } from '../../application/ports/index.js';
import { withRetry, withTimeout } from '../shared/retry.js';
import { estimateCostEur } from './pricing.js';
import { recoverJsonText } from './json-recovery.js';

export interface AnthropicLlmOptions {
  apiKey: string;
  extractionModel: string;
  discoveryModel: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * Anthropic adapter for the `Llm` port. Maps the role to the configured model
 * (cheap extractor vs stronger discovery), enforces a timeout, retries transient
 * errors with backoff, and reports usage + estimated cost. Business logic never
 * imports this — only the composition root does.
 */
export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const model =
      request.role === 'discovery' ? this.opts.discoveryModel : this.opts.extractionModel;
    // Anthropic has no JSON-mode flag; we steer via the system prompt and prefill.
    const system = request.jsonMode
      ? `${request.system}\n\nRespond with a single JSON object and nothing else.`
      : request.system;

    const message = await withRetry(
      () =>
        withTimeout(
          this.client.messages.create({
            model,
            max_tokens: this.opts.maxOutputTokens,
            system,
            messages: [{ role: 'user', content: request.user }],
          }),
          this.opts.timeoutMs,
        ),
      { retries: 2, baseDelayMs: 500, isRetryable: isTransient },
    );

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    return {
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

/** Retry on rate-limit / overloaded / 5xx; not on 4xx auth/validation. */
function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status === undefined || err.status >= 500;
  }
  return true;
}
