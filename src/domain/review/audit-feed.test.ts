import { describe, it, expect } from 'vitest';
import { toAuditEntry, initialsOf } from './audit-feed.js';
import type { ReviewRecord } from './review-record.js';

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

  it('toAuditEntry maps a review row into the panel entry shape', () => {
    const review: ReviewRecord = {
      id: 'rev-1',
      deal_id: '00000000-0000-4000-8000-000000000001',
      action: 'reject',
      approver: 'alice@dealroute',
      reason: 'not a bundle',
      decided_at: '2026-06-19T08:00:00.000Z',
    };
    expect(toAuditEntry(review)).toEqual({
      id: 'rev-1',
      initials: 'AL',
      actor: 'alice@dealroute',
      action: 'reject',
      detail: 'not a bundle',
      entity_id: '00000000-0000-4000-8000-000000000001',
      at: '2026-06-19T08:00:00.000Z',
    });
  });
});
