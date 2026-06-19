import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `review list` / `review approve <id> <approver>` / `review reject <id> <approver>` /
 * `review proposals` / `review manual` — the CLI half of the human-in-the-loop.
 * The HTTP review API exposes the same actions for the future admin panel.
 */
export type ReviewArgs =
  | { action: 'list' }
  | { action: 'approve'; dealId: string; approver: string }
  | { action: 'reject'; dealId: string; approver: string }
  | { action: 'proposals' }
  | { action: 'manual' };

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
    }
  } finally {
    await container.shutdown();
  }
}
