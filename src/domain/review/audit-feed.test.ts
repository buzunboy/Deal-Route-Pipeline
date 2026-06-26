import { describe, it, expect } from 'vitest';
import { toAuditEntry, initialsOf, type AuditReviewRow } from './audit-feed.js';

describe('audit-feed projection', () => {
  describe('initialsOf', () => {
    it('takes the first letters of two words', () => {
      expect(initialsOf('Alice Müller')).toBe('AM');
    });
    it('uses the email local part, not the domain', () => {
      expect(initialsOf('alice@dealroute.de')).toBe('AL');
      expect(initialsOf('alice.mueller@dealroute.de')).toBe('AM');
    });
    it('splits on dots/underscores/hyphens', () => {
      expect(initialsOf('jan-otto')).toBe('JO');
      expect(initialsOf('jan_otto')).toBe('JO');
    });
    it('falls back to the first two characters of a single token', () => {
      expect(initialsOf('bob')).toBe('BO');
      expect(initialsOf('x')).toBe('X');
    });
    it('returns a placeholder for blank input', () => {
      expect(initialsOf('   ')).toBe('?');
    });
  });

  const row = (over: Partial<AuditReviewRow>): AuditReviewRow => ({
    id: 'rev-1',
    deal_id: '00000000-0000-4000-8000-000000000001',
    action: 'approve',
    approver: 'alice@dealroute',
    reason: null,
    decided_at: '2026-06-19T08:00:00.000Z',
    deal_service: null,
    deal_provider: null,
    ...over,
  });

  it('toAuditEntry maps a review row into the panel entry shape', () => {
    expect(
      toAuditEntry(
        row({ action: 'reject', deal_service: 'Audible', deal_provider: 'Amazon Prime' }),
      ),
    ).toEqual({
      id: 'rev-1',
      initials: 'AL',
      actor: 'alice@dealroute',
      action: 'reject',
      detail: 'Audible · Amazon Prime',
      entity_id: '00000000-0000-4000-8000-000000000001',
      at: '2026-06-19T08:00:00.000Z',
    });
  });

  describe('detail label (ACR-7) — the deal "<service> · <provider>", not the reason', () => {
    it('an APPROVE row (no reason) gets the deal label, not a blank', () => {
      // The regression: approvals carry no `reason`, so `detail` used to be null and
      // the panel row showed only a UUID. It must now read "<service> · <provider>".
      expect(toAuditEntry(row({ deal_service: 'Deezer', deal_provider: 'Orange' })).detail).toBe(
        'Deezer · Orange',
      );
    });

    it('the deal label wins over a present reason (reject rows show the deal, per the fixture)', () => {
      const entry = toAuditEntry(
        row({
          action: 'reject',
          reason: 'evidence missing',
          deal_service: 'Max',
          deal_provider: 'AT&T',
        }),
      );
      expect(entry.detail).toBe('Max · AT&T');
    });

    it('falls back to service alone, then to the reason, then null', () => {
      expect(toAuditEntry(row({ deal_service: 'Spotify', deal_provider: null })).detail).toBe(
        'Spotify',
      );
      expect(toAuditEntry(row({ action: 'reject', reason: 'dupe' })).detail).toBe('dupe');
      expect(toAuditEntry(row({})).detail).toBeNull();
    });
  });
});
