import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  Fetcher,
  FetchResult,
  Llm,
  LlmRequest,
  LlmResponse,
  LlmRole,
  FeedReader,
  FeedItem,
  EvidenceStore,
  Clock,
  Logger,
} from '../../src/application/ports/index.js';
import { assertCaptureComplete } from '../../src/domain/index.js';
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

/**
 * Fetcher fake that returns a DIFFERENT result per URL — for multi-page flows
 * (discovery). Unknown URLs resolve to an `error` outcome (so a run can't wander
 * off into unscripted territory). Records the order URLs were fetched.
 */
export class ScriptedFetcher implements Fetcher {
  public readonly fetched: string[] = [];
  constructor(private readonly pages: Record<string, Partial<FetchResult> & { text?: string }>) {}
  /** Replace (or add) the scripted result for a URL — e.g. to simulate a change. */
  setResultFor(url: string, page: Partial<FetchResult> & { text?: string }): void {
    this.pages[url] = page;
  }
  async fetch(url: string): Promise<FetchResult> {
    this.fetched.push(url);
    const page = this.pages[url];
    if (page === undefined) {
      return {
        outcome: 'error',
        url,
        finalUrl: url,
        text: '',
        html: '',
        screenshot: new Uint8Array(),
        error: 'not scripted',
      };
    }
    return {
      outcome: 'ok',
      url,
      finalUrl: url,
      text: 'page text',
      html: '<html></html>',
      screenshot: new Uint8Array([1]),
      ...page,
    };
  }
}

/** Llm fake: returns scripted JSON text. */
export class FakeLlm implements Llm {
  public lastRequest: LlmRequest | null = null;
  /** Set true to simulate a reply truncated at the output-token limit. */
  constructor(
    private json: string,
    private truncated = false,
  ) {}
  setJson(json: string): void {
    this.json = json;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.lastRequest = request;
    return {
      text: this.json,
      usage: { inputTokens: 100, outputTokens: 50, costEur: 0.001 },
      model: 'fake-model',
      truncated: this.truncated,
    };
  }
}

/**
 * Llm fake that returns queued replies in order — one per `complete` call,
 * repeating the last once exhausted — and counts calls. For exercising the bounded
 * re-ask in ExtractUseCase (e.g. a first unparseable reply then a valid one). Each
 * call is billed `costEur` so retry cost accounting can be asserted.
 */
export class SequencedFakeLlm implements Llm {
  public calls = 0;
  constructor(
    private readonly replies: string[],
    private readonly costEur = 0.001,
  ) {}
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    const text = this.replies[Math.min(this.calls, this.replies.length - 1)] ?? '{}';
    this.calls++;
    return {
      text,
      usage: { inputTokens: 100, outputTokens: 50, costEur: this.costEur },
      model: 'fake-model',
      truncated: false,
    };
  }
}

/** Llm fake that returns a different scripted response per role (triage vs extract). */
export class RoleAwareFakeLlm implements Llm {
  constructor(
    private readonly byRole: Partial<Record<LlmRole, string>>,
    /** Per-call cost in EUR (default sub-cent; raise it to exercise cent-rounding). */
    private readonly costEur = 0.001,
  ) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    return {
      text: this.byRole[request.role] ?? '{}',
      usage: { inputTokens: 100, outputTokens: 50, costEur: this.costEur },
      model: 'fake-model',
      truncated: false,
    };
  }
}

/** FeedReader fake: returns scripted items per feed URL. */
export class FakeFeedReader implements FeedReader {
  constructor(private readonly feeds: Record<string, FeedItem[]>) {}
  async read(url: string): Promise<FeedItem[]> {
    return (this.feeds[url] ?? []).map((i) => ({ ...i }));
  }
}

/** EvidenceStore fake: keeps captures in memory, returns deterministic refs. */
export class FakeEvidenceStore implements EvidenceStore {
  public saved: Evidence[] = [];
  async save(capture: EvidenceCapture): Promise<Evidence> {
    // Mirror the production store: reject a hollow capture before "persisting" it,
    // so the fake stays substitutable under the contract (LSP) and tests relying
    // on the fake can't accidentally pin a candidate to empty evidence.
    assertCaptureComplete(capture);
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
