import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ReviewUseCase, SourceReviewUseCase } from '../../application/index.js';
import type { Logger } from '../../application/ports/index.js';
import { toAdminEvidence } from './admin-evidence-dto.js';
import {
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  SourceNotFoundError,
  SourceNotReviewableError,
  InvalidPatchError,
  FieldProposalNotFoundError,
  PromotionTargetNotSupportedError,
  ManualCaptureTaskNotFoundError,
  ManualCaptureTaskNotOpenError,
  EvidenceIncompleteError,
  CandidateFiltersSchema,
  CANDIDATES_DEFAULT_LIMIT,
  CANDIDATES_MAX_LIMIT,
  CANDIDATES_MAX_OFFSET,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  type CandidateFilters,
} from '../../domain/index.js';

/** Max accepted request-body size. Approve/reject bodies are a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

export interface ReviewApiOptions {
  staticPageHtml?: string;
  /**
   * Bearer token required on state-changing (POST) endpoints. When set, an
   * approve/reject without `Authorization: Bearer <token>` is rejected 401. When
   * unset, state changes are open and the API MUST be bound to a trusted network
   * (localhost / private) — see ARCHITECTURE.md. Read endpoints are never gated.
   */
  authToken?: string;
  /**
   * `Access-Control-Allow-Origin` for the browser admin panel that consumes this
   * API cross-origin. UNSET ⇒ no CORS headers are emitted (same-origin / server-to-
   * server callers only) — the safe default. When set it is echoed verbatim and the
   * preflight advertises the `Authorization` header + the state-changing methods, so
   * a browser can send the bearer. Deliberately NOT wildcardable here: this surface
   * is credentialed and state-changing, so the caller pins it to the panel's origin.
   */
  corsAllowOrigin?: string;
  /**
   * Public CDN base URL for evidence artifacts (config.evidence.s3.cdnBaseUrl). When
   * set, each `GET /api/candidates` item's evidence carries resolved
   * `evidence_screenshot_url` / `evidence_html_url` so the panel can render the
   * captured screenshot directly (ACR-13). Unset (e.g. local-fs evidence) ⇒ those
   * URLs are null and the panel shows its "no screenshot" placeholder. Mirrors the
   * `cdnBaseUrl` the public API already uses for its screenshot URL.
   */
  evidenceCdnBaseUrl?: string;
}

/**
 * HTTP review API — the DURABLE CONTRACT the future production admin panel (and
 * the existing prototype's Verify screen) will consume. The built-in test page is
 * only a thin harness over these same endpoints; all review actions live here.
 *
 * Built on Node's `http` (no framework dependency) to stay light and swappable.
 * Read endpoints are GET; state changes are POST with a JSON body. Nothing here
 * publishes automatically — `approve` requires an approver identity.
 *
 *   GET   /api/health
 *   GET   /api/candidates/counts          → CandidateCounts  (queue view-cards, ACR-5)
 *   GET   /api/candidates                 → [{ deal, evidence }]
 *           ?status=&service=&confidence_max=&limit=&offset=  (filters + pagination)
 *   PATCH /api/candidates/:id             { approver, patch }     → { deal }  (reviewer edit)
 *   POST  /api/candidates/:id/approve     { approver, affiliate_disclosure? } → { deal }
 *   POST  /api/candidates/:id/reject      { approver, reason? }   → { deal }
 *   GET   /api/candidates/:id/reviews     → [ReviewRecord]   (audit history)
 *   GET   /api/field-proposals            → [FieldProposalRecord]
 *   GET   /api/audit                      → { entries: [AuditEntry] }   (ACR-7)
 *           ?actor=&entity_id=&since=&limit=
 *   POST  /api/field-proposals/:key/promote
 *           { approver, canonical_key, label, target } → { vocabulary_entry }
 *   GET   /api/manual-capture-tasks       → [ManualCaptureTask]
 *   POST  /api/manual-capture-tasks       { approver, fields, evidence } → { created, candidate_id }  (ad-hoc, ACR-12)
 *   POST  /api/manual-capture-tasks/:id/complete
 *           { approver, fields, evidence } → { deal }  (creates a candidate; never publishes)
 *   GET   /api/sources/pending            → [Source]   (proposed sources)
 *   POST  /api/sources/:id/approve        { approver }            → { source }
 *   POST  /api/sources/:id/reject         { approver, reason? }   → { source }
 *   GET   /api/sources/:id/reviews        → [SourceReviewRecord]  (audit history)
 */
