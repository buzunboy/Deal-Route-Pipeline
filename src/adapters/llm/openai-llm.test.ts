import { describe, it, expect } from 'vitest';
import { OpenAiLlm } from './openai-llm.js';

/**
 * Focused mapping tests for the OpenAI adapter's response→LlmResponse mapping —
 * specifically `truncated` (set from `finish_reason==='length'`). The adapter news
 * up the SDK client in its constructor, so we swap the private client for a stub
 * exposing just chat.completions.create (the only method used).
 */
function adapterWith(completion: unknown): OpenAiLlm {
  const llm = new OpenAiLlm({
    apiKey: 'k',
    extractionModel: 'm-extract',
    discoveryModel: 'm-discover',
    maxOutputTokens: 100,
    timeoutMs: 1000,
  });
  (llm as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => completion } },
  };
  return llm;
}

const completionWith = (finishReason: string | null) => ({
  choices: [{ message: { content: '{"deals":[]}' }, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

describe('OpenAiLlm response mapping', () => {
  it('flags truncated=true when finish_reason is length', async () => {
    const r = await adapterWith(completionWith('length')).complete({
      role: 'extraction',
      system: 's',
      user: 'u',
    });
    expect(r.truncated).toBe(true);
  });

  it('flags truncated=false on a normal stop', async () => {
    const r = await adapterWith(completionWith('stop')).complete({
      role: 'extraction',
      system: 's',
      user: 'u',
    });
    expect(r.truncated).toBe(false);
  });

  it('reports model + usage', async () => {
    const r = await adapterWith(completionWith('stop')).complete({
      role: 'discovery',
      system: 's',
      user: 'u',
    });
    expect(r.model).toBe('m-discover');
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(5);
  });
});
