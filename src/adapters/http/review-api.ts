import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { z } from 'zod';
import type { ReviewUseCase } from '../../application/index.js';
import type { Logger } from '../../application/ports/index.js';

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
 *   POST /api/candidates/:id/approve      { approver }            → { deal }
 *   POST /api/candidates/:id/reject       { approver, reason? }   → { deal }
 *   GET  /api/field-proposals            → [FieldProposalRecord]
 *   GET  /api/manual-capture-tasks       → [ManualCaptureTask]
 */
export class ReviewApi {
  private server: Server | null = null;

  constructor(
    private readonly review: ReviewUseCase,
    private readonly logger: Logger,
    private readonly staticPageHtml?: string,
  ) {}

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => sendError(res, 500, errMessage(err)));
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

    const approve = path.match(/^\/api\/candidates\/([^/]+)\/approve$/);
    if (method === 'POST' && approve) {
      const body = await readJson(req);
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      const deal = await this.review.approve(decodeURIComponent(approve[1]!), parsed.data.approver);
      return sendJson(res, 200, { deal });
    }

    const reject = path.match(/^\/api\/candidates\/([^/]+)\/reject$/);
    if (method === 'POST' && reject) {
      const body = await readJson(req);
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = RejectBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      const deal = await this.review.reject(
        decodeURIComponent(reject[1]!),
        parsed.data.approver,
        parsed.data.reason,
      );
      return sendJson(res, 200, { deal });
    }

    sendError(res, 404, `Not found: ${method} ${path}`);
  }

  private servePage(res: ServerResponse): void {
    if (!this.staticPageHtml) return sendError(res, 404, 'No test page configured');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(this.staticPageHtml);
  }
}

const ApproveBody = z.object({ approver: z.string().min(1) });
const RejectBody = z.object({ approver: z.string().min(1), reason: z.string().optional() });

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Sentinel distinguishing a malformed JSON body from an (allowed) empty one. */
const MALFORMED = Symbol('malformed-json');

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Don't swallow: signal malformed input so the handler returns a clear 400.
    return MALFORMED;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
