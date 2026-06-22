import { describe, it, expect } from 'vitest';
import type { Database } from '../../src/application/ports/index.js';
import {
  DealStatus,
  SOURCELESS_RUN_BUCKET,
  dedupeKey,
  type DealRecord,
  type CrawlRun,
  type CrawlRunKind,
} from '../../src/domain/index.js';
import { makeDealRecord } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import { randomUUID } from 'node:crypto';

/** A valid succeeded CrawlRun with a fixed started_at + cost, for cost-summary cases. */
function makeRun(
  sourceId: string | null,
  startedAt: string,
  costEur: number,
  extra: { kind?: CrawlRunKind; candidates?: number; proposals?: number } = {},
): CrawlRun {
  return {
    id: randomUUID(),
    source_id: sourceId,
    run_kind: extra.kind ?? 'crawl',
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: extra.candidates ?? 0,
    proposals_produced: extra.proposals ?? 0,
    cost_eur: costEur,
    stopped_reason: null,
    error: null,
  };
}

const dealRecord = makeDealRecord;

/**
 * Shared contract suite for the Database port. The in-memory adapter and the
 * Postgres adapter both run it, guaranteeing substitutability (LSP). The Postgres
 * run is skipped automatically when no DATABASE_URL_TEST is configured (a
 * separate var from the runtime DATABASE_URL, since the suite mutates rows).
 */
