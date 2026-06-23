import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { z } from 'zod';
import {
  MALFORMED,
  TOO_LARGE,
  readBody,
  sendJson,
  sendError,
  sendBytes,
  safeEqual,
  parseIntParam,
  errMessage,
} from './http-helpers.js';
import {
  type ReviewUseCase,
  type SourceReviewUseCase,
  type TeamUseCase,
  type AlertsUseCase,
  type MetricsUseCase,
  type SettingsUseCase,
  type AuthorizationUseCase,
  ALERTS_DEFAULT_LIMIT,
  ALERTS_MAX_LIMIT,
} from '../../application/index.js';
import type {
  Logger,
  EvidenceStore,
  TokenIssuer,
  Database,
} from '../../application/ports/index.js';
import { toAdminEvidence } from './admin-evidence-dto.js';
import { UUID_PATTERN } from './http-ids.js';
import { tryMapAuthError } from './auth-error-map.js';
import { type EvidenceArtifactKind, type Permission, hasPermission } from '../../domain/index.js';
import {
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  SourceNotFoundError,
  SourceNotReviewableError,
  SourceConflictError,
  InvalidPatchError,
  FieldProposalNotFoundError,
  PromotionTargetNotSupportedError,
  ManualCaptureTaskNotFoundError,
  ManualCaptureTaskNotOpenError,
  EvidenceIncompleteError,
  SettingNotWritableError,
  CandidateFiltersSchema,
  CANDIDATES_DEFAULT_LIMIT,
  CANDIDATES_MAX_LIMIT,
  CANDIDATES_MAX_OFFSET,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  ADMIN_PUBLISHED_MAX_LIMIT,
  ADMIN_PUBLISHED_MAX_OFFSET,
  type CandidateFilters,
} from '../../domain/index.js';

/**
 * The verified identity behind a gated `/api/*` request (Auth/IAM, Phase 2). Two shapes
 * during the dual-accept window:
 * - `kind:'jwt'` — a per-user ES256 token: identity + perms come from the VERIFIED claims.
 *   `email` becomes the `approver` on every audited decision (the body field is ignored).
 * - `kind:'legacy'` — the soon-to-be-retired static `REVIEW_API_TOKEN`. It carries NO
 *   identity, so it is deliberately given NO `email` and NO perms — it must NEVER synthesize
 *   a `legacy-token@system` actor onto the email-keyed reviews audit trail. A legacy caller
 *   still supplies the `approver` in the BODY (the pre-Phase-2 behaviour); the registry
 *   permission check is skipped for it (the static token was always all-or-nothing).
 */
export type Identity =
  | { kind: 'jwt'; userId: string; email: string; role: string; perms: Set<Permission> }
  | { kind: 'legacy' };

/**
 * UUID path-segment matcher for `:id` routes whose id maps to a Postgres `uuid` column
 * (candidates/deals, sources, alerts, manual-capture tasks). Embedding the shape in the
 * route regex means a malformed id (`/api/candidates/abc`) simply doesn't match and
 * falls through to the catch-all 404 — instead of reaching the DB and 500-ing on
 * `invalid input syntax for type uuid`. NOT used for the string-keyed routes
 * (`field-proposals/:key`, `settings/:key`), whose keys are free-form. Shares the one
 * UUID shape with `isUuid` (the public router's boundary guard) so the two can't drift.
 */
const UUID_SEG = UUID_PATTERN;

