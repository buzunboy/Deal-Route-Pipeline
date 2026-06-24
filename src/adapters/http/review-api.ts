import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { z } from 'zod';
import {
  MALFORMED,
  TOO_LARGE,
  readBody,
  sendJson,
  sendError,
  sendBytes,
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
  type ProvisionUserUseCase,
  type ManageRolesUseCase,
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
import {
  type EvidenceArtifactKind,
  type Permission,
  hasPermission,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  UserNotFoundError,
} from '../../domain/index.js';
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
 * The verified identity behind a gated `/api/*` request (Auth/IAM). Since Phase 5 there is
 * ONE shape: a per-user ES256 token. Identity + permissions come from the VERIFIED claims —
 * `email` becomes the `approver` on every audited decision and a body `approver` is ignored
 * entirely (the headline trust fix). The legacy static-token "dual-accept" identity was
 * RETIRED in Phase 5: there is no un-credentialed/static path and no synthetic actor can
 * ever land on the email-keyed reviews audit trail.
 */
export type Identity = {
  kind: 'jwt';
  userId: string;
  email: string;
  role: string;
  perms: Set<Permission>;
};

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
   * `Access-Control-Allow-Origin` for the browser admin panel that consumes this
   * API cross-origin. UNSET ⇒ no CORS headers are emitted (same-origin / server-to-
   * server callers only) — the safe default. When set it is echoed verbatim and the
   * preflight advertises the `Authorization` header + the state-changing methods, so
   * a browser can send the bearer. Deliberately NOT wildcardable here: this surface
   * is credentialed and state-changing, so the caller pins it to the panel's origin.
   */
  corsAllowOrigin?: string;
  /**
   * Auth/IAM per-user JWT wiring — the ONLY authentication path since Phase 5. A request
   * authenticates with a per-user ES256 bearer (verified by `tokenIssuer`, the user reloaded
   * via `db`, perms resolved via `authorization`); identity + permissions come from the
   * verified claims. `serve.ts` HARD-FAILS at startup when no signing key is configured, so
   * in production this is ALWAYS wired. When ABSENT (a unit-test construction that doesn't
   * exercise auth), EVERY `/api/*` request 401s — there is no static-token or open fallback.
   */
  auth?: {
    tokenIssuer: TokenIssuer;
    db: Database;
    authorization: AuthorizationUseCase;
    /** Auth/IAM (Phase 3): the Users & Roles admin use-cases backing `/api/users` + `/api/roles`. */
    provisionUser: ProvisionUserUseCase;
    manageRoles: ManageRolesUseCase;
  };
}

