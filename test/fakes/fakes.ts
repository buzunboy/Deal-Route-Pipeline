import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  Fetcher,
  FetchResult,
  Llm,
  LlmRequest,
  LlmResponse,
  EvidenceStore,
  Clock,
  Logger,
} from '../../src/application/ports/index.js';
import type { Evidence, EvidenceCapture } from '../../src/domain/index.js';

/** Fetcher fake: returns a scripted result. Default is a clean OK page. */
export class FakeFetcher implements Fetcher {
  constructor(private result: Partial<FetchResult> & { text?: string } = {}) {}
  setResult(result: Partial<FetchResult>): void {
    this.result = { ...this.result, ...result };
  }
  async fetch(url: string): Promise<FetchResult> {
    return {
      outcome: 'ok',
      url,
      finalUrl: url,
      text: 'default page text',
      html: '<html></html>',
      screenshot: new Uint8Array([1, 2, 3]),
      ...this.result,
    };
  }
}

/** Llm fake: returns scripted JSON text. */
export class FakeLlm implements Llm {
  public lastRequest: LlmRequest | null = null;
  constructor(private json: string) {}
  setJson(json: string): void {
    this.json = json;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.lastRequest = request;
    return {
      text: this.json,
      usage: { inputTokens: 100, outputTokens: 50, costEur: 0.001 },
      model: 'fake-model',
    };
  }
}

/** EvidenceStore fake: keeps captures in memory, returns deterministic refs. */
export class FakeEvidenceStore implements EvidenceStore {
  public saved: Evidence[] = [];
  async save(capture: EvidenceCapture): Promise<Evidence> {
    const id = randomUUID();
    const evidence: Evidence = {
      id,
      source_url: capture.sourceUrl,
      screenshot_ref: `mem://${id}/screenshot.png`,
      html_ref: `mem://${id}/page.html`,
      terms_ref: `mem://${id}/terms.txt`,
      captured_at: capture.capturedAt,
      content_hash: capture.contentHash,
    };
    this.saved.push(evidence);
    return evidence;
  }
  async get(id: string): Promise<Evidence | null> {
    return this.saved.find((e) => e.id === id) ?? null;
  }
}

/** Deterministic clock fixed at a given instant. */
export class FixedClock implements Clock {
  constructor(private readonly fixed: Date = new Date('2026-06-19T00:00:00.000Z')) {}
  now(): Date {
    return this.fixed;
  }
  nowIso(): string {
    return this.fixed.toISOString();
  }
}

/** No-op logger that records calls for assertions if needed. */
export class FakeLogger implements Logger {
  public entries: { level: string; msg: string }[] = [];
  debug(msg: string): void {
    this.entries.push({ level: 'debug', msg });
  }
  info(msg: string): void {
    this.entries.push({ level: 'info', msg });
  }
  warn(msg: string): void {
    this.entries.push({ level: 'warn', msg });
  }
  error(msg: string): void {
    this.entries.push({ level: 'error', msg });
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