export class ReviewApi {
  private server: Server | null = null;
  private readonly staticPageHtml?: string;
  private readonly authToken?: string;
  private readonly corsAllowOrigin?: string;
  private readonly evidenceCdnBaseUrl?: string;

  constructor(
    private readonly review: ReviewUseCase,
    private readonly sourceReview: SourceReviewUseCase,
    private readonly logger: Logger,
    options: ReviewApiOptions = {},
  ) {
    this.staticPageHtml = options.staticPageHtml;
    this.authToken = options.authToken;
    this.corsAllowOrigin = options.corsAllowOrigin;
    this.evidenceCdnBaseUrl = options.evidenceCdnBaseUrl;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        // Unexpected errors: log the detail server-side, return a generic 500 —
        // never echo internal error text to clients.
        this.handle(req, res).catch((err) => {
          this.logger.error('review API request failed', { error: errMessage(err) });
          if (!res.headersSent) sendError(res, 500, 'internal error');
        });
      });
      this.server.listen(port, () => {
        this.logger.info('review API listening', { port });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Exposed for testing without binding a socket. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Apply CORS up front (when an admin-panel origin is configured) so EVERY
    // downstream response — including 401/404/500 from the helpers below — carries
    // the headers a browser needs. Setting them on `res` now (not per-send) means
    // the eventual writeHead merges them in; a missing config emits nothing.
    this.applyCors(res);
    // Preflight: the browser sends OPTIONS before a PATCH/POST with Authorization.
    // Answer it 204 here (auth is NOT checked on a preflight — it carries no bearer).
    if (method === 'OPTIONS') {
      res.writeHead(this.corsAllowOrigin ? 204 : 405);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/') return this.servePage(res);
    if (method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true });

    // Aggregate review-queue counts (ACR-5). Exact path — must precede the
    // `/api/candidates/:id...` patterns + the `/api/candidates` list below.
    if (method === 'GET' && path === '/api/candidates/counts') {
      return sendJson(res, 200, await this.review.candidateCounts());
    }

    if (method === 'GET' && path === '/api/candidates') {
      const parsed = parseCandidateQuery(url.searchParams);
      if (!parsed.ok) return sendError(res, 400, parsed.error);
      const views = await this.review.listCandidates(parsed.value);
      // Project each evidence bundle to the admin DTO — adding resolved CDN URLs so
      // the panel can render the captured screenshot (ACR-13), not just an opaque
      // store key. The deal is passed through unchanged (the review console sees the
      // full internal record; only the public DTO is an allow-list).
      const body = views.map((view) => ({
        deal: view.deal,
        evidence: toAdminEvidence(view.evidence, this.evidenceCdnBaseUrl),
      }));
      return sendJson(res, 200, body);
    }
    if (method === 'GET' && path === '/api/field-proposals') {
      return sendJson(res, 200, await this.review.listFieldProposals());
    }
    // Cross-deal audit feed (ACR-7): backs the Dashboard recent-activity card +
    // the Audit-log screen. Optional actor/entity_id/since filters + limit.
    if (method === 'GET' && path === '/api/audit') {
      const parsed = parseAuditQuery(url.searchParams);
      if (!parsed.ok) return sendError(res, 400, parsed.error);
      const entries = await this.review.auditFeed(parsed.value);
      return sendJson(res, 200, { entries });
    }
    if (method === 'GET' && path === '/api/manual-capture-tasks') {
      return sendJson(res, 200, await this.review.listManualCaptureTasks());
    }

    const promote = path.match(/^\/api\/field-proposals\/([^/]+)\/promote$/);
    if (method === 'POST' && promote) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = PromoteBody.safeParse(body);
      if (!parsed.success)
        return sendError(res, 400, 'approver, canonical_key and label are required');
      return this.mapErrors(res, async () => {
        const entry = await this.review.promoteFieldProposal({
          approver: parsed.data.approver,
          suggestedKey: decodeURIComponent(promote[1]!),
          canonicalKey: parsed.data.canonical_key,
          label: parsed.data.label,
          target: parsed.data.target,
        });
        sendJson(res, 200, { vocabulary_entry: entry });
      });
    }

    // Ad-hoc manual capture (ACR-12): create a candidate from scratch with NO
    // backing task. Distinct from `/:id/complete` (which needs an existing task id).
    if (method === 'POST' && path === '/api/manual-capture-tasks') {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = CreateManualBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver, fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.createManualCapture(
          parsed.data.approver,
          parsed.data.fields,
          {
            sourceUrl: parsed.data.evidence.source_url,
            screenshotRef: parsed.data.evidence.screenshot_ref,
            htmlRef: parsed.data.evidence.html_ref,
            termsRef: parsed.data.evidence.terms_ref,
            termsText: parsed.data.evidence.terms_text,
          },
        );
        // The panel keys off { created, candidate_id }; the new candidate id is deal.id.
        sendJson(res, 201, { created: true, candidate_id: deal.id });
      });
    }

    const completeManual = path.match(/^\/api\/manual-capture-tasks\/([^/]+)\/complete$/);
    if (method === 'POST' && completeManual) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = CompleteManualBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver, fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.completeManualCapture(
          decodeURIComponent(completeManual[1]!),
          parsed.data.approver,
          parsed.data.fields,
          {
            sourceUrl: parsed.data.evidence.source_url,
            screenshotRef: parsed.data.evidence.screenshot_ref,
            htmlRef: parsed.data.evidence.html_ref,
            termsRef: parsed.data.evidence.terms_ref,
            termsText: parsed.data.evidence.terms_text,
          },
        );
        sendJson(res, 200, { deal });
      });
    }

    const reviews = path.match(/^\/api\/candidates\/([^/]+)\/reviews$/);
    if (method === 'GET' && reviews) {
      return sendJson(res, 200, await this.review.listReviews(decodeURIComponent(reviews[1]!)));
    }

    // Edit a candidate's reviewer-correctable fields before approve. PATCH on the
    // candidate resource itself (no /edit suffix) — the verb carries the intent.
    const editCandidate = path.match(/^\/api\/candidates\/([^/]+)$/);
    if (method === 'PATCH' && editCandidate) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = EditCandidateBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver and patch are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.editCandidate(
          decodeURIComponent(editCandidate[1]!),
          parsed.data.approver,
          parsed.data.patch,
        );
        sendJson(res, 200, { deal });
      });
    }

    const approve = path.match(/^\/api\/candidates\/([^/]+)\/approve$/);
    if (method === 'POST' && approve) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveCandidateBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        // The reviewer may set the EU-Omnibus affiliate disclosure at approve-time;
        // omitted ⇒ the use-case defaults it to true (over-disclose) + flags it.
        const deal = await this.review.approve(
          decodeURIComponent(approve[1]!),
          parsed.data.approver,
          {
            affiliateDisclosure: parsed.data.affiliate_disclosure,
          },
        );
        sendJson(res, 200, { deal });
      });
    }

    const reject = path.match(/^\/api\/candidates\/([^/]+)\/reject$/);
    if (method === 'POST' && reject) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = RejectBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.reject(
          decodeURIComponent(reject[1]!),
          parsed.data.approver,
          parsed.data.reason,
        );
        sendJson(res, 200, { deal });
      });
    }

    // ── Source-promotion loop ────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/sources/pending') {
      return sendJson(res, 200, await this.sourceReview.listPending());
    }
    const sourceReviews = path.match(/^\/api\/sources\/([^/]+)\/reviews$/);
    if (method === 'GET' && sourceReviews) {
      return sendJson(
        res,
        200,
        await this.sourceReview.listReviews(decodeURIComponent(sourceReviews[1]!)),
      );
    }
    const approveSource = path.match(/^\/api\/sources\/([^/]+)\/approve$/);
    if (method === 'POST' && approveSource) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.approveSource(
          decodeURIComponent(approveSource[1]!),
          parsed.data.approver,
        );
        sendJson(res, 200, { source });
      });
    }
    const rejectSource = path.match(/^\/api\/sources\/([^/]+)\/reject$/);
    if (method === 'POST' && rejectSource) {
      if (!this.authorized(req)) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = RejectBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.rejectSource(
          decodeURIComponent(rejectSource[1]!),
          parsed.data.approver,
          parsed.data.reason,
        );
        sendJson(res, 200, { source });
      });
    }

    sendError(res, 404, `Not found: ${method} ${path}`);
  }

  /**
   * Set the CORS response headers when an admin-panel origin is configured (no-op
   * otherwise). Echoes the exact configured origin (never `*` — this surface is
   * credentialed) and advertises the methods + the `Authorization`/`Content-Type`
   * headers the panel needs to send the bearer. Called once per request before any
   * write so all response paths (success and error) include them.
   */
  private applyCors(res: ServerResponse): void {
    if (this.corsAllowOrigin === undefined) return;
    res.setHeader('access-control-allow-origin', this.corsAllowOrigin);
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
    // The origin is pinned (not `*`), so the response varies by Origin — let caches
    // key on it rather than serving one origin's headers to another.
    res.setHeader('vary', 'Origin');
  }

  /** True when no token is configured (open, trusted-network mode) or the bearer matches. */
  private authorized(req: IncomingMessage): boolean {
    if (this.authToken === undefined) return true;
    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return false;
    return safeEqual(header.slice(prefix.length), this.authToken);
  }

  /**
   * Run a review action, translating typed domain errors into the correct client
   * status (404/409/400) instead of letting them surface as a generic 500 with a
   * leaked internal message. Unexpected errors propagate to the top-level handler.
   */
  private async mapErrors(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof DealNotFoundError) return sendError(res, 404, 'deal not found');
      if (err instanceof NotReviewableError) {
        return sendError(res, 409, `deal is not reviewable (status: ${err.status})`);
      }
      if (err instanceof SourceNotFoundError) return sendError(res, 404, 'source not found');
      if (err instanceof SourceNotReviewableError) {
        return sendError(res, 409, `source is not awaiting approval (status: ${err.status})`);
      }
      if (err instanceof MissingApproverError) return sendError(res, 400, 'approver is required');
      if (err instanceof InvalidPatchError) return sendError(res, 400, err.message);
      if (err instanceof EvidenceIncompleteError) return sendError(res, 400, err.message);
      if (err instanceof PromotionTargetNotSupportedError) {
        return sendError(res, 400, err.message);
      }
      if (err instanceof FieldProposalNotFoundError) {
        return sendError(res, 404, 'field proposal not found');
      }
      if (err instanceof ManualCaptureTaskNotFoundError) {
        return sendError(res, 404, 'manual-capture task not found');
      }
      if (err instanceof ManualCaptureTaskNotOpenError) {
        return sendError(res, 409, `manual-capture task is not open (status: ${err.status})`);
      }
      throw err;
    }
  }

  private servePage(res: ServerResponse): void {
    if (!this.staticPageHtml) return sendError(res, 404, 'No test page configured');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(this.staticPageHtml);
  }
}

