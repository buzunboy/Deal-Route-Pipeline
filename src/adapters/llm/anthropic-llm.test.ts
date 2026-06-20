import { describe, it, expect } from 'vitest';
import { AnthropicLlm } from './anthropic-llm.js';

/**
 * Focused mapping tests for the Anthropic adapter's response→LlmResponse mapping —
 * specifically the `truncated` flag (set from `stop_reason==='max_tokens'`). The
 * adapter news up the SDK client in its constructor, so we swap the private client
 * for a stub that returns a scripted `messages.create` result (the only method used).
 */
function adapterWith(message: unknown): AnthropicLlm {
  const llm = new AnthropicLlm({
    apiKey: 'k',
    extractionModel: 'm-extract',
    discoveryModel: 'm-discover',
    maxOutputTokens: 100,
    timeoutMs: 1000,
  });
  // Replace the real SDK client with a stub exposing just messages.create.
  (llm as unknown as { client: unknown }).client = {
    messages: { create: async () => message },
  };
  return llm;
}

const baseMessage = (stopReason: string | null) => ({
  content: [{ type: 'text', text: '{"deals":[]}' }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: stopReason,
});

describe('AnthropicLlm response mapping', () => {
  it('flags truncated=true when stop_reason is max_tokens', async () => {
    const r = await adapterWith(baseMessage('max_tokens')).complete({
      role: 'extraction',
      system: 's',
      user: 'u',
    });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('deals');
  });

  it('flags truncated=false on a normal end_turn stop', async () => {
    const r = await adapterWith(baseMessage('end_turn')).complete({
      role: 'extraction',
      system: 's',
      user: 'u',
    });
    expect(r.truncated).toBe(false);
  });

  it('maps the role to the extraction model and reports usage', async () => {
    const r = await adapterWith(baseMessage('end_turn')).complete({
      role: 'extraction',
      system: 's',
      user: 'u',
    });
    expect(r.model).toBe('m-extract');
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(5);
  });
});
