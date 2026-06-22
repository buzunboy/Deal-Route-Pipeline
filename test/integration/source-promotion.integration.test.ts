import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Pre-Phase-C source-promotion loop, end to end through the REAL composition root
 * + REAL Postgres: discovery proposes a novel domain → it lands as a
 * `pending_approval` source → a human approves it → it becomes `active` (and shows
 * up in listDue, i.e. crawlable) with an audit row. Closes the loop that was
 * previously a dead end.
 */
const START = 'https://www.mydealz.de/gruppe/spotify';
const OFF_DOMAIN = 'https://www.telekom.de/magenta-disney';

const suite = hasDb ? describe : describe.skip;

suite('source-promotion loop (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('discover proposes a novel domain → approve → active + crawlable + audited', async () => {
    container = makeContainer({
      // The start page links off-domain → discovery proposes that domain.
      fetcher: new ScriptedFetcher({
        [START]: { text: 'leads', html: `<a href="${OFF_DOMAIN}">deal</a>` },
      }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
    });

    // 1) Discovery surfaces the novel domain as a pending_approval source.
    const result = await container.discoverSite.execute({
      startUrl: START,
      maxPages: 5,
      budget: { maxSteps: 5, maxSeconds: 300, maxCostEur: 1 },
    });
    expect(result.proposedSources.map((p) => p.url)).toContain(OFF_DOMAIN);

    const pending = await container.sourceReview.listPending();
    expect(pending).toHaveLength(1);
    const proposed = pending[0]!;
    expect(proposed.status).toBe('pending_approval');

    // It is NOT yet crawlable (pending → not in listDue).
    const dueBefore = await container.db.sources.listDue(container.clock.now(), 100);
    expect(dueBefore.map((s) => s.id)).not.toContain(proposed.id);

    // 2) A human approves it.
    const approved = await container.sourceReview.approveSource(proposed.id, 'curator@dealroute');
    expect(approved.status).toBe('active');

    // 3) Now it IS crawlable (active + next_due=null → due now).
    const dueAfter = await container.db.sources.listDue(container.clock.now(), 100);
    expect(dueAfter.map((s) => s.id)).toContain(proposed.id);

    // 4) The decision is in the append-only audit log.
    const history = await container.sourceReview.listReviews(proposed.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: 'approve', approver: 'curator@dealroute' });
  });

  it('a rejected domain is never re-proposed by a later discovery run', async () => {
    // Seed the off-domain as already rejected.
    container = makeContainer({
      fetcher: new ScriptedFetcher({
        [START]: { text: 'leads', html: `<a href="${OFF_DOMAIN}">deal</a>` },
      }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
    });
    // First run proposes it; reject it.
    await container.discoverSite.execute({
      startUrl: START,
      maxPages: 5,
      budget: { maxSteps: 5, maxSeconds: 300, maxCostEur: 1 },
    });
    const proposed = (await container.sourceReview.listPending())[0]!;
    await container.sourceReview.rejectSource(proposed.id, 'curator', 'irrelevant');

    // Second discovery run must NOT re-create a pending source for the rejected
    // domain. (Dedup is applied at PERSISTENCE — knownDomains() includes
    // 'rejected' — not in the returned proposedSources array, matching the
    // discover-site unit test's contract.)
    await container.discoverSite.execute({
      startUrl: START,
      maxPages: 5,
      budget: { maxSteps: 5, maxSeconds: 300, maxCostEur: 1 },
    });
    expect(await container.sourceReview.listPending()).toHaveLength(0);
    // The rejected source stays rejected (not resurrected to pending).
    expect((await container.db.sources.getById(proposed.id))!.status).toBe('rejected');
  });

  it('createSource registers an active source + listRegistry shows it, over real SQL (ACR-10)', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
    });
    const { source, created } = await container.sourceReview.createSource({
      approver: 'curator',
      domain: 'netflix.com',
      kind: 'Provider',
      tier: 1,
    });
    expect(created).toBe(true);
    // persisted active, with a pinned registrable_domain + default DE market.
    const stored = (await container.db.sources.getById(source.id))!;
    expect(stored.status).toBe('active');
    expect(stored.country).toBe('DE');
    expect(stored.registrable_domain).toBe('netflix.com');

    // appears in the registry, projected + status-mapped; pending-queue is empty.
    const registry = await container.sourceReview.listRegistry();
    const row = registry.find((r) => r.domain === 'netflix.com')!;
    expect(row.kind).toBe('Provider');
    expect(row.status).toBe('active'); // reliability 0.5 > degraded threshold
    expect(await container.sourceReview.listPending()).toHaveLength(0);
  });
});