const ApproveBody = z.object({ approver: z.string().min(1) });
/** Candidate approve also accepts the reviewer's EU-Omnibus affiliate disclosure (optional). */
const ApproveCandidateBody = z.object({
  approver: z.string().min(1),
  affiliate_disclosure: z.boolean().optional(),
});
const RejectBody = z.object({ approver: z.string().min(1), reason: z.string().optional() });

/**
 * PATCH candidate edit. `patch` is an opaque object — the deeper allowlist +
 * sub-schema validation happens in the pure domain rule (applyCandidatePatch),
 * which the use-case calls, so the HTTP boundary only checks the envelope.
 */
const EditCandidateBody = z.object({
  approver: z.string().min(1),
  patch: z.record(z.unknown()),
});
/** Promote a field proposal into the condition vocabulary. */
const PromoteBody = z.object({
  approver: z.string().min(1),
  canonical_key: z.string().min(1),
  label: z.string().min(1),
  target: z.enum(['vocabulary', 'field']).default('vocabulary'),
});
/** Human deal fields + referenced evidence — shared by complete + ad-hoc create. */
const ManualCaptureBody = z.object({
  approver: z.string().min(1),
  fields: z.record(z.unknown()),
  evidence: z.object({
    source_url: z.string().min(1),
    screenshot_ref: z.string().min(1),
    html_ref: z.string().min(1),
    terms_ref: z.string().min(1),
    terms_text: z.string().min(1),
  }),
});
/** Complete an EXISTING manual-capture task (task id in the path). */
const CompleteManualBody = ManualCaptureBody;
/** Create a candidate from an AD-HOC capture with no backing task (ACR-12). */
const CreateManualBody = ManualCaptureBody;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Sentinels distinguishing malformed / oversized bodies from an (allowed) empty one. */
const MALFORMED = Symbol('malformed-json');
const TOO_LARGE = Symbol('body-too-large');