export function databaseContract(name: string, makeDb: () => Promise<Database> | Database): void {
  describe(`Database contract: ${name}`, () => {
    it('sources: upsert, getById, listDue honours next_due and active status', async () => {
      const db = await makeDb();
      // Distinct URLs: these are three DIFFERENT sources (url is the natural key now).
      const due = makeSource({
        url: 'https://a.de',
        status: 'active',
        next_due: '2020-01-01T00:00:00.000Z',
      });
      const future = makeSource({
        url: 'https://b.de',
        status: 'active',
        next_due: '2999-01-01T00:00:00.000Z',
      });
      const disabled = makeSource({ url: 'https://c.de', status: 'disabled', next_due: null });
      await db.sources.upsert(due);
      await db.sources.upsert(future);
      await db.sources.upsert(disabled);

      const dueList = await db.sources.listDue(new Date('2026-06-19T00:00:00.000Z'), 10);
      const ids = dueList.map((s) => s.id);
      expect(ids).toContain(due.id);
      expect(ids).not.toContain(future.id);
      expect(ids).not.toContain(disabled.id);
    });

    it('sources: resolved_url round-trips — a set value and a null both survive (Prereq A)', async () => {
      const db = await makeDb();
      const resolved = makeSource({
        url: 'https://r.de',
        resolved_url: 'https://www.telekom.de/final',
      });
      const unresolved = makeSource({ url: 'https://u.de', resolved_url: null });
      await db.sources.upsert(resolved);
      await db.sources.upsert(unresolved);
      expect((await db.sources.getById(resolved.id))!.resolved_url).toBe(
        'https://www.telekom.de/final',
      );
      expect((await db.sources.getById(unresolved.id))!.resolved_url).toBeNull();
      // update() also persists a newly-set resolved_url (the crawl/monitor write path).
      await db.sources.update({ ...unresolved, resolved_url: 'https://www.x.de/r' });
      expect((await db.sources.getById(unresolved.id))!.resolved_url).toBe('https://www.x.de/r');
    });

    it('sources: upsert is idempotent on url — re-importing the same URL does NOT duplicate', async () => {
      // Regression: seed-import mints a fresh id per run, so an id-keyed upsert
      // INSERTed a duplicate row on every re-seed (observed 49 -> 98 in prod). The
      // upsert must conflict on `url` (the natural key) so a re-import with a NEW id
      // updates the existing row in place. Two makeSource() calls = same default url,
      // different ids — exactly the re-seed scenario.
      const db = await makeDb();
      const first = makeSource({ url: 'https://www.netflix.com/de', tier: 1 });
      const second = makeSource({ url: 'https://www.netflix.com/de', tier: 2 });
      expect(first.id).not.toBe(second.id);

      await db.sources.upsert(first);
      await db.sources.upsert(second);

      const all = await db.sources.listByStatus(first.status);
      const sameUrl = all.filter((s) => s.url === 'https://www.netflix.com/de');
      expect(sameUrl).toHaveLength(1); // one row, not two
      // The conflicting fields were updated (tier 1 -> 2)...
      expect(sameUrl[0]!.tier).toBe(2);
      // ...and the row kept its ORIGINAL id (the first insert wins identity).
      expect(sameUrl[0]!.id).toBe(first.id);
    });

    it('deals: insert, getById, listByStatus, updateStatus', async () => {
      const db = await makeDb();
      const deal = dealRecord();
      await db.deals.insert(deal);
      expect((await db.deals.getById(deal.id))!.service).toBe(deal.service);
      expect(await db.deals.listByStatus(DealStatus.enum.candidate, 10)).toHaveLength(1);

      await db.deals.updateStatus(
        deal.id,
        DealStatus.enum.published,
        'reviewer',
        '2026-06-19T00:00:00Z',
      );
      expect((await db.deals.getById(deal.id))!.status).toBe('published');
      expect((await db.deals.getById(deal.id))!.verified_by).toBe('reviewer');
    });

    it('deals: prepaid price round-trips (amount + billing + prepaid_months)', async () => {
      // The prepaid-term column (schema v2) must survive write→read in both adapters
      // (LSP), incl. the domain-undefined ↔ DB-null mapping. A monthly deal reads back
      // with no prepaid_months; a prepaid deal preserves its stated term.
      const db = await makeDb();
      const prepaid = dealRecord({
        price: { amount: 49.19, currency: 'EUR', billing: 'prepaid', prepaid_months: 24 },
      });
      const monthly = dealRecord({
        price: { amount: 9.99, currency: 'EUR', billing: 'monthly' },
      });
      await db.deals.insert(prepaid);
      await db.deals.insert(monthly);

      const readPrepaid = (await db.deals.getById(prepaid.id))!;
      expect(readPrepaid.price.billing).toBe('prepaid');
      expect(readPrepaid.price.amount).toBe(49.19);
      expect(readPrepaid.price.prepaid_months).toBe(24);

      const readMonthly = (await db.deals.getById(monthly.id))!;
      expect(readMonthly.price.billing).toBe('monthly');
      expect(readMonthly.price.prepaid_months).toBeUndefined();
    });

    it('deals: disclosure fields round-trip (affiliate_disclosure + published_at, schema v3)', async () => {
      // Step-2 columns must survive write→read in both adapters (LSP), incl. the
      // published_at timestamptz→ISO-Z normalisation and the boolean.
      const db = await makeDb();
      const published = dealRecord({
        status: DealStatus.enum.published,
        affiliate_disclosure: false,
        published_at: '2026-06-19T12:00:00.000Z',
      });
      const candidate = dealRecord({ status: DealStatus.enum.candidate }); // defaults
      await db.deals.insert(published);
      await db.deals.insert(candidate);

      const readPub = (await db.deals.getById(published.id))!;
      expect(readPub.affiliate_disclosure).toBe(false);
      expect(readPub.published_at).toBe('2026-06-19T12:00:00.000Z');

      const readCand = (await db.deals.getById(candidate.id))!;
      expect(readCand.affiliate_disclosure).toBe(true); // schema default
      expect(readCand.published_at).toBeNull();
    });

    it('deals: findByDedupeKey ignores rejected and matches the canonical key', async () => {
      const db = await makeDb();
      const deal = dealRecord();
      await db.deals.insert(deal);
      const { dedupeKey } = await import('../../src/domain/index.js');
      const found = await db.deals.findByDedupeKey(dedupeKey(deal, deal.source_registrable_domain));
      expect(found!.id).toBe(deal.id);

      await db.deals.updateStatus(deal.id, DealStatus.enum.rejected, 'r', 't');
      expect(
        await db.deals.findByDedupeKey(dedupeKey(deal, deal.source_registrable_domain)),
      ).toBeNull();
    });

    it('deals: listBySourceUrl is source-scoped + status-filtered', async () => {
      const db = await makeDb();
      const a = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.published });
      const b = dealRecord({ source_url: 'https://b.de/y', status: DealStatus.enum.published });
      const aCand = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.candidate });
      await db.deals.insert(a);
      await db.deals.insert(b);
      await db.deals.insert(aCand);

      const pub = await db.deals.listBySourceUrl('https://a.de/x', [DealStatus.enum.published], 10);
      expect(pub.map((d) => d.id)).toEqual([a.id]); // only a.de + published

      const both = await db.deals.listBySourceUrl(
        'https://a.de/x',
        [DealStatus.enum.published, DealStatus.enum.candidate],
        10,
      );
      expect(both.map((d) => d.id).sort()).toEqual([a.id, aCand.id].sort());
    });

    it('deals: expirePublishedBySourceUrl expires only that source’s published deals', async () => {
      const db = await makeDb();
      const a1 = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.published });
      const a2 = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.candidate });
      const b1 = dealRecord({ source_url: 'https://b.de/y', status: DealStatus.enum.published });
      await db.deals.insert(a1);
      await db.deals.insert(a2);
      await db.deals.insert(b1);

      const n = await db.deals.expirePublishedBySourceUrl('https://a.de/x', '2026-06-19T00:00:00Z');
      expect(n).toBe(1);
      expect((await db.deals.getById(a1.id))!.status).toBe('expired');
      expect((await db.deals.getById(a2.id))!.status).toBe('candidate'); // not published → untouched
      expect((await db.deals.getById(b1.id))!.status).toBe('published'); // other source → untouched
    });

    it('deals: findActiveByDedupeKeyAndHash matches a queued candidate by its evidence hash', async () => {
      const db = await makeDb();
      const { dedupeKey } = await import('../../src/domain/index.js');
      const ev = {
        id: randomUUID(),
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: '2026-06-19T00:00:00.000Z',
        content_hash: 'HASH_A',
      };
      await db.evidence.insert(ev);
      const deal = dealRecord({ evidence_id: ev.id, status: DealStatus.enum.candidate });
      await db.deals.insert(deal);
      const key = dedupeKey(deal, deal.source_registrable_domain);

      expect((await db.deals.findActiveByDedupeKeyAndHash(key, 'HASH_A'))!.id).toBe(deal.id);
      expect(await db.deals.findActiveByDedupeKeyAndHash(key, 'OTHER_HASH')).toBeNull();
    });

    it('evidence: insert + getById; unknown id returns null', async () => {
      const db = await makeDb();
      const ev = {
        id: randomUUID(),
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: '2026-06-19T00:00:00.000Z',
        content_hash: 'abc',
      };
      await db.evidence.insert(ev);
      expect((await db.evidence.getById(ev.id))!.content_hash).toBe('abc');
      expect(await db.evidence.getById(randomUUID())).toBeNull();
    });

    it('manualCapture: insert + listOpen', async () => {
      const db = await makeDb();
      await db.manualCapture.insert({
        id: randomUUID(),
        source_id: randomUUID(),
        source_url: 'https://x.de',
        reason: 'login_required',
        created_at: '2026-06-19T00:00:00.000Z',
        status: 'open',
        note: null,
      });
      expect(await db.manualCapture.listOpen(10)).toHaveLength(1);
    });

    it('fieldProposals: upsertAndCount increments on repeat', async () => {
      const db = await makeDb();
      const base = {
        suggested_key: 'requires_pet',
        label: 'Pet required',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      };
      await db.fieldProposals.upsertAndCount(base);
      await db.fieldProposals.upsertAndCount(base);
      const proposals = await db.fieldProposals.listOpen(10);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.count).toBe(2);
    });

    it('fieldProposals: a later sighting preserves first_seen_at and advances last_seen_at', async () => {
      // The upsert is a single SQL statement (count = count + 1); first_seen_at is
      // set only on the insert branch, so a concurrent/repeat sighting must never
      // overwrite it — it is the "recurring since" signal the promotion loop reads.
      const db = await makeDb();
      const base = {
        suggested_key: 'requires_pet',
        label: 'Pet required',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      };
      await db.fieldProposals.upsertAndCount(base);
      await db.fieldProposals.upsertAndCount({
        ...base,
        // A later sighting carries a newer last_seen and a (wrongly) newer
        // first_seen — the store must keep the ORIGINAL first_seen_at.
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-01T00:00:00.000Z',
      });
      const proposals = await db.fieldProposals.listOpen(10);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.count).toBe(2);
      // Compare by instant, not by exact text: Postgres returns a timestamptz as
      // `2026-06-19 00:00:00+00` (space/offset), the in-memory store echoes the ISO
      // input — both denote the same moment, which is what the invariant is about.
      expect(new Date(proposals[0]!.first_seen_at).toISOString()).toBe('2026-06-19T00:00:00.000Z');
      expect(new Date(proposals[0]!.last_seen_at).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    // deals.listPublished + countPublished — the public read feed. The shared
    // Postgres DB persists rows ACROSS cases, so each case tags its deals with a
    // unique `service` and filters by it, so other cases' rows can't pollute the
    // result set. This block is the LSP proof: identical filter/sort/paginate in
    // both adapters.
    describe('deals.listPublished + countPublished', () => {
      it('serves ONLY published deals — never candidate/in_review/expired/rejected', async () => {
        const db = await makeDb();
        const service = `svc-pub-only-${randomUUID()}`;
        const pub = dealRecord({ service, status: DealStatus.enum.published });
        await db.deals.insert(pub);
        for (const status of [
          DealStatus.enum.candidate,
          DealStatus.enum.in_review,
          DealStatus.enum.expired,
          DealStatus.enum.rejected,
        ]) {
          await db.deals.insert(dealRecord({ ...sameRoute(pub), service, status }));
        }
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        expect(out.map((d) => d.id)).toEqual([pub.id]);
        expect(out.every((d) => d.status === 'published')).toBe(true);
        expect(await db.deals.countPublished({ service })).toBe(1);
      });

      it('filters by country, route_type and priceMax (inclusive), AND-ed', async () => {
        const db = await makeDb();
        const service = `svc-filter-${randomUUID()}`;
        const base = { service, status: DealStatus.enum.published, country: 'DE' as const };
        const cheapBundle = dealRecord({ ...base, route_type: 'bundle', true_cost_monthly: 5 });
        const dearBundle = dealRecord({ ...base, route_type: 'bundle', true_cost_monthly: 30 });
        const promo = dealRecord({ ...base, route_type: 'promo', true_cost_monthly: 5 });
        await db.deals.insert(cheapBundle);
        await db.deals.insert(dearBundle);
        await db.deals.insert(promo);

        // route_type=bundle AND priceMax=10 → only the cheap bundle (10 is inclusive,
        // dear bundle 30 excluded, promo wrong route).
        const out = await db.deals.listPublished({
          filters: { service, routeType: 'bundle', priceMax: 10 },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        expect(out.map((d) => d.id)).toEqual([cheapBundle.id]);
        expect(await db.deals.countPublished({ service, routeType: 'bundle', priceMax: 10 })).toBe(
          1,
        );

        // priceMax exactly at a deal's cost is inclusive.
        expect(await db.deals.countPublished({ service, priceMax: 5 })).toBe(2); // cheapBundle + promo
        expect(await db.deals.countPublished({ service, priceMax: 30 })).toBe(3); // all three
      });

      it('sorts cost_asc by true_cost_monthly, then id ascending (stable)', async () => {
        const db = await makeDb();
        const service = `svc-cost-${randomUUID()}`;
        const mid = dealRecord({
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 20,
        });
        const cheap = dealRecord({
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 5,
        });
        const dear = dealRecord({
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 40,
        });
        await db.deals.insert(mid);
        await db.deals.insert(cheap);
        await db.deals.insert(dear);
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        expect(out.map((d) => d.true_cost_monthly)).toEqual([5, 20, 40]);
      });

      it('sorts verified_desc by verified_at (newest first), nulls last, then id', async () => {
        const db = await makeDb();
        const service = `svc-verif-${randomUUID()}`;
        const old = dealRecord({
          service,
          status: DealStatus.enum.published,
          verified_at: '2026-01-01T00:00:00.000Z',
        });
        const recent = dealRecord({
          service,
          status: DealStatus.enum.published,
          verified_at: '2026-06-01T00:00:00.000Z',
        });
        const unverified = dealRecord({
          service,
          status: DealStatus.enum.published,
          verified_at: null,
        });
        await db.deals.insert(old);
        await db.deals.insert(recent);
        await db.deals.insert(unverified);
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'verified_desc',
          limit: 50,
          offset: 0,
        });
        // newest verified first, the null-verified deal sorts LAST (least fresh).
        expect(out.map((d) => d.id)).toEqual([recent.id, old.id, unverified.id]);
      });

      it('breaks ties by id ascending so equal-cost/equal-verified rows order identically', async () => {
        // Equal sort keys must fall through to the id tiebreaker IDENTICALLY in both
        // adapters, else offset pagination would skip/repeat across the two. Use the
        // SAME cost and the SAME verified_at across rows so only the tiebreaker decides.
        const db = await makeDb();
        const service = `svc-tie-${randomUUID()}`;
        const ids = [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
        ];
        // Insert out of id order to prove ordering isn't insertion order.
        for (const id of [ids[2]!, ids[0]!, ids[1]!]) {
          await db.deals.insert(
            dealRecord({
              id,
              service,
              status: DealStatus.enum.published,
              true_cost_monthly: 10,
              verified_at: '2026-06-01T00:00:00.000Z',
            }),
          );
        }
        const byCost = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        expect(byCost.map((d) => d.id)).toEqual(ids); // id ascending
        const byVerified = await db.deals.listPublished({
          filters: { service },
          sort: 'verified_desc',
          limit: 50,
          offset: 0,
        });
        expect(byVerified.map((d) => d.id)).toEqual(ids); // equal verified_at → id ascending
      });

      it('paginates with limit + offset over the stable order without gaps/repeats', async () => {
        const db = await makeDb();
        const service = `svc-page-${randomUUID()}`;
        // Five published deals with distinct ascending costs.
        const costs = [1, 2, 3, 4, 5];
        for (const c of costs) {
          await db.deals.insert(
            dealRecord({ service, status: DealStatus.enum.published, true_cost_monthly: c }),
          );
        }
        const page1 = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 2,
          offset: 0,
        });
        const page2 = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 2,
          offset: 2,
        });
        const page3 = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 2,
          offset: 4,
        });
        expect(page1.map((d) => d.true_cost_monthly)).toEqual([1, 2]);
        expect(page2.map((d) => d.true_cost_monthly)).toEqual([3, 4]);
        expect(page3.map((d) => d.true_cost_monthly)).toEqual([5]);
        // No id appears on two pages.
        const ids = [...page1, ...page2, ...page3].map((d) => d.id);
        expect(new Set(ids).size).toBe(5);
        expect(await db.deals.countPublished({ service })).toBe(5);
      });

      // Step 3 — reliability-blended ranking. A source's reliability_score breaks
      // ties on the primary key (cost / freshness), resolved by REGISTRABLE-DOMAIN
      // join of deal.source_url ↔ source.url. These are the LSP proof for the
      // tiebreaker: identical id order across in-memory ↔ Postgres.
      //
      // NB the >PUBLISHED_FETCH_CAP symmetry (both adapters take the same capped
      // candidate set when the published corpus exceeds the 10,100-row fetch cap) is
      // NOT seeded here — that many rows is impractical in the integration tier. It's
      // pinned in the pure unit tier instead (`capByPrimary` in
      // `src/domain/deal-record/published-ranking.test.ts`), and holds by
      // construction: both adapters fetch in the SAME primary order then call the
      // SAME `rankPublished`. These cases cover the tiebreaker semantics + pagination.
      it('breaks an equal-cost tie by source reliability DESC (registrable-domain join), then id', async () => {
        const db = await makeDb();
        const service = `svc-rel-cost-${randomUUID()}`;
        // Two active sources on distinct registrable domains, different reliability.
        await db.sources.upsert(makeSource({ url: 'https://high-rel.de', reliability_score: 0.9 }));
        await db.sources.upsert(makeSource({ url: 'https://low-rel.de', reliability_score: 0.1 }));
        // Deals scraped at DEEP/subdomain paths of each source — the join must fold
        // them to the source's registrable domain (finalUrl ≠ canonical url is normal).
        const hiA = dealRecord({
          id: '00000000-0000-4000-8000-0000000000a1',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://www.high-rel.de/offer/a',
        });
        const hiB = dealRecord({
          id: '00000000-0000-4000-8000-0000000000a2',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://high-rel.de/offer/b',
        });
        const lo = dealRecord({
          id: '00000000-0000-4000-8000-0000000000b1',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://shop.low-rel.de/x',
        });
        // A deal whose registrable domain matches NO active source → neutral 0.5,
        // so it sorts BETWEEN the high-reliability and low-reliability sources.
        const neutral = dealRecord({
          id: '00000000-0000-4000-8000-0000000000c1',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://no-such-source.de/y',
        });
        for (const d of [lo, neutral, hiB, hiA]) await db.deals.insert(d); // insert out of order
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        // high (id asc within the tie), then neutral 0.5, then low.
        expect(out.map((d) => d.id)).toEqual([hiA.id, hiB.id, neutral.id, lo.id]);
        // countPublished is order-invariant — reliability never changes the set.
        expect(await db.deals.countPublished({ service })).toBe(4);
      });

      it('breaks an equal-verified_at tie by source reliability DESC, then id', async () => {
        const db = await makeDb();
        const service = `svc-rel-verif-${randomUUID()}`;
        await db.sources.upsert(makeSource({ url: 'https://hi.de', reliability_score: 0.8 }));
        await db.sources.upsert(makeSource({ url: 'https://lo.de', reliability_score: 0.2 }));
        const when = '2026-06-01T00:00:00.000Z';
        const hi = dealRecord({
          id: '00000000-0000-4000-8000-0000000000d1',
          service,
          status: DealStatus.enum.published,
          verified_at: when,
          source_url: 'https://hi.de/a',
        });
        const lo = dealRecord({
          id: '00000000-0000-4000-8000-0000000000d2',
          service,
          status: DealStatus.enum.published,
          verified_at: when,
          source_url: 'https://lo.de/b',
        });
        for (const d of [lo, hi]) await db.deals.insert(d);
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'verified_desc',
          limit: 50,
          offset: 0,
        });
        expect(out.map((d) => d.id)).toEqual([hi.id, lo.id]);
      });

      it('preserves a reliability score of 0 (a distrusted source sorts below neutral)', async () => {
        const db = await makeDb();
        const service = `svc-rel-zero-${randomUUID()}`;
        // A deliberately-distrusted source (score 0) must NOT float up to neutral 0.5.
        await db.sources.upsert(makeSource({ url: 'https://distrusted.de', reliability_score: 0 }));
        const distrusted = dealRecord({
          id: '00000000-0000-4000-8000-0000000000e1',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://distrusted.de/x',
        });
        // No source row → neutral 0.5.
        const neutral = dealRecord({
          id: '00000000-0000-4000-8000-0000000000e2',
          service,
          status: DealStatus.enum.published,
          true_cost_monthly: 10,
          source_url: 'https://unknown.de/y',
        });
        for (const d of [distrusted, neutral]) await db.deals.insert(d);
        const out = await db.deals.listPublished({
          filters: { service },
          sort: 'cost_asc',
          limit: 50,
          offset: 0,
        });
        // neutral (0.5) before distrusted (0) — proves 0 is NOT coerced to 0.5.
        expect(out.map((d) => d.id)).toEqual([neutral.id, distrusted.id]);
      });

      it('reliability tiebreak is stable under limit+offset pagination (no gaps/repeats)', async () => {
        // Six equal-cost deals across a high- and low-reliability source. The full
        // order is high(id asc) then low(id asc); paginating it in pages of 2 must
        // surface every row exactly once, identically across adapters. This guards
        // the seam the tiebreaker could break (a tie-group straddling a page edge).
        const db = await makeDb();
        const service = `svc-rel-page-${randomUUID()}`;
        await db.sources.upsert(makeSource({ url: 'https://hi.de', reliability_score: 0.9 }));
        await db.sources.upsert(makeSource({ url: 'https://lo.de', reliability_score: 0.1 }));
        const ids = [
          '00000000-0000-4000-8000-000000000f01',
          '00000000-0000-4000-8000-000000000f02',
          '00000000-0000-4000-8000-000000000f03',
          '00000000-0000-4000-8000-000000000f04',
          '00000000-0000-4000-8000-000000000f05',
          '00000000-0000-4000-8000-000000000f06',
        ];
        // hi gets f01/f03/f05; lo gets f02/f04/f06 — interleaved ids so the order is
        // decided by reliability first, then id, NOT by id alone or insertion order.
        const insert = async (id: string, host: string) =>
          db.deals.insert(
            dealRecord({
              id,
              service,
              status: DealStatus.enum.published,
              true_cost_monthly: 10,
              source_url: `https://${host}/x`,
            }),
          );
        await insert(ids[1]!, 'lo.de');
        await insert(ids[0]!, 'hi.de');
        await insert(ids[5]!, 'lo.de');
        await insert(ids[4]!, 'hi.de');
        await insert(ids[3]!, 'lo.de');
        await insert(ids[2]!, 'hi.de');
        // Expected: hi (f01,f03,f05) then lo (f02,f04,f06).
        const expected = [ids[0]!, ids[2]!, ids[4]!, ids[1]!, ids[3]!, ids[5]!];
        const page = async (offset: number) =>
          (
            await db.deals.listPublished({
              filters: { service },
              sort: 'cost_asc',
              limit: 2,
              offset,
            })
          ).map((d) => d.id);
        expect(await page(0)).toEqual(expected.slice(0, 2));
        expect(await page(2)).toEqual(expected.slice(2, 4));
        expect(await page(4)).toEqual(expected.slice(4, 6));
        const all = [...(await page(0)), ...(await page(2)), ...(await page(4))];
        expect(new Set(all).size).toBe(6); // no gaps, no repeats across pages
      });
    });

    it('deals: findByDedupeKey returns the highest-confidence match (canonical)', async () => {
      const db = await makeDb();
      const { dedupeKey } = await import('../../src/domain/index.js');
      const low = dealRecord({ confidence: 0.4 });
      const high = dealRecord({ ...sameRoute(low), confidence: 0.9 });
      await db.deals.insert(low);
      await db.deals.insert(high);
      // Both share a dedupe key; the canonical (highest-confidence) one must win,
      // regardless of insertion order — so the two adapters don't diverge here.
      const found = await db.deals.findByDedupeKey(dedupeKey(low, low.source_registrable_domain));
      expect(found!.id).toBe(high.id);
    });

    it('changes: insert + recentForSource returns newest-first, scoped to the source', async () => {
      const db = await makeDb();
      const sourceId = randomUUID();
      const other = randomUUID();
      await db.changes.insert(makeChange(sourceId, 'unchanged', '2026-06-17T00:00:00.000Z'));
      await db.changes.insert(makeChange(sourceId, 'disappeared', '2026-06-19T00:00:00.000Z'));
      await db.changes.insert(makeChange(other, 'blocked', '2026-06-20T00:00:00.000Z'));

      const recent = await db.changes.recentForSource(sourceId, 10);
      expect(recent.map((c) => c.kind)).toEqual(['disappeared', 'unchanged']);
      expect(recent.every((c) => c.source_id === sourceId)).toBe(true);
    });

    it('reviews: insert + listForDeal returns newest-first, scoped to the deal', async () => {
      const db = await makeDb();
      const dealId = randomUUID();
      const other = randomUUID();
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: dealId,
        action: 'reject',
        approver: 'r1',
        reason: 'not a bundle',
        decided_at: '2026-06-17T00:00:00.000Z',
      });
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: dealId,
        action: 'approve',
        approver: 'r2',
        reason: null,
        decided_at: '2026-06-19T00:00:00.000Z',
      });
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: other,
        action: 'approve',
        approver: 'r3',
        reason: null,
        decided_at: '2026-06-20T00:00:00.000Z',
      });

      const history = await db.reviews.listForDeal(dealId, 10);
      expect(history.map((r) => r.action)).toEqual(['approve', 'reject']);
      expect(history.every((r) => r.deal_id === dealId)).toBe(true);
      expect(history[1]!.reason).toBe('not a bundle');
    });

    it('sourceReviews: insert + listForSource returns newest-first, scoped to the source', async () => {
      const db = await makeDb();
      const sourceId = randomUUID();
      const other = randomUUID();
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: sourceId,
        action: 'reject',
        approver: 's1',
        reason: 'parked',
        decided_at: '2026-06-17T00:00:00.000Z',
      });
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: sourceId,
        action: 'approve',
        approver: 's2',
        reason: null,
        decided_at: '2026-06-19T00:00:00.000Z',
      });
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: other,
        action: 'approve',
        approver: 's3',
        reason: null,
        decided_at: '2026-06-20T00:00:00.000Z',
      });

      const history = await db.sourceReviews.listForSource(sourceId, 10);
      expect(history.map((r) => r.action)).toEqual(['approve', 'reject']);
      expect(history.every((r) => r.source_id === sourceId)).toBe(true);
      expect(history[1]!.reason).toBe('parked');
    });

    // crawlRuns.costSummary — the shared Postgres DB persists rows ACROSS cases, so
    // each case scopes its assertions to its own randomUUID() source_ids and bounds
    // the window to its own far-out timestamps. We assert per_source for our own ids
    // and never on the global total/run_count, so other cases' rows can't pollute.
    describe('crawlRuns.costSummary', () => {
      it('(a) empty window → zeros + empty arrays, never throws', async () => {
        const db = await makeDb();
        // A window in a deserted far-future range no other case writes into.
        const summary = await db.crawlRuns.costSummary({
          since: new Date('2400-01-01T00:00:00.000Z'),
          until: new Date('2400-01-02T00:00:00.000Z'),
        });
        expect(summary).toEqual({ total_eur: 0, run_count: 0, per_day: [], per_source: [] });
      });

      it('(b) rolls up across UTC days + sources: per_day asc, per_source cost-desc', async () => {
        const db = await makeDb();
        const srcA = randomUUID();
        const srcB = randomUUID();
        // Dedicated 2-day window in 2200 so the shared DB can't pollute these ids.
        const since = new Date('2200-03-01T00:00:00.000Z');
        const until = new Date('2200-03-03T00:00:00.000Z');
        // Day 1 (03-01): srcA 1.00 + 2.00, srcB 0.50  → day cost 3.50, 3 runs
        // Day 2 (03-02): srcA 0.25, srcB 4.00         → day cost 4.25, 2 runs
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-01T06:00:00.000Z', 1.0));
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-01T18:00:00.000Z', 2.0));
        await db.crawlRuns.insert(makeRun(srcB, '2200-03-01T09:00:00.000Z', 0.5));
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-02T01:00:00.000Z', 0.25));
        await db.crawlRuns.insert(makeRun(srcB, '2200-03-02T23:00:00.000Z', 4.0));

        const summary = await db.crawlRuns.costSummary({ since, until });

        expect(summary.total_eur).toBe(7.75);
        expect(summary.run_count).toBe(5);
        // per_day ascending by day, UTC bucketed.
        expect(summary.per_day).toEqual([
          { day: '2200-03-01', cost_eur: 3.5, run_count: 3 },
          { day: '2200-03-02', cost_eur: 4.25, run_count: 2 },
        ]);
        // per_source descending by cost: srcB total 4.50 > srcA total 3.25.
        expect(summary.per_source).toEqual([
          { source_id: srcB, cost_eur: 4.5, run_count: 2 },
          { source_id: srcA, cost_eur: 3.25, run_count: 3 },
        ]);
      });

      it('(b2) per_source ties break by source_id ascending', async () => {
        const db = await makeDb();
        // Two sources with the SAME total cost; the deterministic tiebreak is
        // source_id ascending. Pick ids with a known lexical order.
        const lo = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
        const hi = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
        const since = new Date('2201-01-01T00:00:00.000Z');
        const until = new Date('2201-01-02T00:00:00.000Z');
        await db.crawlRuns.insert(makeRun(hi, '2201-01-01T05:00:00.000Z', 1.0));
        await db.crawlRuns.insert(makeRun(lo, '2201-01-01T06:00:00.000Z', 1.0));

        const summary = await db.crawlRuns.costSummary({ since, until });
        expect(summary.per_source.map((s) => s.source_id)).toEqual([lo, hi]);
      });

      it('(c) half-open window: started_at === until excluded, === since included', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2202-05-10T00:00:00.000Z');
        const until = new Date('2202-05-11T00:00:00.000Z');
        // exactly at since → INCLUDED; exactly at until → EXCLUDED; just inside → INCLUDED.
        await db.crawlRuns.insert(makeRun(src, '2202-05-10T00:00:00.000Z', 1.0)); // == since
        await db.crawlRuns.insert(makeRun(src, '2202-05-10T12:00:00.000Z', 2.0)); // inside
        await db.crawlRuns.insert(makeRun(src, '2202-05-11T00:00:00.000Z', 9.0)); // == until

        const summary = await db.crawlRuns.costSummary({ since, until });
        // The 9.00 run at the exclusive upper bound must NOT be counted.
        expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 3.0, run_count: 2 }]);
        expect(summary.total_eur).toBe(3.0);
        expect(summary.run_count).toBe(2);
      });

      it('(d) rounding: 7 runs of 0.001 sum and round to 0.01 cents identically', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2203-07-01T00:00:00.000Z');
        const until = new Date('2203-07-02T00:00:00.000Z');
        for (let i = 0; i < 7; i++) {
          await db.crawlRuns.insert(makeRun(src, `2203-07-01T0${i}:00:00.000Z`, 0.001));
        }
        const summary = await db.crawlRuns.costSummary({ since, until });
        expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 0.01, run_count: 7 }]);
        expect(summary.per_day).toEqual([{ day: '2203-07-01', cost_eur: 0.01, run_count: 7 }]);
        expect(summary.total_eur).toBe(0.01);
      });

      it('(e) order-sensitive multiset rounds identically + order-independently', async () => {
        // Regression guard for float-add order divergence between adapters: the raw
        // floats {0.005, 0.01, 0.02} sum to 0.035 OR 0.034999999999999996 depending
        // on fold order, which under "sum raw then round" gives €0.04 vs €0.03 — a
        // 1-cent disagreement for the SAME rows. With the micro-euro integer-sum
        // convention the answer is €0.04 regardless of order, in BOTH adapters.
        const db = await makeDb();
        const srcA = randomUUID();
        const srcB = randomUUID();
        const since = new Date('2300-09-01T00:00:00.000Z');
        const until = new Date('2300-09-02T00:00:00.000Z');
        const multiset = [0.005, 0.01, 0.02];
        // srcA inserts the multiset in one order...
        for (let i = 0; i < multiset.length; i++) {
          await db.crawlRuns.insert(makeRun(srcA, `2300-09-01T0${i}:00:00.000Z`, multiset[i]!));
        }
        // ...srcB inserts the SAME multiset reversed, proving order-independence
        // within a single query (Postgres scan/agg order is not insertion order).
        const reversed = [...multiset].reverse();
        for (let i = 0; i < reversed.length; i++) {
          await db.crawlRuns.insert(makeRun(srcB, `2300-09-01T1${i}:00:00.000Z`, reversed[i]!));
        }

        const summary = await db.crawlRuns.costSummary({ since, until });
        // Both sources roll up to the SAME rounded cents (€0.04), tie-broken by
        // source_id ascending. Assert exact values so a regression in either
        // adapter's convention is caught.
        const [lo, hi] = [srcA, srcB].sort((a, b) => a.localeCompare(b));
        expect(summary.per_source).toEqual([
          { source_id: lo, cost_eur: 0.04, run_count: 3 },
          { source_id: hi, cost_eur: 0.04, run_count: 3 },
        ]);
        // Both multisets land on the same UTC day → one bucket of €0.07 (0.04+0.04
        // computed from the exact micro sum, not by adding the rounded per-source €).
        expect(summary.per_day).toEqual([{ day: '2300-09-01', cost_eur: 0.07, run_count: 6 }]);
        expect(summary.total_eur).toBe(0.07);
        expect(summary.run_count).toBe(6);
      });

      it('(f) null source_id (Lane-B) folds under the shared sentinel bucket', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2301-02-01T00:00:00.000Z');
        const until = new Date('2301-02-02T00:00:00.000Z');
        // A Lane-A run (real source) + two Lane-B runs (null source) on the same day.
        await db.crawlRuns.insert(makeRun(src, '2301-02-01T01:00:00.000Z', 1.0));
        await db.crawlRuns.insert(
          makeRun(null, '2301-02-01T02:00:00.000Z', 0.5, { kind: 'discover' }),
        );
        await db.crawlRuns.insert(
          makeRun(null, '2301-02-01T03:00:00.000Z', 0.5, { kind: 'ingest' }),
        );

        const summary = await db.crawlRuns.costSummary({ since, until });
        // The two null-source runs collapse into ONE sentinel bucket (€1.00, 2 runs),
        // identical across adapters; the real source stays its own bucket.
        expect(summary.per_source).toContainEqual({
          source_id: SOURCELESS_RUN_BUCKET,
          cost_eur: 1.0,
          run_count: 2,
        });
        expect(summary.per_source).toContainEqual({
          source_id: src,
          cost_eur: 1.0,
          run_count: 1,
        });
        expect(summary.total_eur).toBe(2.0);
        expect(summary.run_count).toBe(3);
      });
    });

    describe('crawlRuns.spentSince', () => {
      it('sums all run cost at/after since (inclusive), 0 when none', async () => {
        const db = await makeDb();
        const src = randomUUID();
        // A deserted day so the shared DB can't pollute the sum.
        const dayStart = new Date('2310-08-15T00:00:00.000Z');
        expect(await db.crawlRuns.spentSince(dayStart)).toBe(0);

        // == since (included), inside, and one BEFORE since (excluded).
        await db.crawlRuns.insert(makeRun(src, '2310-08-14T23:00:00.000Z', 5.0)); // before
        await db.crawlRuns.insert(makeRun(src, '2310-08-15T00:00:00.000Z', 1.0)); // == since
        await db.crawlRuns.insert(
          makeRun(null, '2310-08-15T10:00:00.000Z', 2.0, { kind: 'discover' }),
        );

        // Only the two at/after since count; the pre-since 5.00 is excluded. This is
        // a global sum (no source filter), so scope by using a fresh far-out day.
        const spent = await db.crawlRuns.spentSince(dayStart);
        expect(spent).toBe(3.0);
      });
    });

    describe('crawlRuns.recentRuns', () => {
      it('returns runs in the window newest-first, capped at limit, with all fields', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2320-04-01T00:00:00.000Z');
        const until = new Date('2320-04-02T00:00:00.000Z');
        await db.crawlRuns.insert(makeRun(src, '2320-04-01T01:00:00.000Z', 1.0, { candidates: 2 }));
        await db.crawlRuns.insert(
          makeRun(null, '2320-04-01T05:00:00.000Z', 0.5, {
            kind: 'discover',
            candidates: 3,
            proposals: 4,
          }),
        );
        await db.crawlRuns.insert(makeRun(src, '2320-04-01T03:00:00.000Z', 0.25));
        // One outside the window (must be excluded).
        await db.crawlRuns.insert(makeRun(src, '2320-04-09T00:00:00.000Z', 9.0));

        const runs = await db.crawlRuns.recentRuns({ since, until, limit: 10 });
        expect(runs).toHaveLength(3);
        // Newest first by started_at.
        expect(runs.map((r) => r.started_at)).toEqual([
          '2320-04-01T05:00:00.000Z',
          '2320-04-01T03:00:00.000Z',
          '2320-04-01T01:00:00.000Z',
        ]);
        // The Lane-B run round-trips its kind/null-source/proposals through the schema.
        const discover = runs[0]!;
        expect(discover.run_kind).toBe('discover');
        expect(discover.source_id).toBeNull();
        expect(discover.candidates_produced).toBe(3);
        expect(discover.proposals_produced).toBe(4);

        // limit caps the result.
        const limited = await db.crawlRuns.recentRuns({ since, until, limit: 1 });
        expect(limited).toHaveLength(1);
        expect(limited[0]!.started_at).toBe('2320-04-01T05:00:00.000Z');
      });
    });

    // ── deals.listCandidates (gated admin review queue) ──────────────────────
    describe('deals.listCandidates', () => {
      it('defaults to the reviewable pair (candidate + in_review) and excludes terminal states', async () => {
        const db = await makeDb();
        const service = `svc-cand-default-${randomUUID()}`;
        const candidate = dealRecord({ service, status: DealStatus.enum.candidate });
        const inReview = dealRecord({ ...sameRoute(candidate), service, status: 'in_review' });
        const published = dealRecord({ ...sameRoute(candidate), service, status: 'published' });
        const rejected = dealRecord({ ...sameRoute(candidate), service, status: 'rejected' });
        const expired = dealRecord({ ...sameRoute(candidate), service, status: 'expired' });
        for (const d of [candidate, inReview, published, rejected, expired])
          await db.deals.insert(d);

        const out = await db.deals.listCandidates({ filters: { service }, limit: 50, offset: 0 });
        expect(new Set(out.map((d) => d.id))).toEqual(new Set([candidate.id, inReview.id]));
      });

      it('orders by confidence ASC then id ASC (lowest-confidence first) and paginates stably', async () => {
        const db = await makeDb();
        const service = `svc-cand-order-${randomUUID()}`;
        const low = dealRecord({ service, status: 'candidate', confidence: 0.2 });
        const mid = dealRecord({
          ...sameRoute(low),
          service,
          status: 'candidate',
          confidence: 0.5,
        });
        const high = dealRecord({
          ...sameRoute(low),
          service,
          status: 'in_review',
          confidence: 0.9,
        });
        for (const d of [high, low, mid]) await db.deals.insert(d);

        const all = await db.deals.listCandidates({ filters: { service }, limit: 50, offset: 0 });
        expect(all.map((d) => d.id)).toEqual([low.id, mid.id, high.id]);
        // Stable pagination: page 1 (offset 1, limit 1) is the second-lowest.
        const page = await db.deals.listCandidates({ filters: { service }, limit: 1, offset: 1 });
        expect(page.map((d) => d.id)).toEqual([mid.id]);
      });

      it('filters by an explicit status (including a terminal one) and by confidenceMax (inclusive)', async () => {
        const db = await makeDb();
        const service = `svc-cand-filter-${randomUUID()}`;
        const lowCand = dealRecord({ service, status: 'candidate', confidence: 0.6 });
        const highCand = dealRecord({
          ...sameRoute(lowCand),
          service,
          status: 'candidate',
          confidence: 0.95,
        });
        const published = dealRecord({
          ...sameRoute(lowCand),
          service,
          status: 'published',
          confidence: 0.6,
        });
        for (const d of [lowCand, highCand, published]) await db.deals.insert(d);

        // confidenceMax inclusive: 0.6 in, 0.95 out.
        const triage = await db.deals.listCandidates({
          filters: { service, confidenceMax: 0.6 },
          limit: 50,
          offset: 0,
        });
        expect(triage.map((d) => d.id)).toEqual([lowCand.id]);

        // Explicit terminal status reaches published deals for audit.
        const pub = await db.deals.listCandidates({
          filters: { service, status: DealStatus.enum.published },
          limit: 50,
          offset: 0,
        });
        expect(pub.map((d) => d.id)).toEqual([published.id]);
      });

      it('round-trips human_edited (v5) through the candidate list', async () => {
        const db = await makeDb();
        const service = `svc-cand-edited-${randomUUID()}`;
        const edited = dealRecord({
          service,
          status: 'candidate',
          human_edited: ['price', 'headline'],
        });
        await db.deals.insert(edited);
        const out = await db.deals.listCandidates({ filters: { service }, limit: 50, offset: 0 });
        expect(out).toHaveLength(1);
        expect(out[0]!.human_edited).toEqual(['price', 'headline']);
      });
    });

    // ── deals.update round-trips human_edited + re-derives the dedupe key ─────
    it('deals.update persists human_edited and re-derives the dedupe key when a key field changes', async () => {
      const db = await makeDb();
      const deal = dealRecord({
        status: 'candidate',
        route_type: 'bundle',
        human_edited: [],
      });
      await db.deals.insert(deal);

      // Edit a dedupe-key field (route_type) + tag it human-edited, like editCandidate does.
      const edited: DealRecord = { ...deal, route_type: 'promo', human_edited: ['route_type'] };
      await db.deals.update(edited);

      const reloaded = await db.deals.getById(deal.id);
      expect(reloaded!.route_type).toBe('promo');
      expect(reloaded!.human_edited).toEqual(['route_type']);
      // The new dedupe key (promo) finds it; the old (bundle) key no longer does —
      // both adapters derive the key from the record's fields, so editing re-keys it.
      const promoKey = dedupeKey({ ...edited }, edited.source_registrable_domain);
      const bundleKey = dedupeKey({ ...deal }, deal.source_registrable_domain);
      expect(promoKey).not.toBe(bundleKey);
      expect((await db.deals.findByDedupeKey(promoKey))?.id).toBe(deal.id);
      expect(await db.deals.findByDedupeKey(bundleKey)).toBeNull();
    });

    // ── manualCapture.getById + markDone ─────────────────────────────────────
    it('manualCapture: getById loads any status; markDone closes an open task', async () => {
      const db = await makeDb();
      const id = randomUUID();
      await db.manualCapture.insert({
        id,
        source_id: null,
        source_url: 'https://blocked.example/offer',
        reason: 'captcha',
        created_at: '2026-06-19T00:00:00.000Z',
        status: 'open',
        note: null,
      });
      expect((await db.manualCapture.getById(id))?.status).toBe('open');
      expect(await db.manualCapture.getById(randomUUID())).toBeNull();

      await db.manualCapture.markDone(id, 'captured by hand');
      const done = await db.manualCapture.getById(id);
      expect(done?.status).toBe('done');
      expect(done?.note).toBe('captured by hand');
      // A done task no longer appears in the open queue.
      expect((await db.manualCapture.listOpen(10)).map((t) => t.id)).not.toContain(id);
    });

    // ── fieldProposals.getByKey + markPromoted ───────────────────────────────
    it('fieldProposals: getByKey loads by key; markPromoted resolves it out of the open queue', async () => {
      const db = await makeDb();
      const suggested_key = `requires_widget_${randomUUID().slice(0, 8)}`;
      await db.fieldProposals.upsertAndCount({
        suggested_key,
        label: 'Widget required',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      });
      expect((await db.fieldProposals.getByKey(suggested_key))?.status).toBe('open');
      expect(await db.fieldProposals.getByKey('no-such-key')).toBeNull();

      await db.fieldProposals.markPromoted(suggested_key);
      expect((await db.fieldProposals.getByKey(suggested_key))?.status).toBe('promoted');
      expect((await db.fieldProposals.listOpen(50)).map((p) => p.suggested_key)).not.toContain(
        suggested_key,
      );
    });

    // ── conditionVocabulary repo ─────────────────────────────────────────────
    it('conditionVocabulary: upsert + getByKey + list (upsert is idempotent on key)', async () => {
      const db = await makeDb();
      const key = `requires_widget_${randomUUID().slice(0, 8)}`;
      await db.conditionVocabulary.upsert({
        key,
        label: 'Widget required',
        aliases: ['widget', 'needs_widget'],
        version: 1,
      });
      const got = await db.conditionVocabulary.getByKey(key);
      expect(got).toEqual({
        key,
        label: 'Widget required',
        aliases: ['widget', 'needs_widget'],
        version: 1,
      });
      expect(await db.conditionVocabulary.getByKey('absent')).toBeNull();
      expect((await db.conditionVocabulary.list()).map((e) => e.key)).toContain(key);

      // Re-upsert the same key updates in place (no duplicate, no throw).
      await db.conditionVocabulary.upsert({
        key,
        label: 'Widget required (v2)',
        aliases: [],
        version: 2,
      });
      const updated = await db.conditionVocabulary.getByKey(key);
      expect(updated).toEqual({ key, label: 'Widget required (v2)', aliases: [], version: 2 });
    });
  });
}

/** Copy the canonical-key fields (service/provider/route_type/country) of a deal. */
function sameRoute(d: DealRecord): Partial<DealRecord> {
  return {
    service: d.service,
    provider: d.provider,
    route_type: d.route_type,
    country: d.country,
  };
}

function makeChange(
  sourceId: string,
  kind: 'unchanged' | 'disappeared' | 'blocked' | 'content_changed',
  detectedAt: string,
) {
  return {
    id: randomUUID(),
    deal_id: null,
    source_id: sourceId,
    kind,
    previous_hash: null,
    current_hash: null,
    detected_at: detectedAt,
  };
}
