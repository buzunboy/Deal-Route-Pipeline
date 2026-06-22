import { describe, it, expect } from 'vitest';
import { toAdminPublishedStatus, toAdminPublishedDeal } from './admin-published.js';
import { makeDealRecord } from '../../../test/factories/deal.js';

describe('admin-published projection', () => {
  it('maps lifecycle status: published → live, expired → unpublished', () => {
    expect(toAdminPublishedStatus('published')).toBe('live');
    expect(toAdminPublishedStatus('expired')).toBe('unpublished');
  });

  it('projects a deal into the panel row shape (geo=country, true_monthly=true_cost)', () => {
    const deal = makeDealRecord({
      status: 'published',
      service: 'Disney+',
      provider: 'Telekom',
      country: 'DE',
      true_cost_monthly: 12.5,
      published_at: '2026-06-19T10:00:00.000Z',
    });
    expect(toAdminPublishedDeal(deal)).toEqual({
      id: deal.id,
      service: 'Disney+',
      provider: 'Telekom',
      geo: 'DE',
      true_monthly: 12.5,
      published_at: '2026-06-19T10:00:00.000Z',
      status: 'live',
    });
  });

  it('an expired deal projects to unpublished', () => {
    const deal = makeDealRecord({ status: 'expired', published_at: '2026-06-01T00:00:00.000Z' });
    expect(toAdminPublishedDeal(deal).status).toBe('unpublished');
  });
});
