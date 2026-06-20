import { describe, it, expect } from 'vitest';
import { boundExtractionInput, MAX_EXTRACTION_INPUT_CHARS } from './extraction-input.js';

describe('boundExtractionInput', () => {
  it('passes short text through unchanged + not truncated', () => {
    const r = boundExtractionInput('a short page');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('a short page');
  });

  it('passes text exactly at the cap through unchanged', () => {
    const exact = 'x'.repeat(MAX_EXTRACTION_INPUT_CHARS);
    const r = boundExtractionInput(exact);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(exact);
  });

  it('trims text over the cap and flags it truncated', () => {
    const huge = 'y'.repeat(MAX_EXTRACTION_INPUT_CHARS + 50_000);
    const r = boundExtractionInput(huge);
    expect(r.truncated).toBe(true);
    // keeps the first MAX chars, then a visible marker (never silently cut).
    expect(r.text.startsWith('y'.repeat(MAX_EXTRACTION_INPUT_CHARS))).toBe(true);
    expect(r.text).toContain('TRUNCATED');
    // the kept page content is bounded to the cap (marker aside).
    expect(r.text.length).toBeLessThan(MAX_EXTRACTION_INPUT_CHARS + 200);
  });

  it('is deterministic', () => {
    const huge = 'z'.repeat(MAX_EXTRACTION_INPUT_CHARS + 1);
    expect(boundExtractionInput(huge)).toEqual(boundExtractionInput(huge));
  });
});
