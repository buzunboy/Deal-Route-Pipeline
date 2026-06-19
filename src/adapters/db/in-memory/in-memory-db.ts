import { randomUUID } from 'node:crypto';
import {
  dedupeKey,
  type Source,
  type DealRecord,
  type CrawlRun,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
  type Change,
  type DealStatus,
} from '../../../domain/index.js';
import type {
  Database,
  SourceRepository,
  DealRepository,
  CrawlRunRepository,
  EvidenceRepository,
  ManualCaptureRepository,
  FieldProposalRepository,
  ChangeRepository,
} from '../../../application/ports/index.js';

/**
 * In-memory Database adapter. A first-class, shippable implementation of the
 * `Database` port: it lets the whole pipeline run (dry-run, demos, CI) WITHOUT a
 * Postgres instance. It is also the reference the adapter contract suite runs
 * the Postgres adapter against. Not durable — data is lost on process exit.
 */
export class InMemoryDb implements Database {
  sources: SourceRepository = new InMemorySourceRepo();
  deals: DealRepository = new InMemoryDealRepo();
  crawlRuns: CrawlRunRepository = new InMemoryCrawlRunRepo();
  evidence: EvidenceRepository = new InMemoryEvidenceRepo();
  manualCapture: ManualCaptureRepository = new InMemoryManualCaptureRepo();
  fieldProposals: FieldProposalRepository = new InMemoryFieldProposalRepo();
  changes: ChangeRepository = new InMemoryChangeRepo();
}

class InMemorySourceRepo implements SourceRepository {
  private store = new Map<string, Source>();
  async upsert(s: Source): Promise<void> {
    this.store.set(s.id, { ...s });
  }
  async getById(id: string): Promise<Source | null> {
    const s = this.store.get(id);
    return s ? { ...s } : null;
  }
  async listDue(now: Date, limit: number): Promise<Source[]> {
    return [...this.store.values()]
      .filter(
        (s) =>
          s.status === 'active' && (s.next_due === null || Date.parse(s.next_due) <= now.getTime()),
      )
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  async listByStatus(status: Source['status']): Promise<Source[]> {
    return [...this.store.values()].filter((s) => s.status === status).map((s) => ({ ...s }));
  }
  async update(s: Source): Promise<void> {
    this.store.set(s.id, { ...s });
  }
}

class InMemoryDealRepo implements DealRepository {
  private store = new Map<string, DealRecord>();
  async insert(d: DealRecord): Promise<void> {
    this.store.set(d.id, { ...d });
  }
  async getById(id: string): Promise<DealRecord | null> {
    const d = this.store.get(id);
    return d ? { ...d } : null;
  }
  async listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]> {
    return [...this.store.values()].filter((d) => d.status === status).slice(0, limit).map((d) => ({ ...d }));
  }
  async findByDedupeKey(key: string): Promise<DealRecord | null> {
    for (const d of this.store.values()) {
      if (d.status !== 'rejected' && dedupeKey(d) === key) return { ...d };
    }
    return null;
  }
  async updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void> {
    const d = this.store.get(id);
    if (d) this.store.set(id, { ...d, status, verified_by: verifiedBy, verified_at: verifiedAt });
  }
  async update(d: DealRecord): Promise<void> {
    this.store.set(d.id, { ...d });
  }
}

class InMemoryCrawlRunRepo implements CrawlRunRepository {
  private store = new Map<string, CrawlRun>();
  async insert(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
  async update(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
}

class InMemoryEvidenceRepo implements EvidenceRepository {
  private store = new Map<string, Evidence>();
  async insert(e: Evidence): Promise<void> {
    this.store.set(e.id, { ...e });
  }
  async getById(id: string): Promise<Evidence | null> {
    const e = this.store.get(id);
    return e ? { ...e } : null;
  }
}

class InMemoryManualCaptureRepo implements ManualCaptureRepository {
  private tasks: ManualCaptureTask[] = [];
  async insert(t: ManualCaptureTask): Promise<void> {
    this.tasks.push({ ...t });
  }
  async listOpen(limit: number): Promise<ManualCaptureTask[]> {
    return this.tasks.filter((t) => t.status === 'open').slice(0, limit).map((t) => ({ ...t }));
  }
}

class InMemoryFieldProposalRepo implements FieldProposalRepository {
  private store = new Map<string, FieldProposalRecord>();
  async upsertAndCount(p: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void> {
    const existing = this.store.get(p.suggested_key);
    if (existing) {
      this.store.set(p.suggested_key, {
        ...existing,
        count: existing.count + 1,
        last_seen_at: p.last_seen_at,
      });
    } else {
      this.store.set(p.suggested_key, { ...p, id: randomUUID(), count: 1, status: 'open' });
    }
  }
  async listOpen(limit: number): Promise<FieldProposalRecord[]> {
    return [...this.store.values()].filter((p) => p.status === 'open').slice(0, limit).map((p) => ({ ...p }));
  }
}

class InMemoryChangeRepo implements ChangeRepository {
  private changes: Change[] = [];
  async insert(c: Change): Promise<void> {
    this.changes.push({ ...c });
  }
}