/**
 * Read and JSON-parse a request body, bounding total size so a client cannot
 * exhaust memory by streaming an unbounded body (Node imposes no default cap).
 * Returns TOO_LARGE / MALFORMED sentinels for the handler to map to 413 / 400.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let oversize = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop buffering but keep draining the stream to completion, so the
      // connection stays usable and the handler can return a clean 413
      // (destroying the socket mid-request makes the client see a reset).
      oversize = true;
      chunks.length = 0;
    } else if (!oversize) {
      chunks.push(buf);
    }
  }
  if (oversize) return TOO_LARGE;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Don't swallow: signal malformed input so the handler returns a clear 400.
    return MALFORMED;
  }
}

/** Constant-time string compare to avoid leaking the token via timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse the GET /api/candidates query string into bounded review-queue options.
 * Mirrors the public-feed query parsing: filters validated via the domain schema,
 * limit/offset parsed as ints and bounded to the domain caps (an over-cap offset is
 * a 400, never a silent clamp). Absent params ⇒ defaults (reviewable pair, page 0).
 */
function parseCandidateQuery(
  params: URLSearchParams,
): ParseResult<{ filters: CandidateFilters; limit: number; offset: number }> {
  const raw: Record<string, unknown> = {};
  if (params.has('status')) raw.status = params.get('status');
  if (params.has('service')) raw.service = params.get('service');
  if (params.has('confidence_max')) raw.confidenceMax = Number(params.get('confidence_max'));
  const filters = CandidateFiltersSchema.safeParse(raw);
  if (!filters.success) {
    return {
      ok: false,
      error: `invalid filter: ${filters.error.issues[0]?.message ?? 'bad query'}`,
    };
  }

  const limit = parseIntParam(params.get('limit'), CANDIDATES_DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > CANDIDATES_MAX_LIMIT) {
    return { ok: false, error: `limit must be 1..${CANDIDATES_MAX_LIMIT}` };
  }
  const offset = parseIntParam(params.get('offset'), 0);
  if (offset === null || offset < 0 || offset > CANDIDATES_MAX_OFFSET) {
    return { ok: false, error: `offset must be 0..${CANDIDATES_MAX_OFFSET}` };
  }
  return { ok: true, value: { filters: filters.data, limit, offset } };
}

