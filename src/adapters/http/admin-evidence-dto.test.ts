import { describe, it, expect } from 'vitest';
import { toAdminEvidence } from './admin-evidence-dto.js';
import type { Evidence } from '../../domain/index.js';

const evidence: Evidence = {
  id: '11111111-1111-1111-1111-111111111111',
  source_url: 'https://vodafone.de/offer',
  screenshot_ref: '11111111-1111-1111-1111-111111111111/screenshot.png',
  html_ref: '11111111-1111-1111-1111-111111111111/page.html',
  terms_ref: '11111111-1111-1111-1111-111111111111/terms.txt',
  captured_at: '2026-06-19T00:00:00.000Z',
  content_hash: 'abc123',
};

describe('toAdminEvidence (ACR-13)', () => {
  it('adds resolved CDN URLs for screenshot + html when a base is configured', () => {
    const dto = toAdminEvidence(evidence, 'https://cdn.dealroute.example');
    expect(dto).not.toBeNull();
    expect(dto!.evidence_screenshot_url).toBe(
      'https://cdn.dealroute.example/11111111-1111-1111-1111-111111111111/screenshot.png',
    );
    expect(dto!.evidence_html_url).toBe(
      'https://cdn.dealroute.example/11111111-1111-1111-1111-111111111111/page.html',
    );
  });

  it('keeps the raw store refs (this is the reviewer console, not the public allow-list)', () => {
    const dto = toAdminEvidence(evidence, undefined)!;
    expect(dto.screenshot_ref).toBe(evidence.screenshot_ref);
    expect(dto.html_ref).toBe(evidence.html_ref);
    expect(dto.terms_ref).toBe(evidence.terms_ref);
    expect(dto.content_hash).toBe('abc123');
  });

  it('resolves URLs to null when no CDN base is set (local-fs evidence)', () => {
    const dto = toAdminEvidence(evidence, undefined)!;
    expect(dto.evidence_screenshot_url).toBeNull();
    expect(dto.evidence_html_url).toBeNull();
  });

  it('passes a null evidence bundle through unchanged', () => {
    expect(toAdminEvidence(null, 'https://cdn.example')).toBeNull();
  });
});