/**
 * HTTP review API — the DURABLE CONTRACT the future production admin panel (and
 * the existing prototype's Verify screen) will consume. The built-in test page is
 * only a thin harness over these same endpoints; all review actions live here.
 *
 * Built on Node's `http` (no framework dependency) to stay light and swappable.
 * Read endpoints are GET; state changes are POST with a JSON body. Nothing here
 * publishes automatically — `approve` requires an authenticated reviewer.
 *
 * Auth/IAM Phase 5: EVERY `/api/*` request (reads + writes) requires a per-user ES256
 * bearer (only `GET /api/health` is open). The `approver`/`actor` recorded on an audited
 * action is ALWAYS the verified token email — request bodies carry NO `approver` field.
 *
 *   GET   /api/health
 *   GET   /api/candidates/counts          → CandidateCounts  (queue view-cards, ACR-5)
 *   GET   /api/candidates/freshness       → [FreshnessBand]  (queue age-buckets, ACR-9)
 *   GET   /api/candidates                 → [{ deal, evidence }]
 *           ?status=&service=&confidence_max=&limit=&offset=  (filters + pagination)
 *   PATCH /api/candidates/:id             { patch }     → { deal }  (reviewer edit)
 *   POST  /api/candidates/:id/approve     { affiliate_disclosure? } → { deal }
 *   POST  /api/candidates/:id/reject      { reason? }   → { deal }
 *   GET   /api/candidates/:id/reviews     → [ReviewRecord]   (audit history)
 *   GET   /api/evidence/:id/:artifact     → raw bytes   (artifact ∈ screenshot|html|terms)
 *   GET   /api/field-proposals            → [FieldProposalRecord]
 *   GET   /api/audit                      → { entries: [AuditEntry] }   (ACR-7)
 *           ?actor=&entity_id=&since=&limit=
 *   GET   /api/published                  → { deals: [AdminPublishedDeal], total }  (ACR-10)
 *           ?limit=&offset=
 *   POST  /api/field-proposals/:key/promote
 *           { canonical_key, label, target } → { vocabulary_entry }
 *   GET   /api/manual-capture-tasks       → [ManualCaptureTask]
 *   POST  /api/manual-capture-tasks       { fields, evidence } → { created, candidate_id }  (ad-hoc, ACR-12)
 *   POST  /api/manual-capture-tasks/:id/complete
 *           { fields, evidence } → { deal }  (creates a candidate; never publishes)
 *   GET   /api/sources                    → { sources: [SourceRegistryEntry] }   (registry, ACR-10)
 *   POST  /api/sources                    { domain, kind, tier } → { id, created }  (ACR-10)
 *   GET   /api/sources/pending            → [Source]   (proposed sources)
 *   POST  /api/sources/:id/approve        { }            → { source }
 *   POST  /api/sources/:id/reject         { reason? }   → { source }
 *   GET   /api/sources/:id/reviews        → [SourceReviewRecord]  (audit history)
 *   GET   /api/team                       → { members: [TeamMemberView] }   (ACR-10)
 *   POST  /api/team                       { name, email, role? } → { id, invited, email }  (ACR-10)
 *   PATCH /api/profile                    { name } → { updated, name }   (ACR-11)
 *   GET   /api/alerts                     → { alerts: [AlertView], open_count }   (ACR-8)
 *   POST  /api/alerts/:id/acknowledge     { } → { acknowledged }   (ACR-8)
 *   POST  /api/alerts/:id/resolve         { } → { resolved }   (ACR-8)
 *   GET   /api/metrics/throughput         → ThroughputSummary   (today's reviewer throughput, ACR-6)
 *           ?period=today
 *   GET   /api/metrics                    → DashboardMetrics    (KPIs/cost/confidence, ACR-10)
 *   GET   /api/settings                   → SettingsView   (grouped knobs, ACR-10 Settings)
 *   PATCH /api/settings/:key              { value } → { key, updated }  (writable only; 409 otherwise)
 */
