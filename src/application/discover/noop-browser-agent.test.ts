import { describe, it, expect } from 'vitest';
import { NoopBrowserAgent } from './noop-browser-agent.js';
import { browserAgentContract } from '../../../test/contracts/browser-agent-contract.js';

// The off-switch must satisfy the same BrowserAgent contract as the real agent.
browserAgentContract('NoopBrowserAgent', () => new NoopBrowserAgent());

describe('NoopBrowserAgent', () => {
  it('does nothing and consumes no budget', async () => {
    const result = await new NoopBrowserAgent().run('any query', {
      maxSteps: 10,
      maxSeconds: 30,
      maxCostEur: 1,
    });
    expect(result.pages).toEqual([]);
    expect(result.proposedSources).toEqual([]);
    expect(result.stepsUsed).toBe(0);
    expect(result.costEur).toBe(0);
    expect(result.stoppedReason).toBe('completed');
  });
});
