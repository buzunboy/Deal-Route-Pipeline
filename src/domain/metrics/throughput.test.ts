import { describe, it, expect } from 'vitest';
import { buildThroughput, ThroughputSummarySchema, type ThroughputDecision } from './throughput.js';

describe('throughput', () => {
  it('counts actions by bucket and averages latency in whole seconds', () => {
    const decisions: ThroughputDecision[] = [
      { action: 'approve', latencySeconds: 100 },
      { action: 'approve', latencySeconds: 200 },
      { action: 'reject', latencySeconds: 300 },
      { action: 'edit', latencySeconds: 60 },
    ];
    const out = buildThroughput(decisions);
    expect(out).toEqual({
      approved: 2,
      rejected: 1,
      edited: 1,
      avg_review_seconds: 165, // (100+200+300+60)/4 = 165
    });
    expect(ThroughputSummarySchema.parse(out)).toEqual(out);
  });

  it('floors a fractional average to whole seconds', () => {
    const out = buildThroughput([
      { action: 'approve', latencySeconds: 10 },
      { action: 'reject', latencySeconds: 11 },
    ]);
    expect(out.avg_review_seconds).toBe(10); // 10.5 → floor 10
  });

  it('clamps a negative latency (clock skew) to 0 before averaging', () => {
    const out = buildThroughput([
      { action: 'approve', latencySeconds: -50 },
      { action: 'approve', latencySeconds: 100 },
    ]);
    expect(out.avg_review_seconds).toBe(50); // (0 + 100)/2
  });

  it('ignores null-latency decisions in the average but still counts them', () => {
    const out = buildThroughput([
      { action: 'approve', latencySeconds: null },
      { action: 'approve', latencySeconds: 200 },
    ]);
    expect(out.approved).toBe(2);
    expect(out.avg_review_seconds).toBe(200); // only the resolvable one averages
  });

  it('returns a null average when no decision has a resolvable latency', () => {
    const out = buildThroughput([
      { action: 'reject', latencySeconds: null },
      { action: 'edit', latencySeconds: null },
    ]);
    expect(out).toEqual({ approved: 0, rejected: 1, edited: 1, avg_review_seconds: null });
  });

  it('an empty day yields all-zero counts and a null average', () => {
    expect(buildThroughput([])).toEqual({
      approved: 0,
      rejected: 0,
      edited: 0,
      avg_review_seconds: null,
    });
  });
});
