import type { ExtractedCandidate } from '../../application/index.js';

/** Human-readable rendering of a dry-run candidate for the CLI/skill output. */
export function formatCandidate(c: ExtractedCandidate, index: number): string {
  const d = c.deal;
  const lines: string[] = [];
  lines.push(`\n── Candidate #${index + 1} ──────────────────────────────`);
  lines.push(`  service:        ${d.service}`);
  lines.push(`  provider:       ${d.provider}`);
  lines.push(`  route_type:     ${d.route_type}`);
  lines.push(`  headline:       ${d.headline}`);
  lines.push(
    `  price:          ${d.price.amount} ${d.price.currency} / ${d.price.billing}  (true cost/mo: ${c.trueCostMonthly})`,
  );
  lines.push(`  country:        ${d.country}`);
  lines.push(`  eligibility:    new_customer_only=${d.eligibility.new_customer_only}, stackable=${d.eligibility.stackable}, plan_tier=${d.eligibility.plan_tier_required ?? '—'}`);
  lines.push(`  validity:       start=${d.validity.start ?? '—'} end=${d.validity.end ?? '—'} recheck_days=${d.validity.recheck_days}`);
  lines.push(`  confidence:     ${c.adjustedConfidence.toFixed(2)}  ${c.mustReview ? '⚠️  MUST-REVIEW' : '✅ passes gate'}`);
  lines.push(`  dedupe_key:     ${c.dedupeKey}`);

  if (d.eligibility.conditions.length || d.validity.conditions.length) {
    lines.push('  conditions:');
    for (const cond of [...d.eligibility.conditions, ...d.validity.conditions]) {
      lines.push(`    - [${cond.key}] ${cond.label}  "${truncate(cond.source_quote, 60)}"`);
    }
  }
  if (d.grounding.length) {
    lines.push('  grounding:');
    for (const g of d.grounding) {
      lines.push(`    - ${g.field}: "${truncate(g.quote, 70)}"`);
    }
  }
  if (c.failures.length) {
    lines.push('  rule failures:');
    for (const f of c.failures) {
      lines.push(`    - ${f.rule}${f.field ? ` (${f.field})` : ''}: ${f.message}`);
    }
  }
  if (c.fieldProposals.length) {
    lines.push('  field proposals (unknown conditions → never invented columns):');
    for (const p of c.fieldProposals) {
      lines.push(`    - ${p.suggested_key}: ${p.label}`);
    }
  }
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
