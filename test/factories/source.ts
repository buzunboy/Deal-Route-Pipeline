import { randomUUID } from 'node:crypto';
import type { Source } from '../../src/domain/index.js';

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: randomUUID(),
    url: 'https://www.telekom.de/magenta-tv',
    type: 'bundler',
    tier: 2,
    country: 'DE',
    subscription_service: 'Disney+',
    cadence_days: 3,
    reliability_score: 0.5,
    status: 'active',
    last_seen: null,
    next_due: null,
    ...overrides,
  };
}
