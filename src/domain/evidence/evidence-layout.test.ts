import { describe, it, expect } from 'vitest';
import { evidenceScreenshotRef, evidenceHtmlRef, resolveEvidenceUrl } from './evidence-layout.js';

describe('evidence-layout refs', () => {
  it('builds the id-prefixed screenshot + html refs from the layout', () => {
    expect(evidenceScreenshotRef('ev-123')).toBe('ev-123/screenshot.png');
    expect(evidenceHtmlRef('ev-123')).toBe('ev-123/page.html');
  });
});

describe('resolveEvidenceUrl (ACR-13: admin + public share one rule)', () => {
  it('joins the CDN base and the ref without doubling slashes', () => {
    expect(resolveEvidenceUrl('ev-1/screenshot.png', 'https://cdn.example.com')).toBe(
      'https://cdn.example.com/ev-1/screenshot.png',
    );
    // trailing slash on the base + leading slash on the ref collapse to one
    expect(resolveEvidenceUrl('/ev-1/screenshot.png', 'https://cdn.example.com/')).toBe(
      'https://cdn.example.com/ev-1/screenshot.png',
    );
  });

  it('returns null when no CDN base is configured (local-fs evidence has no public URL)', () => {
    expect(resolveEvidenceUrl('ev-1/screenshot.png', undefined)).toBeNull();
    expect(resolveEvidenceUrl('ev-1/screenshot.png', '')).toBeNull();
  });
});
