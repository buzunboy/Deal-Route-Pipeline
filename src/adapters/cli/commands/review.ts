import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `review list|approve|reject|proposals|manual` (deal review) plus
 * `review sources|approve-source|reject-source` (the source-promotion loop) —
 * the CLI half of the human-in-the-loop. The HTTP review API exposes the same
 * actions for the future admin panel.
 */
export type ReviewArgs =
  | { action: 'list' }
  | { action: 'approve'; dealId: string; approver: string }
  | { action: 'reject'; dealId: string; approver: string }
  | { action: 'proposals' }
  | { action: 'manual' }
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
      case 'approve': {
        const updated = await container.review.approve(args.dealId, args.approver);
        console.log(`Approved → published: ${updated.id} (${updated.service})`);
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
      case 'manual': {
        const tasks = await container.review.listManualCaptureTasks();
        console.log(`${tasks.length} open manual-capture task(s):\n`);
        for (const t of tasks) {
          console.log(`  ${t.id}  ${t.reason}  ${t.source_url}`);
        }
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
