import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `review list|edit|approve|reject|proposals|promote|manual|complete-manual` (deal
 * review) plus `review sources|approve-source|reject-source` (the source-promotion
 * loop) — the CLI half of the human-in-the-loop. The HTTP review API exposes the
 * same actions for the future admin panel.
 */
export type ReviewArgs =
  | { action: 'list' }
  | { action: 'edit'; dealId: string; approver: string; patchJson: string }
  | { action: 'approve'; dealId: string; approver: string; affiliateDisclosure?: boolean }
  | { action: 'reject'; dealId: string; approver: string }
  | { action: 'proposals' }
  | {
      action: 'promote';
      suggestedKey: string;
      approver: string;
      canonicalKey: string;
      label: string;
    }
  | { action: 'manual' }
  | {
      action: 'complete-manual';
      taskId: string;
      approver: string;
      fieldsJson: string;
      evidenceJson: string;
    }
  | { action: 'sources' }
  | { action: 'approve-source'; sourceId: string; approver: string }
  | { action: 'reject-source'; sourceId: string; approver: string; reason?: string };

export async function review(config: Config, args: ReviewArgs): Promise<void> {
  const container = new Container(config, { usePersistence: true });
  try {
    switch (args.action) {
      case 'list': {
        const candidates = await container.review.listCandidates();
        console.log(`${candidates.length} candidate(s) awaiting review:\n`);
        for (const { deal, evidence } of candidates) {
          console.log(
            `  ${deal.id}  ${deal.service} via ${deal.provider}  €${deal.true_cost_monthly}/mo  conf=${deal.confidence.toFixed(2)}  evidence=${evidence?.id ?? 'MISSING'}`,
          );
        }
        break;
      }
      case 'edit': {
        const patch = parseJsonArg(args.patchJson, 'patch');
        const updated = await container.review.editCandidate(args.dealId, args.approver, patch);
        console.log(
          `Edited candidate ${updated.id} (${updated.service})  human_edited=[${updated.human_edited.join(', ')}]  status=${updated.status}`,
        );
        break;
      }
      case 'approve': {
        const updated = await container.review.approve(args.dealId, args.approver, {
          affiliateDisclosure: args.affiliateDisclosure,
        });
        console.log(
          `Approved → published: ${updated.id} (${updated.service})  affiliate_disclosure=${updated.affiliate_disclosure}`,
        );
        break;
      }
      case 'reject': {
        const updated = await container.review.reject(args.dealId, args.approver);
        console.log(`Rejected → archived: ${updated.id} (${updated.service})`);
        break;
      }
      case 'proposals': {
        const proposals = await container.review.listFieldProposals();
        console.log(`${proposals.length} open field proposal(s):\n`);
        for (const p of proposals) {
          console.log(`  ${p.suggested_key} (×${p.count})  ${p.label}`);
        }
        break;
      }
      case 'promote': {
        const entry = await container.review.promoteFieldProposal({
          approver: args.approver,
          suggestedKey: args.suggestedKey,
          canonicalKey: args.canonicalKey,
          label: args.label,
          target: 'vocabulary',
        });
        console.log(
          `Promoted "${args.suggestedKey}" → vocabulary key "${entry.key}" (aliases: ${entry.aliases.join(', ')})`,
        );
        break;
      }
      case 'manual': {
        const tasks = await container.review.listManualCaptureTasks();
        console.log(`${tasks.length} open manual-capture task(s):\n`);
        for (const t of tasks) {
          console.log(`  ${t.id}  ${t.reason}  ${t.source_url}`);
        }
        break;
      }
      case 'complete-manual': {
        const fields = parseJsonArg(args.fieldsJson, 'fields');
        const ev = parseJsonArg(args.evidenceJson, 'evidence');
        const deal = await container.review.completeManualCapture(
          args.taskId,
          args.approver,
          fields,
          {
            // Require each ref to be a string — never String()-coerce, which would turn
            // a missing field into the literal "undefined" and slip past the use-case's
            // emptiness check (parity with the HTTP path's per-field string schema).
            sourceUrl: requireStringField(ev, 'source_url'),
            screenshotRef: requireStringField(ev, 'screenshot_ref'),
            htmlRef: requireStringField(ev, 'html_ref'),
            termsRef: requireStringField(ev, 'terms_ref'),
            termsText: requireStringField(ev, 'terms_text'),
          },
        );
        console.log(
          `Manual capture completed → candidate ${deal.id} (${deal.service})  status=${deal.status}  evidence=${deal.evidence_id}`,
        );
        break;
      }
      case 'sources': {
        const pending = await container.sourceReview.listPending();
        console.log(`${pending.length} source(s) awaiting approval:\n`);
        for (const s of pending) {
          console.log(`  ${s.id}  [T${s.tier} ${s.type}]  ${s.url}`);
        }
        break;
      }
      case 'approve-source': {
        const updated = await container.sourceReview.approveSource(args.sourceId, args.approver);
        console.log(`Source approved → active: ${updated.id} (${updated.url})`);
        break;
      }
      case 'reject-source': {
        const updated = await container.sourceReview.rejectSource(
          args.sourceId,
          args.approver,
          args.reason,
        );
        console.log(`Source rejected: ${updated.id} (${updated.url})`);
        break;
      }
    }
  } finally {
    await container.shutdown();
  }
}

/** Parse a JSON CLI argument, failing loudly with context (never a silent swallow). */
function parseJsonArg(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Require a non-empty string field on a parsed JSON object — fail loudly otherwise. */
function requireStringField(obj: unknown, field: string): string {
  const v =
    obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[field] : undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`evidence.${field} must be a non-empty string.`);
  }
  return v;
}
