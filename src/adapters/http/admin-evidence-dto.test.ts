import { describe, it, expect } from 'vitest';
import { toAdminEvidence } from './admin-evidence-dto.js';
import type { Evidence } from '../../domain/index.js';

const ID = '11111111-1111-1111-1111-111111111111';
const evidence: Evidence = {
  id: ID,
  source_url: 'https://vodafone.de/offer',
  screenshot_ref: `${ID}/screenshot.png`,
  html_ref: `${ID}/page.html`,
  terms_ref: `${ID}/terms.txt`,
  captured_at: '2026-06-19T00:00:00.000Z',
  content_hash: 'abc123',
};

describe('toAdminEvidence (ACR-13)', () => {
  it('emits gated authed-path URLs (NOT the public CDN) for all three artifacts', () => {
    const dto = toAdminEvidence(evidence);
    expect(dto).not.toBeNull();
    // Relative, keyed by (id, kind) — the authed `/api/evidence` endpoint, so html +
    // terms (which the public screenshot-only CDN 403s) are reachable to a reviewer.
    expect(dto!.evidence_screenshot_url).toBe(`/api/evidence/${ID}/screenshot`);
    expect(dto!.evidence_html_url).toBe(`/api/evidence/${ID}/html`);
    expect(dto!.evidence_terms_url).toBe(`/api/evidence/${ID}/terms`);
  });

  it('keeps the raw store refs (this is the reviewer console, not the public allow-list)', () => {
    const dto = toAdminEvidence(evidence)!;
    expect(dto.screenshot_ref).toBe(evidence.screenshot_ref);
    expect(dto.html_ref).toBe(evidence.html_ref);
    expect(dto.terms_ref).toBe(evidence.terms_ref);
    expect(dto.content_hash).toBe('abc123');
  });

  it('URLs are non-null and CDN-independent (work even with local-fs / no CDN)', () => {
    const dto = toAdminEvidence(evidence)!;
    // The authed path always resolves for a reviewer — no CDN configuration involved.
    expect(dto.evidence_screenshot_url).toContain('/api/evidence/');
    expect(dto.evidence_html_url).toContain('/api/evidence/');
    expect(dto.evidence_terms_url).toContain('/api/evidence/');
  });

  it('passes a null evidence bundle through unchanged', () => {
    expect(toAdminEvidence(null)).toBeNull();
  });
});