export class ReviewApi {
  private server: Server | null = null;
  private readonly staticPageHtml?: string;
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
      if (!parsed.success) return sendError(res, 400, 'canonical_key and label are required');
      return this.mapErrors(res, async () => {
        const entry = await this.review.promoteFieldProposal({
          approver: this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.createManualCapture(
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'fields and evidence are required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.completeManualCapture(
          decodeURIComponent(completeManual[1]!),
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'patch is required');
      return this.mapErrors(res, async () => {
        const deal = await this.review.editCandidate(
          decodeURIComponent(editCandidate[1]!),
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
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
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
      return this.mapErrors(res, async () => {
        const deal = await this.review.reject(
          decodeURIComponent(reject[1]!),
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'domain, kind and tier are required');
      return this.mapErrors(res, async () => {
        const { source, created } = await this.sourceReview.createSource({
          approver: this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'name and email are required');
      return this.mapErrors(res, async () => {
        const member = await this.team.inviteMember({
          approver: this.approverFor(identity),
          name: parsed.data.name,
          email: parsed.data.email,
          role: parsed.data.role,
        });
        sendJson(res, 201, { id: member.id, invited: true, email: member.email });
      });
    }
    if (method === 'PATCH' && path === '/api/profile') {
      // Self-service (any authed user editing their OWN row) — no named permission. The
      // actor IS the identity: for a JWT it is the token's email, so a user can only ever
      // edit their own profile / change their own password (both keyed on the actor's email;
      // a `newPassword` change additionally PROVES the current password — that proof, not a
      // permission, is the authorization).
      const identity = await this.authenticate(req);
      if (identity === null) return sendError(res, 401, 'unauthorized');
      const body = await readBody(req);
      if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
      if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
      const parsed = UpdateProfileBody.safeParse(body);
      if (!parsed.success) {
        return sendError(res, 400, 'name, or currentPassword + newPassword, is required');
      }
      const wantsPasswordChange = parsed.data.newPassword !== undefined;
      // `authenticate` already returned a verified JWT identity above (it returns null when
      // `this.auth` is unset), so the IdP use-cases (`this.auth!`) are guaranteed present here.
      return this.mapErrors(res, async () => {
        const actor = this.approverFor(identity);
        // Apply the password change FIRST so a wrong current-password (401) aborts the whole
        // patch BEFORE a name write lands — the verify is the authorization for the request.
        if (wantsPasswordChange) {
          await this.auth!.manageRoles.changeOwnPassword({
            actor,
            currentPassword: parsed.data.currentPassword!,
            newPassword: parsed.data.newPassword!,
          });
        }
        const member =
          parsed.data.name !== undefined
            ? await this.team.updateProfile(actor, parsed.data.name)
            : await this.team.getProfile(actor);
        // `name` stays in the response (the ACR-11 contract); `password_changed` flags the
        // self-service change so the panel can prompt a re-login (the token is now stale).
        sendJson(res, 200, {
          updated: true,
          name: member?.name ?? null,
          password_changed: wantsPasswordChange,
        });
      });
    }

    // ── Users & Roles admin (Auth/IAM Phase 3) ───────────────────────────────
    // The runtime IAM surface. Gated `team:manage` (users) / `roles:manage` (roles);
    // `GET /api/permissions/me` is any-authed. These only exist when the IdP is wired
    // (the `auth` bag) — without it they fall through to 404 (no use-cases to serve them).
    if (this.auth !== undefined) {
      const handled = await this.handleAdminIam(req, res, method, path);
      if (handled) return;
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
      if (!parsed.success) return sendError(res, 400, 'value is required');
      return this.mapErrors(res, async () => {
        const result = await this.settings.updateSetting(
          decodeURIComponent(updateSetting[1]!),
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
      return this.mapErrors(res, async () => {
        await this.alerts.acknowledge(decodeURIComponent(ackAlert[1]!), this.approverFor(identity));
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
      return this.mapErrors(res, async () => {
        await this.alerts.resolve(decodeURIComponent(resolveAlert[1]!), this.approverFor(identity));
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.approveSource(
          decodeURIComponent(approveSource[1]!),
          this.approverFor(identity),
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
      if (!parsed.success) return sendError(res, 400, 'invalid request body');
      return this.mapErrors(res, async () => {
        const source = await this.sourceReview.rejectSource(
          decodeURIComponent(rejectSource[1]!),
          this.approverFor(identity),
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
    // DELETE is advertised for `DELETE /api/roles/:name` (Auth/IAM Phase 3).
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
    // The origin is pinned (not `*`), so the response varies by Origin — let caches
    // key on it rather than serving one origin's headers to another.
    res.setHeader('vary', 'Origin');
  }

  /**
   * Authenticate a gated `/api/*` request (Auth/IAM). Returns the verified {@link Identity},
   * or `null` (the caller 401s — a UNIFORM `{ error: 'unauthorized' }` so a probe can't tell
   * "no token" from "bad/expired/revoked token"). Since Phase 5 there is ONE path: a per-user
   * ES256 JWT. The legacy static-token dual-accept + the open trusted-network mode are GONE —
   * an unwired `auth` (a unit-test construction) means EVERY request 401s, and `serve.ts`
   * hard-fails at startup without a signing key, so production always wires it.
   *
   * JWT path (the headline fix — identity is proven, never trusted from the body):
   *   1. `tokenIssuer.verifyAccess` PINS `algorithms:['ES256']` + checks iss/aud/exp/sig.
   *      Any failure (alg swap, `alg:none`, tamper, expiry, wrong realm) ⇒ null.
   *   2. Reload the user; a deleted/disabled user's still-unexpired token is dead.
   *   3. `claims.token_version !== user.token_version` ⇒ null (IMMEDIATE revoke lever).
   *   4. On a `perm_version` mismatch, RE-RESOLVE perms from the DB (so a mid-token
   *      permission change is honoured before exp); else trust the token's `perms`.
   */
  private async authenticate(req: IncomingMessage): Promise<Identity | null> {
    // No auth wired ⇒ no path to authenticate (unit-test construction only; production
    // hard-fails at startup without a signing key). Deny — there is no open/static fallback.
    if (this.auth === undefined) return null;

    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    const bearer = header.startsWith(prefix) ? header.slice(prefix.length) : null;
    if (bearer === null) return null;

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

  /**
   * Guard a WRITE handler: authenticate, then require the route's permission. Returns the
   * `Identity` to use, or `null` after sending the 401/403 (the caller returns early). The
   * verified token must hold `permission`. The `approver` the handler records is the token's
   * email ({@link approverFor}), never read from the body.
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
    if (!hasPermission(identity.perms, permission)) {
      sendError(res, 403, 'forbidden');
      return null;
    }
    return identity;
  }

  /**
   * Guard a READ handler: a valid per-user token is required (the "all `/api/*` reads require
   * auth" rule). No named permission for a bare GET. Returns true when authorised; otherwise
   * sends 401 and returns false.
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
   * The actor to record as `approver`/`actor` on an audited action: ALWAYS the verified
   * TOKEN email. The body is never consulted — there is no body `approver` field anymore
   * (Phase 5). A JWT always carries an email, so this is total.
   */
  private approverFor(identity: Identity): string {
    return identity.email;
  }

  /**
   * The Users & Roles admin endpoints (Auth/IAM Phase 3). Returns `true` once it has
   * matched + answered a request, `false` if none matched (so `handle` continues to its
   * other routes / catch-all 404). Only called when {@link auth} is wired, so
   * `this.auth.provisionUser`/`manageRoles` are guaranteed present.
   *
   * Gating: user endpoints require `team:manage`, role endpoints `roles:manage`, the
   * permission CATALOGUE `roles:manage`; `GET /api/permissions/me` is any valid token.
   * `PATCH /api/users/:id` additionally allows the SELF path (a user editing their own
   * name) without `team:manage` — role/status/password sub-fields stay `team:manage`-gated.
   * The actor recorded for the audit line is always token-derived (never the body).
   */
  private async handleAdminIam(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<boolean> {
    const auth = this.auth!;

    // ── Permissions ──
    if (method === 'GET' && path === '/api/permissions/me') {
      const identity = await this.authenticate(req);
      if (identity === null) {
        sendError(res, 401, 'unauthorized');
        return true;
      }
      // The signed-in user's own resolved permission set (token-derived).
      sendJson(res, 200, {
        email: identity.email,
        role: identity.role,
        permissions: [...identity.perms].sort(),
      });
      return true;
    }
    if (method === 'GET' && path === '/api/permissions') {
      const identity = await this.requireWrite(req, res, 'roles:manage');
      if (identity === null) return true;
      // The seeded catalogue, enumerated from the closed enum (key+label co-located in
      // permission.ts) so the panel role editor can render every key + its label without
      // the enum shipping to the client.
      sendJson(res, 200, {
        permissions: ALL_PERMISSIONS.map((key) => ({ key, label: PERMISSION_LABELS[key] })),
      });
      return true;
    }

    // ── Users ──
    if (method === 'GET' && path === '/api/users') {
      const identity = await this.requireWrite(req, res, 'team:manage');
      if (identity === null) return true;
      sendJson(res, 200, { users: await auth.manageRoles.listUsers() });
      return true;
    }
    if (method === 'POST' && path === '/api/users') {
      const identity = await this.requireWrite(req, res, 'team:manage');
      if (identity === null) return true;
      const body = await readBody(req);
      if (body === TOO_LARGE) return (sendError(res, 413, 'request body too large'), true);
      if (body === MALFORMED) return (sendError(res, 400, 'malformed JSON body'), true);
      const parsed = CreateUserBody.safeParse(body);
      if (!parsed.success) {
        return (sendError(res, 400, 'name, email, role and password are required'), true);
      }
      await this.mapErrors(res, async () => {
        const user = await auth.provisionUser.provision({
          actor: this.approverFor(identity),
          name: parsed.data.name,
          email: parsed.data.email,
          roleName: parsed.data.role,
          initialPassword: parsed.data.password,
        });
        sendJson(res, 201, { id: user.id, email: user.email, role: parsed.data.role });
      });
      return true;
    }
    const userPatch = path.match(new RegExp(`^/api/users/(${UUID_SEG})$`));
    if (method === 'PATCH' && userPatch) {
      // Authenticate first; the SELF path (own name) is allowed without team:manage, but
      // role/status/password require team:manage. Mirrors PATCH /api/profile's self-intent.
      const identity = await this.authenticate(req);
      if (identity === null) return (sendError(res, 401, 'unauthorized'), true);
      const body = await readBody(req);
      if (body === TOO_LARGE) return (sendError(res, 413, 'request body too large'), true);
      if (body === MALFORMED) return (sendError(res, 400, 'malformed JSON body'), true);
      const parsed = PatchUserBody.safeParse(body);
      if (!parsed.success) return (sendError(res, 400, 'invalid user patch'), true);
      const targetId = userPatch[1]!;
      const wantsAdminFields =
        parsed.data.role !== undefined ||
        parsed.data.status !== undefined ||
        parsed.data.password !== undefined;
      const isSelf = identity.userId === targetId;
      // Any privileged sub-field, OR editing another user at all, needs team:manage.
      const needsManage = wantsAdminFields || !isSelf;
      if (needsManage && !hasPermission(identity.perms, 'team:manage')) {
        return (sendError(res, 403, 'forbidden'), true);
      }
      await this.mapErrors(res, async () => {
        const actor = this.approverFor(identity);
        // The admin trio (role/status/password) is applied through ONE use-case that
        // validates everything up front, so a later invalid sub-field can't half-apply an
        // earlier one (it also single-bumps token_version + revokes refreshes on disable).
        const target =
          parsed.data.role !== undefined ||
          parsed.data.status !== undefined ||
          parsed.data.password !== undefined
            ? await auth.manageRoles.updateUser({
                actor,
                userId: targetId,
                role: parsed.data.role,
                status: parsed.data.status,
                password: parsed.data.password,
              })
            : await auth.db.users.getById(targetId);
        if (target === null) throw new UserNotFoundError(targetId);
        if (parsed.data.name !== undefined) {
          // The display-name edit reuses the self-or-admin profile path keyed on the TARGET
          // user's email (so an admin can rename another user too). Applied LAST; the only
          // way it can fail is a vanished row, which it can't half-apply over the trio.
          await this.team.updateProfile(target.email, parsed.data.name);
        }
        sendJson(res, 200, { updated: true });
      });
      return true;
    }

    // ── Roles ──
    if (method === 'GET' && path === '/api/roles') {
      const identity = await this.requireWrite(req, res, 'roles:manage');
      if (identity === null) return true;
      sendJson(res, 200, { roles: await auth.manageRoles.listRoles() });
      return true;
    }
    if (method === 'POST' && path === '/api/roles') {
      const identity = await this.requireWrite(req, res, 'roles:manage');
      if (identity === null) return true;
      const body = await readBody(req);
      if (body === TOO_LARGE) return (sendError(res, 413, 'request body too large'), true);
      if (body === MALFORMED) return (sendError(res, 400, 'malformed JSON body'), true);
      const parsed = CreateRoleBody.safeParse(body);
      if (!parsed.success) return (sendError(res, 400, 'name and permissions are required'), true);
      await this.mapErrors(res, async () => {
        const role = await auth.manageRoles.createRole({
          actor: this.approverFor(identity),
          name: parsed.data.name,
          description: parsed.data.description,
          permissions: parsed.data.permissions,
        });
        sendJson(res, 201, { role });
      });
      return true;
    }
    // `/api/roles/:name` — role names are free-form string keys (like settings/:key), so a
    // `[^/]+` capture, NOT the UUID matcher.
    const roleByName = path.match(/^\/api\/roles\/([^/]+)$/);
    if (method === 'PATCH' && roleByName) {
      const identity = await this.requireWrite(req, res, 'roles:manage');
      if (identity === null) return true;
      const body = await readBody(req);
      if (body === TOO_LARGE) return (sendError(res, 413, 'request body too large'), true);
      if (body === MALFORMED) return (sendError(res, 400, 'malformed JSON body'), true);
      const parsed = PatchRoleBody.safeParse(body);
      if (!parsed.success) return (sendError(res, 400, 'invalid role patch'), true);
      await this.mapErrors(res, async () => {
        const role = await auth.manageRoles.updateRole({
          actor: this.approverFor(identity),
          roleName: decodeURIComponent(roleByName[1]!),
          description: parsed.data.description,
          permissions: parsed.data.permissions,
        });
        sendJson(res, 200, { role });
      });
      return true;
    }
    if (method === 'DELETE' && roleByName) {
      const identity = await this.requireWrite(req, res, 'roles:manage');
      if (identity === null) return true;
      await this.mapErrors(res, async () => {
        await auth.manageRoles.deleteRole({
          actor: this.approverFor(identity),
          roleName: decodeURIComponent(roleByName[1]!),
        });
        sendJson(res, 200, { deleted: true });
      });
      return true;
    }

    return false;
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

// Auth/IAM Phase 5: write bodies carry NO `approver` field. The actor is ALWAYS the verified
// token email (`approverFor`); zod strips any `approver` a stale client still sends, so a
// forged body `approver` is silently ignored — never trusted, never recorded.
const ApproveBody = z.object({});
/** Candidate approve also accepts the reviewer's EU-Omnibus affiliate disclosure (optional). */
const ApproveCandidateBody = z.object({
  affiliate_disclosure: z.boolean().optional(),
});
const RejectBody = z.object({
  reason: z.string().optional(),
});
/** Invite / register a team member (ACR-10 Team). */
const InviteMemberBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
});
/**
 * Update the signed-in reviewer's OWN profile (ACR-11 Profile + Auth/IAM Phase 3 self-service
 * password). `name` edits the display name (unchanged); `currentPassword`+`newPassword`
 * together change the caller's own password (the current-password proof IS the authorization —
 * no `team:manage`). All fields optional, but at least one mutation must be present, and the
 * password fields are all-or-nothing (a `newPassword` without `currentPassword`, or vice-versa,
 * is a 400 — never a silent partial). The actor is token-derived; the body carries no `approver`.
 */
const UpdateProfileBody = z
  .object({
    name: z.string().min(1).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(1).optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.currentPassword !== undefined || b.newPassword !== undefined,
    {
      message: 'name or a password change is required',
    },
  )
  // Password change is all-or-nothing: both fields, or neither.
  .refine((b) => (b.currentPassword === undefined) === (b.newPassword === undefined), {
    message: 'currentPassword and newPassword must be supplied together',
  });
/**
 * Update one writable setting (ACR-10 Settings). `value` is loosely typed at the HTTP
 * boundary (a toggle sends a boolean, a value chip a string/number); the pure
 * `validateSettingValue` domain rule is the real, per-key validator.
 */
const UpdateSettingBody = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
});
/** Register a new operational source from the admin "+ Add source" flow (ACR-10). */
const CreateSourceBody = z.object({
  domain: z.string().min(1),
  kind: z.string().min(1),
  tier: z.number().int(),
  country: z.string().min(1).optional(),
  cadence_days: z.number().int().positive().optional(),
});

// ── Auth/IAM Phase 3 request bodies ──
// No `approver` field (Phase 5 — the actor is the verified token email). The `password`
// floor is enforced by the pure `validatePasswordPolicy` in the use-case, so the HTTP
// boundary only checks presence (min(1)) — never echoes the value.
/** Provision a login-capable user (POST /api/users) — gated `team:manage`. */
const CreateUserBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  password: z.string().min(1),
});
/** Patch a user (PATCH /api/users/:id): name self-or-admin; role/status/password admin-only. */
const PatchUserBody = z
  .object({
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    password: z.string().min(1).optional(),
  })
  // At least one mutable field must be present (an empty patch is a 400, not a silent no-op).
  .refine(
    (b) =>
      b.name !== undefined ||
      b.role !== undefined ||
      b.status !== undefined ||
      b.password !== undefined,
    { message: 'at least one of name/role/status/password is required' },
  );
/** Create a custom role (POST /api/roles) — gated `roles:manage`. */
const CreateRoleBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string()),
});
/** Patch a role (PATCH /api/roles/:name): description and/or the permission set. */
const PatchRoleBody = z
  .object({
    description: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  })
  .refine((b) => b.description !== undefined || b.permissions !== undefined, {
    message: 'at least one of description/permissions is required',
  });

/**
 * PATCH candidate edit. `patch` is an opaque object — the deeper allowlist +
 * sub-schema validation happens in the pure domain rule (applyCandidatePatch),
 * which the use-case calls, so the HTTP boundary only checks the envelope.
 */
const EditCandidateBody = z.object({
  patch: z.record(z.unknown()),
});
/** Promote a field proposal into the condition vocabulary. */
const PromoteBody = z.object({
  canonical_key: z.string().min(1),
  label: z.string().min(1),
  target: z.enum(['vocabulary', 'field']).default('vocabulary'),
});
/** Human deal fields + referenced evidence — shared by complete + ad-hoc create. */
const ManualCaptureBody = z.object({
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
