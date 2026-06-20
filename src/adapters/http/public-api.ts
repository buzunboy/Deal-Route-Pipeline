import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DealRepository } from '../../application/ports/index.js';
import type { Clock, Logger } from '../../application/ports/index.js';
import {
  Country,
  RouteType,
  PublishedSort,
  PUBLISHED_DEFAULT_LIMIT,
  PUBLISHED_DEFAULT_SORT,
  PUBLISHED_MAX_LIMIT,
  PUBLISHED_MAX_OFFSET,
  type PublishedQuery,
} from '../../domain/index.js';
import { toPublicDeal } from './public-dto.js';

export interface PublicApiOptions {
  /** Public CDN base URL for evidence screenshots (config.evidence.s3.cdnBaseUrl). */
  cdnBaseUrl?: string;
  /**
   * Value for `Access-Control-Allow-Origin` on every /v1/ response. The data is
   * fully public and unauthenticated (no cookies/credentials), so `*` is the safe
   * default; an env override can tighten it to the landing-page origin later.
   */
  corsAllowOrigin: string;
}

/**
 * The PUBLIC read API (`/v1/*`) — unauthenticated, READ-ONLY over `published`
 * deals. The deliberate counterpart to the gated admin {@link ReviewApi}: it
 * NEVER writes, never changes status, and never exposes a non-published deal or
 * any internal field (the projection is enforced by {@link toPublicDeal}).
 *
 * Mounted alongside `ReviewApi` on the same port; `serve` routes `/v1/*` here.
 * Dispatch is TOTAL: an unrecognised `/v1/...` path returns THIS router's own 404
 * — a request that reaches `handle` is never handed on to the admin router, so a
 * public path can never fall through to an admin/state-changing route.
 *
 *   GET /v1/health
 *   GET /v1/deals?service=&country=&route_type=&price_max=&sort=&limit=&offset=
 *   GET /v1/deals/:id      (404 if missing OR not published)
 */
export class PublicApi {
  constructor(
    private readonly deals: DealRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: PublicApiOptions,
  ) {}

  /** Handle a `/v1/*` request. Caller (serve) guarantees the path is under /v1/. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // CORS preflight: a public browser API consumed cross-origin (the landing page
    // lives in a separate repo) must answer OPTIONS before the real GET.
    if (method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }

    // Read-only surface: anything other than GET (besides the OPTIONS above) is
    // refused — never let a public route accept a state-changing method.
    if (method !== 'GET') return this.sendError(res, 405, 'method not allowed');

    if (path === '/v1/health') return this.sendJson(res, 200, { ok: true });

    if (path === '/v1/deals') return this.listDeals(res, url);

    const byId = path.match(/^\/v1\/deals\/([^/]+)$/);
    if (byId) return this.getDeal(res, decodeURIComponent(byId[1]!));

    // TOTAL dispatch: an unknown /v1/ path is this router's 404 — never fall through.
    return this.sendError(res, 404, `Not found: ${method} ${path}`);
  }

  private async listDeals(res: ServerResponse, url: URL): Promise<void> {
    const parsed = ListDealsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return this.sendError(res, 400, `invalid query: ${formatIssues(parsed.error)}`);
    }
    const query: PublishedQuery = {
      filters: {
        ...(parsed.data.service !== undefined && { service: parsed.data.service }),
        ...(parsed.data.country !== undefined && { country: parsed.data.country }),
        ...(parsed.data.route_type !== undefined && { routeType: parsed.data.route_type }),
        ...(parsed.data.price_max !== undefined && { priceMax: parsed.data.price_max }),
      },
      sort: parsed.data.sort ?? PUBLISHED_DEFAULT_SORT,
      limit: parsed.data.limit ?? PUBLISHED_DEFAULT_LIMIT,
      offset: parsed.data.offset ?? 0,
    };
    const [rows, total] = await Promise.all([
      this.deals.listPublished(query),
      this.deals.countPublished(query.filters),
    ]);
    const now = this.clock.now();
    return this.sendJson(res, 200, {
      deals: rows.map((d) => toPublicDeal(d, { cdnBaseUrl: this.options.cdnBaseUrl, now })),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  }

  private async getDeal(res: ServerResponse, id: string): Promise<void> {
    const deal = await this.deals.getById(id);
    // 404 a missing deal AND any non-published one — never leak a
    // candidate/in_review/expired/rejected record through the public surface, and
    // don't distinguish "not found" from "not published" (same response).
    if (deal === null || deal.status !== 'published') {
      return this.sendError(res, 404, 'deal not found');
    }
    return this.sendJson(res, 200, {
      deal: toPublicDeal(deal, { cdnBaseUrl: this.options.cdnBaseUrl, now: this.clock.now() }),
    });
  }

  private corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-origin': this.options.corsAllowOrigin,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    };
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      ...this.corsHeaders(),
    });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, { error: message });
  }
}

/**
 * Query-param schema for `GET /v1/deals`. Raw strings are coerced/validated INTO
 * typed filters before use — never trusted raw (`code-style.md`). An unknown enum
 * value, a non-numeric limit, or an out-of-range page is a 400, NOT a silent
 * default that could over-return. `limit` is hard-capped at PUBLISHED_MAX_LIMIT so
 * a public caller can't request an unbounded page (the abuse floor guard).
 */
const ListDealsQuery = z
  .object({
    service: z.string().min(1).optional(),
    country: Country.optional(),
    route_type: RouteType.optional(),
    price_max: z.coerce.number().nonnegative().optional(),
    sort: PublishedSort.optional(),
    limit: z.coerce.number().int().positive().max(PUBLISHED_MAX_LIMIT).optional(),
    offset: z.coerce.number().int().nonnegative().max(PUBLISHED_MAX_OFFSET).optional(),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');
}
