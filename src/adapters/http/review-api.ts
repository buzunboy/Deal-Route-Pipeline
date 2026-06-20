import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ReviewUseCase, SourceReviewUseCase } from '../../application/index.js';
import type { Logger } from '../../application/ports/index.js';
import {
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  SourceNotFoundError,
  SourceNotReviewableError,
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
 *   GET  /api/health
 *   GET  /api/candidates                 → [{ deal, evidence }]
 *   POST /api/candidates/:id/approve      { approver, affiliate_disclosure? } → { deal }
 *   POST /api/candidates/:id/reject       { approver, reason? }   → { deal }
 *   GET  /api/candidates/:id/reviews      → [ReviewRecord]   (audit history)
 *   GET  /api/field-proposals            → [FieldProposalRecord]
 *   GET  /api/manual-capture-tasks       → [ManualCaptureTask]
 *   GET  /api/sources/pending            → [Source]   (proposed sources)
 *   POST /api/sources/:id/approve         { approver }            → { source }
 *   POST /api/sources/:id/reject          { approver, reason? }   → { source }
 *   GET  /api/sources/:id/reviews        → [SourceReviewRecord]  (audit history)
 */
export class ReviewApi {
  private server: Server | null = null;
  private readonly staticPageHtml?: string;
  private readonly authToken?: string;

  constructor(
    private readonly review: ReviewUseCase,
    private readonly sourceReview: SourceReviewUseCase,
    private readonly logger: Logger,
    options: ReviewApiOptions = {},
  ) {
    this.staticPageHtml = options.staticPageHtml;
    this.authToken = options.authToken;
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

    if (method === 'GET' && path === '/') return this.servePage(res);
    if (method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true });

    if (method === 'GET' && path === '/api/candidates') {
      return sendJson(res, 200, await this.review.listCandidates());
    }
    if (method === 'GET' && path === '/api/field-proposals') {
      return sendJson(res, 200, await this.review.listFieldProposals());
    }
    if (method === 'GET' && path === '/api/manual-capture-tasks') {
      return sendJson(res, 200, await this.review.listManualCaptureTasks());
    }

    const reviews = path.match(/^\/api\/candidates\/([^/]+)\/reviews$/);
    if (method === 'GET' && reviews) {
      return sendJson(res, 200, await this.review.listReviews(decodeURIComponent(reviews[1]!)));
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