export interface ReviewApiOptions {
  staticPageHtml?: string;
  /**
   * The LEGACY static bearer token (`REVIEW_API_TOKEN`). During the Phase-2 dual-accept
   * window it is accepted ALONGSIDE per-user JWTs (see {@link ReviewApi.authenticate}):
   * a request whose bearer equals this token authenticates as a `kind:'legacy'` identity
   * (no per-user perms; `approver` still comes from the body). It is RETIRED in Phase 5.
   * When BOTH this and the JWT signing key are unset, the surface is open (trusted-network
   * mode) — `serve.ts` warns at startup. Reads now also require a valid token (JWT or this).
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
   * Auth/IAM (Phase 2) wiring for the per-user JWT guard. When present, a request may
   * authenticate with a per-user ES256 bearer (verified by `tokenIssuer`, the user reloaded
   * via `db`, perms resolved via `authorization`); the legacy {@link authToken} stays
   * accepted alongside it (dual-accept). When ABSENT, only the legacy token / open mode
   * applies (so existing constructions without auth keep working unchanged).
   */
  auth?: {
    tokenIssuer: TokenIssuer;
    db: Database;
    authorization: AuthorizationUseCase;
  };
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
 *   GET   /api/candidates/freshness       → [FreshnessBand]  (queue age-buckets, ACR-9)
 *   GET   /api/candidates                 → [{ deal, evidence }]
 *           ?status=&service=&confidence_max=&limit=&offset=  (filters + pagination)
 *   PATCH /api/candidates/:id             { approver, patch }     → { deal }  (reviewer edit)
 *   POST  /api/candidates/:id/approve     { approver, affiliate_disclosure? } → { deal }
 *   POST  /api/candidates/:id/reject      { approver, reason? }   → { deal }
 *   GET   /api/candidates/:id/reviews     → [ReviewRecord]   (audit history)
 *   GET   /api/evidence/:id/:artifact     → raw bytes   (Bearer-GATED; artifact ∈ screenshot|html|terms)
 *   GET   /api/field-proposals            → [FieldProposalRecord]
 *   GET   /api/audit                      → { entries: [AuditEntry] }   (ACR-7)
 *           ?actor=&entity_id=&since=&limit=
 *   GET   /api/published                  → { deals: [AdminPublishedDeal], total }  (ACR-10)
 *           ?limit=&offset=
 *   POST  /api/field-proposals/:key/promote
 *           { approver, canonical_key, label, target } → { vocabulary_entry }
 *   GET   /api/manual-capture-tasks       → [ManualCaptureTask]
 *   POST  /api/manual-capture-tasks       { approver, fields, evidence } → { created, candidate_id }  (ad-hoc, ACR-12)
 *   POST  /api/manual-capture-tasks/:id/complete
 *           { approver, fields, evidence } → { deal }  (creates a candidate; never publishes)
 *   GET   /api/sources                    → { sources: [SourceRegistryEntry] }   (registry, ACR-10)
 *   POST  /api/sources                    { approver, domain, kind, tier } → { id, created }  (ACR-10)
 *   GET   /api/sources/pending            → [Source]   (proposed sources)
 *   POST  /api/sources/:id/approve        { approver }            → { source }
 *   POST  /api/sources/:id/reject         { approver, reason? }   → { source }
 *   GET   /api/sources/:id/reviews        → [SourceReviewRecord]  (audit history)
 *   GET   /api/team                       → { members: [TeamMemberView] }   (ACR-10)
 *   POST  /api/team                       { approver, name, email, role? } → { id, invited, email }  (ACR-10)
 *   PATCH /api/profile                    { approver, name } → { updated, name }   (ACR-11)
 *   GET   /api/alerts                     → { alerts: [AlertView], open_count }   (ACR-8)
 *   POST  /api/alerts/:id/acknowledge     { approver } → { acknowledged }   (ACR-8)
 *   POST  /api/alerts/:id/resolve         { approver } → { resolved }   (ACR-8)
 *   GET   /api/metrics/throughput         → ThroughputSummary   (today's reviewer throughput, ACR-6)
 *           ?period=today
 *   GET   /api/metrics                    → DashboardMetrics    (KPIs/cost/confidence, ACR-10)
 *   GET   /api/settings                   → SettingsView   (grouped knobs, ACR-10 Settings)
 *   PATCH /api/settings/:key              { approver, value } → { key, updated }  (writable only; 409 otherwise)
 */
export class ReviewApi {
  private server: Server | null = null;
  private readonly staticPageHtml?: string;
  private readonly authToken?: string;
  private readonly corsAllowOrigin?: string;
  private readonly auth?: ReviewApiOptions['auth'];

  constructor(
    private readonly review: ReviewUseCase,
    private readonly sourceReview: SourceReviewUseCase,
    private readonly team: TeamUseCase,
    private readonly alerts: AlertsUseCase,
    private readonly metrics: MetricsUseCase,
    private readonly settings: SettingsUseCase,
    private readonly evidenceStore: EvidenceStore,
    private readonly logger: Logger,
    options: ReviewApiOptions = {},
  ) {
    this.staticPageHtml = options.staticPageHtml;
    this.authToken = options.authToken;
    this.corsAllowOrigin = options.corsAllowOrigin;
    this.auth = options.auth;
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
    // Liveness probe stays OPEN (no auth) — every other /api/* path now requires a token.
    if (method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true });

    // Every gated /api/* read now requires a valid token (Phase 2 — reads were open before).
    // The test page (`GET /`), health, and the OPTIONS preflight stay unauthenticated.
    if (path.startsWith('/api/') && !(await this.requireRead(req, res))) return;

    // Aggregate review-queue counts (ACR-5). Exact path — must precede the
    // `/api/candidates/:id...` patterns + the `/api/candidates` list below.
    if (method === 'GET' && path === '/api/candidates/counts') {
      return sendJson(res, 200, await this.review.candidateCounts());
    }

    // Pending-queue freshness age-buckets (ACR-9). Exact path — must precede the
    // `/api/candidates/:id...` matchers + the `/api/candidates` list below.
    if (method === 'GET' && path === '/api/candidates/freshness') {
      return sendJson(res, 200, await this.metrics.queueFreshness());
    }

    if (method === 'GET' && path === '/api/candidates') {
      const parsed = parseCandidateQuery(url.searchParams);
      if (!parsed.ok) return sendError(res, 400, parsed.error);
      const views = await this.review.listCandidates(parsed.value);
      // Project each evidence bundle to the admin DTO — adding the gated authed-path
      // artifact URLs (`/api/evidence/:id/:kind`) so the panel can render the captured
      // screenshot + link the HTML/terms (ACR-13), not just an opaque store key. The
      // deal is passed through unchanged (the review console sees the full internal
      // record; only the public DTO is an allow-list).
      const body = views.map((view) => ({
        deal: view.deal,
        evidence: toAdminEvidence(view.evidence),
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
    // Admin "Published deals" screen (ACR-10): live + unpublished publication history.
    if (method === 'GET' && path === '/api/published') {
      const parsed = parsePageQuery(
        url.searchParams,
        ADMIN_PUBLISHED_MAX_LIMIT,
        ADMIN_PUBLISHED_MAX_OFFSET,
      );
      if (!parsed.ok) return sendError(res, 400, parsed.error);
      return sendJson(res, 200, await this.review.adminPublished(parsed.value));
    }
    // Today's reviewer throughput (ACR-6). `period` is `today` (the only supported
    // window in v1); any other value is a 400 rather than silently ignored.
    if (method === 'GET' && path === '/api/metrics/throughput') {
      const period = url.searchParams.get('period');
      if (period !== null && period !== '' && period !== 'today') {
        return sendError(res, 400, "period must be 'today'");
      }
      return sendJson(res, 200, await this.metrics.throughputToday());
    }
    // Metrics screen rollup (ACR-10 Metrics): KPIs + cost-per-day + confidence dist.
    if (method === 'GET' && path === '/api/metrics') {
      return sendJson(res, 200, await this.metrics.dashboardMetrics());
    }
    // Settings (ACR-10 Settings): grouped read of the panel-editable + read-only knobs.
    if (method === 'GET' && path === '/api/settings') {
      return sendJson(res, 200, await this.settings.getSettings());
    }
    if (method === 'GET' && path === '/api/manual-capture-tasks') {
      return sendJson(res, 200, await this.review.listManualCaptureTasks());
    }

    const promote = path.match(/^\/api\/field-proposals\/([^/]+)\/promote$/);
    if (method === 'POST' && promote) {
      const identity = await this.requireWrite(req, res, 'field-proposals:promote');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = PromoteBody.safeParse(body);
      if (!parsed.success)
        return sendError(res, 400, 'approver, canonical_key and label are required');
      return this.mapErrors(res, async () => {
        const entry = await this.review.promoteFieldProposal({
          approver: this.approverFor(identity, parsed.data.approver),
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
      const identity = await this.requireWrite(req, res, 'manual-capture:write');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = CreateManualBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver, fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.createManualCapture(
          this.approverFor(identity, parsed.data.approver),
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

    const completeManual = path.match(
      new RegExp(`^/api/manual-capture-tasks/(${UUID_SEG})/complete$`),
    );
    if (method === 'POST' && completeManual) {
      const identity = await this.requireWrite(req, res, 'manual-capture:write');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = CompleteManualBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver, fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.completeManualCapture(
          decodeURIComponent(completeManual[1]!),
          this.approverFor(identity, parsed.data.approver),
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

    const reviews = path.match(new RegExp(`^/api/candidates/(${UUID_SEG})/reviews$`));
    if (method === 'GET' && reviews) {
      return sendJson(res, 200, await this.review.listReviews(decodeURIComponent(reviews[1]!)));
    }

    // Gated reviewer evidence-fetch (the authed complement of the screenshot-only
    // public CDN): stream ONE artifact's bytes for a bundle. `:artifact` is pinned to
    // the closed kind set in the route regex, so an unknown kind (or a path like `..`)
    // simply doesn't match → 404, and the store is never handed an arbitrary path.
    // This is the ONLY gated GET — evidence bytes (raw HTML + verbatim copyrighted
    // terms) are sensitive, so unlike the other reads it requires the bearer.
    const evidenceArtifact = path.match(
      new RegExp(`^/api/evidence/(${UUID_SEG})/(screenshot|html|terms)$`),
    );
    if (method === 'GET' && evidenceArtifact) {
      // The one read with a NAMED permission: evidence bytes (raw HTML + verbatim
      // copyrighted terms) are sensitive, so a JWT identity must hold `evidence:read`
      // (the blanket read-gate above already required a valid token).
      if ((await this.requireWrite(req, res, 'evidence:read')) === null) return;
      const id = decodeURIComponent(evidenceArtifact[1]!);
      const kind = evidenceArtifact[2] as EvidenceArtifactKind;
      const artifact = await this.evidenceStore.getArtifact(id, kind);
      if (artifact === null) return sendError(res, 404, 'evidence artifact not found');
      return sendBytes(res, artifact.contentType, artifact.bytes);
    }

    // Edit a candidate's reviewer-correctable fields before approve. PATCH on the
    // candidate resource itself (no /edit suffix) — the verb carries the intent.
    const editCandidate = path.match(new RegExp(`^/api/candidates/(${UUID_SEG})$`));
    if (method === 'PATCH' && editCandidate) {
      const identity = await this.requireWrite(req, res, 'candidate:edit');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = EditCandidateBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver and patch are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.editCandidate(
          decodeURIComponent(editCandidate[1]!),
          this.approverFor(identity, parsed.data.approver),
          parsed.data.patch,
        );
        sendJson(res, 200, { deal });
      });
    }

    const approve = path.match(new RegExp(`^/api/candidates/(${UUID_SEG})/approve$`));
    if (method === 'POST' && approve) {
      const identity = await this.requireWrite(req, res, 'candidate:approve');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveCandidateBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        // The reviewer may set the EU-Omnibus affiliate disclosure at approve-time.
        // When OMITTED, fall back to the pipeline-owned default from settings (ACR-10;
        // an admin may set it false). The default still resolves true unless overridden,
        // preserving the safe over-disclose posture. Passed explicitly so the override
        // takes effect; the reviewer-set value (when present) always wins.
        const affiliateDisclosure =
          parsed.data.affiliate_disclosure ?? (await this.settings.defaultAffiliateDisclosure());
        const deal = await this.review.approve(
          decodeURIComponent(approve[1]!),
          this.approverFor(identity, parsed.data.approver),
          { affiliateDisclosure },
        );
        sendJson(res, 200, { deal });
      });
    }

    const reject = path.match(new RegExp(`^/api/candidates/(${UUID_SEG})/reject$`));
    if (method === 'POST' && reject) {
      const identity = await this.requireWrite(req, res, 'candidate:reject');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = RejectBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.reject(
          decodeURIComponent(reject[1]!),
          this.approverFor(identity, parsed.data.approver),
          parsed.data.reason,
        );
        sendJson(res, 200, { deal });
      });
    }

    // ── Sources registry (ACR-10) ────────────────────────────────────────────
    // Exact `/api/sources` — distinct from `/api/sources/pending` (the queue) and
    // `/api/sources/:id/...` below. GET lists the operational registry; POST adds one.
    if (method === 'GET' && path === '/api/sources') {
      return sendJson(res, 200, { sources: await this.sourceReview.listRegistry() });
    }
    if (method === 'POST' && path === '/api/sources') {
      const identity = await this.requireWrite(req, res, 'sources:write');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = CreateSourceBody.safeParse(body);
      if (!parsed.success)
        return sendError(res, 400, 'approver, domain, kind and tier are required');
      return this.mapErrors(res, async () => {
        const { source, created } = await this.sourceReview.createSource({
          approver: this.approverFor(identity, parsed.data.approver),
          domain: parsed.data.domain,
          kind: parsed.data.kind,
          tier: parsed.data.tier,
          country: parsed.data.country,
          cadenceDays: parsed.data.cadence_days,
        });
        // 201 when a new source was created; 200 when an existing one was updated.
        sendJson(res, created ? 201 : 200, { id: source.id, created });
      });
    }

    // ── Team & profile (ACR-10 Team + ACR-11 Profile) ────────────────────────
    if (method === 'GET' && path === '/api/team') {
      return sendJson(res, 200, { members: await this.team.listTeam() });
    }
    if (method === 'POST' && path === '/api/team') {
      const identity = await this.requireWrite(req, res, 'team:manage');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = InviteMemberBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver, name and email are required');
      return this.mapErrors(res, async () => {
        const member = await this.team.inviteMember({
          approver: this.approverFor(identity, parsed.data.approver),
          name: parsed.data.name,
          email: parsed.data.email,
          role: parsed.data.role,
        });
        sendJson(res, 201, { id: member.id, invited: true, email: member.email });
      });
    }
    if (method === 'PATCH' && path === '/api/profile') {
      // Self-service (any authed user editing their OWN row) — no named permission. The
      // approver IS the actor: for a JWT it is the token's email, so a user can only ever
      // edit their own profile (the use-case keys the update on the approver's email).
      const identity = await this.authenticate(req);
      if (identity === null) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = UpdateProfileBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver and name are required');
      return this.mapErrors(res, async () => {
        const member = await this.team.updateProfile(
          this.approverFor(identity, parsed.data.approver),
          parsed.data.name,
        );
        sendJson(res, 200, { updated: true, name: member.name });
      });
    }

    // Update one writable setting (ACR-10 Settings). A read-only / unknown key is a 409.
    const updateSetting = path.match(/^\/api\/settings\/([^/]+)$/);
    if (method === 'PATCH' && updateSetting) {
      const identity = await this.requireWrite(req, res, 'settings:write');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = UpdateSettingBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver and value are required');
      return this.mapErrors(res, async () => {
        const result = await this.settings.updateSetting(
          decodeURIComponent(updateSetting[1]!),
          this.approverFor(identity, parsed.data.approver),
          parsed.data.value,
        );
        sendJson(res, 200, result);
      });
    }

    // ── Alerts (ACR-8) ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/alerts') {
      const limit = parseIntParam(url.searchParams.get('limit'), ALERTS_DEFAULT_LIMIT);
      if (limit === null || limit < 1 || limit > ALERTS_MAX_LIMIT) {
        return sendError(res, 400, `limit must be 1..${ALERTS_MAX_LIMIT}`);
      }
      return sendJson(res, 200, await this.alerts.listAlerts(limit));
    }
    const ackAlert = path.match(new RegExp(`^/api/alerts/(${UUID_SEG})/acknowledge$`));
    if (method === 'POST' && ackAlert) {
      const identity = await this.requireWrite(req, res, 'alerts:manage');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        await this.alerts.acknowledge(
          decodeURIComponent(ackAlert[1]!),
          this.approverFor(identity, parsed.data.approver),
        );
        sendJson(res, 200, { acknowledged: true });
      });
    }
    const resolveAlert = path.match(new RegExp(`^/api/alerts/(${UUID_SEG})/resolve$`));
    if (method === 'POST' && resolveAlert) {
      const identity = await this.requireWrite(req, res, 'alerts:manage');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        await this.alerts.resolve(
          decodeURIComponent(resolveAlert[1]!),
          this.approverFor(identity, parsed.data.approver),
        );
        sendJson(res, 200, { resolved: true });
      });
    }

    // ── Source-promotion loop ────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/sources/pending') {
      return sendJson(res, 200, await this.sourceReview.listPending());
    }
    const sourceReviews = path.match(new RegExp(`^/api/sources/(${UUID_SEG})/reviews$`));
    if (method === 'GET' && sourceReviews) {
      return sendJson(
        res,
        200,
        await this.sourceReview.listReviews(decodeURIComponent(sourceReviews[1]!)),
      );
    }
    const approveSource = path.match(new RegExp(`^/api/sources/(${UUID_SEG})/approve$`));
    if (method === 'POST' && approveSource) {
      const identity = await this.requireWrite(req, res, 'sources:review');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = ApproveBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.approveSource(
          decodeURIComponent(approveSource[1]!),
          this.approverFor(identity, parsed.data.approver),
        );
        sendJson(res, 200, { source });
      });
    }
    const rejectSource = path.match(new RegExp(`^/api/sources/(${UUID_SEG})/reject$`));
    if (method === 'POST' && rejectSource) {
      const identity = await this.requireWrite(req, res, 'sources:review');
      if (identity === null) return;
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = RejectBody.safeParse(body);
      if (!parsed.success) return sendError(res, 400, 'approver is required');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.rejectSource(
          decodeURIComponent(rejectSource[1]!),
          this.approverFor(identity, parsed.data.approver),
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

  /**
   * Authenticate a gated `/api/*` request (Auth/IAM, Phase 2). Returns the verified
   * {@link Identity}, or `null` (the caller 401s — a UNIFORM `{ error: 'unauthorized' }`
   * so a probe can't tell "no token" from "bad/expired/revoked token"). DUAL-ACCEPT: a
   * per-user ES256 JWT is preferred; the legacy static token is accepted alongside it.
   *
   * JWT path (the headline fix — identity is proven, never trusted from the body):
   *   1. `tokenIssuer.verifyAccess` PINS `algorithms:['ES256']` + checks iss/aud/exp/sig.
   *      Any failure (alg swap, `alg:none`, tamper, expiry, wrong realm) ⇒ null.
   *   2. Reload the user; a deleted/disabled user's still-unexpired token is dead.
   *   3. `claims.token_version !== user.token_version` ⇒ null (IMMEDIATE revoke lever).
   *   4. On a `perm_version` mismatch, RE-RESOLVE perms from the DB (so a mid-token
   *      permission change is honoured before exp); else trust the token's `perms`.
   *
   * Open mode: when NEITHER a signing key (`this.auth`) NOR a legacy token is configured,
   * the surface is open (trusted-network) — returns a `legacy` identity so handlers run.
   */
  private async authenticate(req: IncomingMessage): Promise<Identity | null> {
    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    const bearer = header.startsWith(prefix) ? header.slice(prefix.length) : null;

    // Legacy static token (constant-time) — accepted during the dual-accept window. It
    // carries NO identity (no email/perms): it must never become a synthetic actor on the
    // email-keyed reviews trail; a legacy caller's `approver` still comes from the body.
    if (bearer !== null && this.authToken !== undefined && safeEqual(bearer, this.authToken)) {
      return { kind: 'legacy' };
    }

    // Per-user JWT path (when auth is wired and the bearer isn't the legacy token).
    if (bearer !== null && this.auth !== undefined) {
      const claims = await this.auth.tokenIssuer.verifyAccess(bearer).catch(() => null);
      if (claims === null) return null;
      const user = await this.auth.db.users.getById(claims.sub);
      if (user === null || user.status !== 'active') return null;
      if (claims.token_version !== user.token_version) return null; // immediate revoke
      const currentPermVersion = await this.auth.db.authMeta.getPermVersion();
      const perms =
        claims.perm_version === currentPermVersion
          ? new Set<Permission>(claims.perms)
          : await this.auth.authorization.permissionsForUser(user.id);
      const role = await this.auth.db.roles.getById(user.role_id);
      return {
        kind: 'jwt',
        userId: user.id,
        email: user.email,
        role: role?.name ?? '',
        perms,
      };
    }

    // No bearer (or bearer present but no JWT wiring and not the legacy token):
    // open mode ONLY when neither credential is configured at all.
    if (this.authToken === undefined && this.auth === undefined) return { kind: 'legacy' };
    return null;
  }

  /**
   * Guard a WRITE handler: authenticate, then require the route's permission. Returns the
   * `Identity` to use, or `null` after sending the 401/403 (the caller returns early). A
   * `jwt` identity must hold `permission`; a `legacy` identity is the all-or-nothing static
   * token (the old behaviour) and skips the per-permission check. The `approver` the handler
   * records is resolved via {@link approverFor}, never read straight from the body.
   */
  private async requireWrite(
    req: IncomingMessage,
    res: ServerResponse,
    permission: Permission,
  ): Promise<Identity | null> {
    const identity = await this.authenticate(req);
    if (identity === null) {
      sendError(res, 401, 'unauthorized');
      return null;
    }
    if (identity.kind === 'jwt' && !hasPermission(identity.perms, permission)) {
      sendError(res, 403, 'forbidden');
      return null;
    }
    return identity;
  }

  /**
   * Guard a READ handler: a valid token (JWT or legacy) is now required (the Phase-2
   * "all `/api/*` reads require auth" change — reads were open before). No named permission
   * for a bare GET. Returns true when authorised; otherwise sends 401 and returns false.
   */
  private async requireRead(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const identity = await this.authenticate(req);
    if (identity === null) {
      sendError(res, 401, 'unauthorized');
      return false;
    }
    return true;
  }

  /**
   * The actor to record as `approver`/`actor` on an audited action. For a JWT identity it
   * is the TOKEN's verified email — the body field is IGNORED (the headline trust fix); a
   * JWT caller need not send one. For the legacy static token (no identity) it falls back to
   * the body `approver` (the pre-Phase-2 behaviour), so the dual-accept window never
   * fabricates a synthetic actor. A legacy caller that omits the approver gets `''`, which
   * the use-case rejects with `MissingApproverError` (400) exactly as before.
   */
  private approverFor(identity: Identity, bodyApprover: string | undefined): string {
    return identity.kind === 'jwt' ? identity.email : (bodyApprover ?? '');
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
      if (err instanceof SourceConflictError) return sendError(res, 409, err.message);
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
      if (err instanceof SettingNotWritableError) return sendError(res, 409, err.message);
      // Auth/IAM errors (PermissionDenied 403, etc.) share the central mapper so the auth
      // statuses are defined once and can't drift from AuthApi's.
      if (tryMapAuthError(res, err)) return;
      throw err;
    }
  }

  private servePage(res: ServerResponse): void {
    if (!this.staticPageHtml) return sendError(res, 404, 'No test page configured');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(this.staticPageHtml);
  }
}

// `approver` is OPTIONAL at the HTTP boundary across all write bodies (Auth/IAM Phase 2):
// a per-user JWT supplies the actor from its verified email (the body field is ignored —
// `approverFor`), and a legacy static-token caller still sends it in the body. A legacy
// caller that omits it reaches `MissingApproverError` → 400 in the use-case, unchanged.
const ApproveBody = z.object({ approver: z.string().min(1).optional() });
/** Candidate approve also accepts the reviewer's EU-Omnibus affiliate disclosure (optional). */
const ApproveCandidateBody = z.object({
  approver: z.string().min(1).optional(),
  affiliate_disclosure: z.boolean().optional(),
});
const RejectBody = z.object({
  approver: z.string().min(1).optional(),
  reason: z.string().optional(),
});
/** Invite / register a team member (ACR-10 Team). */
const InviteMemberBody = z.object({
  approver: z.string().min(1).optional(),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
});
/** Update the signed-in reviewer's own display name (ACR-11 Profile). */
const UpdateProfileBody = z.object({
  approver: z.string().min(1).optional(),
  name: z.string().min(1),
});
/**
 * Update one writable setting (ACR-10 Settings). `value` is loosely typed at the HTTP
 * boundary (a toggle sends a boolean, a value chip a string/number); the pure
 * `validateSettingValue` domain rule is the real, per-key validator.
 */
const UpdateSettingBody = z.object({
  approver: z.string().min(1).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
/** Register a new operational source from the admin "+ Add source" flow (ACR-10). */
const CreateSourceBody = z.object({
  approver: z.string().min(1).optional(),
  domain: z.string().min(1),
  kind: z.string().min(1),
  tier: z.number().int(),
  country: z.string().min(1).optional(),
  cadence_days: z.number().int().positive().optional(),
});

/**
 * PATCH candidate edit. `patch` is an opaque object — the deeper allowlist +
 * sub-schema validation happens in the pure domain rule (applyCandidatePatch),
 * which the use-case calls, so the HTTP boundary only checks the envelope.
 */
const EditCandidateBody = z.object({
  approver: z.string().min(1).optional(),
  patch: z.record(z.unknown()),
});
/** Promote a field proposal into the condition vocabulary. */
const PromoteBody = z.object({
  approver: z.string().min(1).optional(),
  canonical_key: z.string().min(1),
  label: z.string().min(1),
  target: z.enum(['vocabulary', 'field']).default('vocabulary'),
});
/** Human deal fields + referenced evidence — shared by complete + ad-hoc create. */
const ManualCaptureBody = z.object({
  approver: z.string().min(1).optional(),
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

/**
 * Parse a bare `?limit=&offset=` page query, bounded to the given caps (an over-cap
 * / negative / non-integer value is a 400, never a silent clamp). Default offset 0,
 * default limit 50 (the common review default). Shared by the admin published +
 * sources-registry list endpoints.
 */
function parsePageQuery(
  params: URLSearchParams,
  maxLimit: number,
  maxOffset: number,
): ParseResult<{ limit: number; offset: number }> {
  const limit = parseIntParam(params.get('limit'), 50);
  if (limit === null || limit < 1 || limit > maxLimit) {
    return { ok: false, error: `limit must be 1..${maxLimit}` };
  }
  const offset = parseIntParam(params.get('offset'), 0);
  if (offset === null || offset < 0 || offset > maxOffset) {
    return { ok: false, error: `offset must be 0..${maxOffset}` };
  }
  return { ok: true, value: { limit, offset } };
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
