import { randomUUID } from 'node:crypto';
import type { Source } from '../../src/domain/index.js';
import { tldtsSuffixOracle } from '../../src/adapters/suffix/tldts-suffix-oracle.js';

export function makeSource(overrides: Partial<Source> = {}): Source {
  const source: Source = {
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
    resolved_url: null,
    registrable_domain: null,
    ...overrides,
  };
  // Step 6: every production source-create path pins registrable_domain (the eTLD+1
  // of its url) via the real PSL before upsert — the reliability join keys off it.
  // Mirror that here so a factory source joins to its deals, unless a test pins it.
  if (!('registrable_domain' in overrides)) {
    source.registrable_domain = tldtsSuffixOracle(source.url);
  }
  return source;
}