/** Parse an integer query param; null when present-but-not-an-integer (caller 400s). */
function parseIntParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

/**
 * Parse the GET /api/audit query into bounded audit-feed options (ACR-7). Optional
 * `actor`, `entity_id`, `since` (ISO-8601 → Date), and a `limit` clamped to the
 * domain caps (an over-cap / non-integer limit or an unparseable `since` is a 400).
 */
function parseAuditQuery(
  params: URLSearchParams,
): ParseResult<{ actor?: string; entityId?: string; since?: Date; limit: number }> {
  const limit = parseIntParam(params.get('limit'), AUDIT_DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > AUDIT_MAX_LIMIT) {
    return { ok: false, error: `limit must be 1..${AUDIT_MAX_LIMIT}` };
  }
  const value: { actor?: string; entityId?: string; since?: Date; limit: number } = { limit };
  const actor = params.get('actor');
  if (actor !== null && actor !== '') value.actor = actor;
  const entityId = params.get('entity_id');
  if (entityId !== null && entityId !== '') value.entityId = entityId;
  const sinceRaw = params.get('since');
  if (sinceRaw !== null && sinceRaw !== '') {
    const ms = Date.parse(sinceRaw);
    if (Number.isNaN(ms)) return { ok: false, error: 'since must be an ISO-8601 timestamp' };
    value.since = new Date(ms);
  }
  return { ok: true, value };
}
