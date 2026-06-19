import { describe, it, expect } from 'vitest';
import { parseTriageResult } from './triage-result.js';
import { BoundaryValidationError } from '../errors/index.js';

describe('parseTriageResult', () => {
  it('parses a valid triage verdict (object or JSON string)', () => {
    const obj = { relevant: true, service: 'Disney+', reason: 'bundle' };
    expect(parseTriageResult(obj)).toEqual(obj);
    expect(parseTriageResult(JSON.stringify(obj))).toEqual(obj);
  });

  it('defaults service to null and reason to "" when omitted', () => {
    expect(parseTriageResult({ relevant: false })).toEqual({
      relevant: false,
      service: null,
      reason: '',
    });
  });

  it('accepts null reason (model sent it explicitly)', () => {
    expect(parseTriageResult({ relevant: true, service: 'X', reason: null }).reason).toBe('');
  });

  it('rejects non-JSON text at the boundary', () => {
    expect(() => parseTriageResult('not json at all')).toThrow(BoundaryValidationError);
  });

  it('rejects a missing `relevant` field', () => {
    expect(() => parseTriageResult({ service: 'X' })).toThrow(BoundaryValidationError);
  });

  it('rejects `relevant` of the wrong type (string, not boolean)', () => {
    expect(() => parseTriageResult({ relevant: 'yes' })).toThrow(BoundaryValidationError);
  });

  it('does NOT tolerate prose-wrapped JSON (boundary parser is strict)', () => {
    // The LLM adapter recovers fenced/prose-wrapped JSON; the domain parser itself
    // must reject anything that isn't clean JSON, so a bypass can't sneak through.
    expect(() => parseTriageResult('Sure! {"relevant":true}')).toThrow(BoundaryValidationError);
  });
});
