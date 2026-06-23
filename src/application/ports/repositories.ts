import type {
  Source,
  DealRecord,
  CrawlRun,
  ManualCaptureTask,
  FieldProposalRecord,
  Change,
  Evidence,
  DealStatus,
  ReviewRecord,
  SourceReviewRecord,
  SubscriptionCatalogEntry,
  CostSummary,
  PublishedQuery,
  PublishedFilters,
  CandidateQuery,
  CandidateDealCounts,
  AdminPublishedQuery,
  VocabularyEntry,
  ReviewAction,
  TeamMember,
  AlertRecord,
  AlertStatus,
  SettingOverride,
  User,
  Role,
  Permission,
  StoredRefresh,
} from '../../domain/index.js';

/**
 * Focused repository ports (ISP): each table has its own small interface so an
 * adapter only implements what it needs and callers depend on the narrow slice
 * they use. A `Database` aggregate bundles them for the composition root.
 */

export interface SourceRepository {
  upsert(source: Source): Promise<void>;
  getById(id: string): Promise<Source | null>;
  /** Load a source by its `url` (the natural key), or null. */
  getByUrl(url: string): Promise<Source | null>;
  /** Sources whose `next_due` is at/before `now` and status is active. */
  listDue(now: Date, limit: number): Promise<Source[]>;
  listByStatus(status: Source['status']): Promise<Source[]>;
  /** Persist an updated reliability score + next_due/last_seen after a crawl. */
  update(source: Source): Promise<void>;
}

export interface DealRepository {
  insert(deal: DealRecord): Promise<void>;
  getById(id: string): Promise<DealRecord | null>;
  listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]>;
  /**
   * Source-scoped, status-filtered lookup — newest first. Used by monitoring so
   * diff-baseline + expiry are deterministic regardless of total table size (no
   * fetch-1000-then-filter-in-JS scaling cliff).
   */
  listBySourceUrl(sourceUrl: string, statuses: DealStatus[], limit: number): Promise<DealRecord[]>;
  /** Find an existing non-rejected deal sharing this dedupe key (canonicalisation). */
  findByDedupeKey(dedupeKey: string): Promise<DealRecord | null>;
  /**
   * Find a non-rejected candidate/in_review deal for this dedupe key whose linked
   * evidence has the given content hash — used to avoid re-queuing an identical
   * candidate when a page's hash changes but the offer hasn't (flapping content).
   */
  findActiveByDedupeKeyAndHash(dedupeKey: string, contentHash: string): Promise<DealRecord | null>;
  updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void>;
  /** Expire every published deal for a source URL in one statement. Returns the count. */
  expirePublishedBySourceUrl(sourceUrl: string, expiredAt: string): Promise<number>;
  update(deal: DealRecord): Promise<void>;
  /**
   * The public read feed: `published` deals only, filtered + sorted + paginated.
   * Backs `GET /v1/deals`. `status = 'published'` is enforced INSIDE this method
   * (the trust boundary — a caller can never widen it), then the optional
   * {@link PublishedFilters} are AND-ed in. Sort is stable: the requested order
   * with `id` as the deterministic tiebreaker, so `offset`-based pagination never
   * skips or repeats a row. Both adapters MUST order identically (LSP).
   */
  listPublished(query: PublishedQuery): Promise<DealRecord[]>;
  /** Total `published` deals matching the same filters — for the feed's `total`. */
  countPublished(filters: PublishedFilters): Promise<number>;
  /**
   * The GATED admin review queue: candidates filtered + paginated. Unlike
   * {@link listPublished} this is NOT locked to one status — `filters.status`
   * narrows to a single status, and ABSENT status defaults to the reviewable pair
   * (`candidate` + `in_review`). Order is stable: `confidence` ascending (lowest
   * first — triage the shakiest extractions) with `id` as the deterministic
   * tiebreaker, so `offset` pagination never skips/repeats. Both adapters MUST
   * order identically (LSP).
   */
  listCandidates(query: CandidateQuery): Promise<DealRecord[]>;
  /**
   * The deal-derived slice of the review-queue counts (ACR-5): over the reviewable
   * statuses (`candidate` + `in_review`), tally the total, the low-confidence subset
   * (`confidence <= LOW_CONFIDENCE_MAX`), the human-edited subset (`human_edited`
   * non-empty), and a per-route breakdown — in ONE pass. `rejected_today` is NOT
   * here (it comes from the reviews audit log, date-bounded). Both adapters MUST
   * return identical numbers for the same data (LSP).
   */
  countCandidates(): Promise<CandidateDealCounts>;
  /**
   * The GATED admin "Published deals" screen (ACR-10): deals in the
   * {@link ADMIN_PUBLISHED_STATUSES} set (`published` + `expired` — publication
   * HISTORY, not just the live feed), ordered newest-published-first
   * (`published_at` desc NULLS LAST) then `id`, paginated. Both adapters MUST order
   * identically (LSP). Distinct from {@link listPublished} (public, published-only,
   * reliability-ranked).
   */
  listAdminPublished(query: AdminPublishedQuery): Promise<DealRecord[]>;
  /** Total deals in the admin-published status set — for the screen's `total`. */
  countAdminPublished(): Promise<number>;
  /**
   * The pending review queue's age + confidence signals (ACR-9 + ACR-10 Metrics): for
   * every reviewable deal (`candidate` + `in_review`), its linked evidence
   * `captured_at` (the freshness "age" basis — `now − captured_at`) and its
   * `confidence` (the confidence-distribution basis). A deal whose evidence row is
   * missing yields `capturedAt: null` (it can't be aged) but is still listed with its
   * confidence. One join over the queue; both adapters MUST return the same set (LSP).
   * Unbounded by design — the reviewable queue is the human-review backlog (small);
   * the same scale as {@link countCandidates}.
   */
  pendingQueueSignals(): Promise<{ capturedAt: string | null; confidence: number }[]>;
}

export interface CrawlRunRepository {
  insert(run: CrawlRun): Promise<void>;
  update(run: CrawlRun): Promise<void>;
  /**
   * Aggregate logged run cost over a half-open `started_at` window: `since`
   * inclusive (`started_at >= since`), `until` exclusive (`started_at < until`).
   * Both bounds are optional and independent — a run whose `started_at` equals
   * `until` is EXCLUDED, one equal to `since` is INCLUDED. Day buckets are UTC
   * (`YYYY-MM-DD`). `per_day` is ascending by day; `per_source` is descending by
   * `cost_eur` then ascending by `source_id`. An empty window returns zeros +
   * empty arrays (never throws). Sums are rounded to cents via the domain
   * `roundEur` helper, applied identically in both adapters.
   */
  costSummary(filter: { since?: Date; until?: Date }): Promise<CostSummary>;
  /**
   * Total logged run cost (EUR) since `since` inclusive (`started_at >= since`),
   * across ALL run kinds. Powers the aggregate daily-budget guard: the caller
   * passes UTC midnight to get spend-so-far-today. Rounded to cents via the same
   * exact micro-euro convention as `costSummary` (order-independent across
   * adapters). An empty window returns 0, never throws.
   */
  spentSince(since: Date): Promise<number>;
  /**
   * Recent runs (any kind) over a half-open `started_at` window — same bounds
   * semantics as `costSummary` (`since` inclusive, `until` exclusive; both
   * optional). Newest first (`started_at` desc, then `id` desc as a deterministic
   * tiebreaker), capped at `limit`. The per-run observability surface: kind,
   * status, candidates/proposals produced, cost, stop-reason.
   */
  recentRuns(filter: { since?: Date; until?: Date; limit: number }): Promise<CrawlRun[]>;
}

export interface EvidenceRepository {
  insert(evidence: Evidence): Promise<void>;
  getById(id: string): Promise<Evidence | null>;
}

export interface ManualCaptureRepository {
  insert(task: ManualCaptureTask): Promise<void>;
  listOpen(limit: number): Promise<ManualCaptureTask[]>;
  /** Load one task by id (any status), or null. For completing a capture. */
  getById(id: string): Promise<ManualCaptureTask | null>;
  /**
   * Mark a task `done` (a human captured the offer by hand), optionally annotating
   * it. Idempotent on the row's existence; the caller asserts the task was `open`
   * first so a capture isn't completed twice (one task → at most one candidate).
   */
  markDone(id: string, note: string | null): Promise<void>;
}

export interface FieldProposalRepository {
  /** Insert or bump the count for a proposal keyed by `suggested_key`. */
  upsertAndCount(proposal: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void>;
  listOpen(limit: number): Promise<FieldProposalRecord[]>;
  /** Load one proposal by its `suggested_key` (any status), or null. */
  getByKey(suggestedKey: string): Promise<FieldProposalRecord | null>;
  /**
   * Resolve a proposal by marking it `promoted` (a human promoted its key into the
   * `condition_vocabulary`). Idempotent; a no-op if the key doesn't exist. The
   * governed-promotion loop's terminal step — the proposal stops surfacing as open.
   */
  markPromoted(suggestedKey: string): Promise<void>;
}

/**
 * The controlled condition vocabulary (the keys long-tail conditions map to). A
 * `condition_vocabulary` table has existed since the first migration; this port
 * gives the promotion loop a typed seam to read/extend it (the
 * `promote-field-proposal` action). Extending the vocabulary is ADDITIVE and needs
 * no migration — that is the whole point of the governed loop (vs. a first-class
 * column, which does). Both adapters implement it identically (LSP).
 */
export interface ConditionVocabularyRepository {
  /** Load one entry by its canonical key, or null. */
  getByKey(key: string): Promise<VocabularyEntry | null>;
  /** Insert or replace a vocabulary entry (promotion writes here). */
  upsert(entry: VocabularyEntry): Promise<void>;
  /** All entries — the live vocabulary fed to the extractor's condition mapping. */
  list(): Promise<VocabularyEntry[]>;
}

export interface ChangeRepository {
  insert(change: Change): Promise<void>;
  /** Recent changes for a source, newest first — used to debounce auto-expiry. */
  recentForSource(sourceId: string, limit: number): Promise<Change[]>;
}

export interface ReviewRepository {
  /** Append a review decision (immutable audit log). */
  insert(review: ReviewRecord): Promise<void>;
  /** Decision history for one deal, newest first. */
  listForDeal(dealId: string, limit: number): Promise<ReviewRecord[]>;
  /**
   * Count review decisions of a given `action` whose `decided_at` is at/after
   * `since` (inclusive). Powers ACR-5's `rejected_today` (action `reject`, `since`
   * = UTC midnight) — a true date-bounded count the deal row can't express. Both
   * adapters MUST agree for the same data (LSP).
   */
  countByActionSince(action: ReviewAction, since: Date): Promise<number>;
  /**
   * Review decisions at/after `since` (inclusive), each joined to the decided deal's
   * evidence `captured_at` so the use-case can compute the capture→decision latency
   * (ACR-6 throughput's `avg_review_seconds`). Returns one entry per decision with its
   * `action` and the `latencySeconds` (`decided_at − captured_at`, floored to whole
   * seconds), or `latencySeconds: null` when the deal's evidence capture time can't be
   * resolved (the decision still counts, but doesn't enter the latency average). Both
   * adapters MUST return the same set + latencies for the same data (LSP).
   */
  listDecisionLatenciesSince(
    since: Date,
  ): Promise<{ action: ReviewAction; latencySeconds: number | null }[]>;
  /**
   * Recent review decisions across ALL deals (the audit feed, ACR-7), newest first.
   * Optional filters: `approver` (exact actor), `dealId` (exact entity), `since`
   * (decided_at >= since). Capped at `limit`. Ordering is `decided_at` desc then
   * `id` desc (deterministic tiebreaker) — both adapters identical (LSP).
   */
  listRecent(filter: {
    approver?: string;
    dealId?: string;
    since?: Date;
    limit: number;
  }): Promise<ReviewRecord[]>;
  /**
   * Total review decisions made by each approver — `approver` → count, in ONE query.
   * Powers the Team screen's derived `review_count` (ACR-10) without an N+1 per
   * member. Approvers with no decisions are simply absent from the map. Both
   * adapters MUST agree for the same data (LSP).
   */
  countByApprover(): Promise<Map<string, number>>;
}

/**
 * The team / reviewer registry (ACR-10 Team + ACR-11 Profile). The pipeline is the
 * system of record for reviewer identity. Both adapters implement it identically (LSP).
 */
export interface TeamRepository {
  /** Insert or update a member (keyed by `email`, the natural identity). */
  upsert(member: TeamMember): Promise<void>;
  getById(id: string): Promise<TeamMember | null>;
  getByEmail(email: string): Promise<TeamMember | null>;
  /** All members (the Team screen list). Ordered by name then id. */
  list(): Promise<TeamMember[]>;
}

/**
 * Persisted alert store (ACR-8). The fire-and-forget Alerting port still delivers;
 * this records each event so the panel can list / ack / resolve. Both adapters
 * implement it identically (LSP).
 */
export interface AlertRepository {
  /**
   * Record an alert occurrence, deduped to ONE open row per `dedupe_key`: a repeat
   * refreshes the existing open row's summary/context/updated_at rather than adding
   * a new row; a first sighting inserts `open`. A previously RESOLVED alert with the
   * same key re-opens (a new open row). Idempotent under retry.
   */
  upsertOpen(record: AlertRecord): Promise<void>;
  /** All alerts, newest-first (created_at desc, id desc), capped at `limit`. */
  list(limit: number): Promise<AlertRecord[]>;
  getById(id: string): Promise<AlertRecord | null>;
  /** Set an alert's stored status (manual ack/resolve), stamping `updated_at`. */
  setStatus(id: string, status: AlertStatus, at: string): Promise<void>;
}

/**
 * Persisted settings overrides (ACR-10 Settings). Stores ONLY the panel-editable knobs
 * as overrides layered over env-driven config; an absent row means "no override". Both
 * adapters implement it identically (LSP).
 */
export interface SettingsRepository {
  /** Load one override by key, or null when there is none. */
  get(key: string): Promise<SettingOverride | null>;
  /** All stored overrides (for the GET /api/settings merge). */
  list(): Promise<SettingOverride[]>;
  /** Insert or replace an override (keyed by `key`). PATCH writes here. */
  upsert(override: SettingOverride): Promise<void>;
  /** Remove an override (a cleared knob falls back to the live config value). */
  delete(key: string): Promise<void>;
}

export interface SourceReviewRepository {
  /** Append a source-promotion decision (immutable audit log). */
  insert(review: SourceReviewRecord): Promise<void>;
  /** Decision history for one source, newest first. */
  listForSource(sourceId: string, limit: number): Promise<SourceReviewRecord[]>;
}

export interface SubscriptionCatalogRepository {
  upsert(entry: SubscriptionCatalogEntry): Promise<void>;
  /** All catalog services (drives Tier-3 community keyword matching). */
  list(): Promise<SubscriptionCatalogEntry[]>;
}

/**
 * The user / login-account registry (Auth/IAM). Supersedes `TeamRepository` over the
 * consolidated `users` table (`team_members` renamed in migration 0019); `TeamUseCase`
 * stays a read model over the same rows. The password hash is kept OFF the `User`
 * entity — only `insert`/`getPasswordHashByEmail`/`updatePasswordHash` touch it, and
 * `getById`/`getByEmail`/`list` NEVER return it. Both adapters implement it identically
 * (LSP). `email` is the natural identity (`reviews.approver` keys on it).
 */
export interface UserRepository {
  /** Insert a new user with its (nullable) password hash — the hash never rides on `User`. */
  insert(user: User, passwordHash: string | null): Promise<void>;
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>; // === reviews.approver lookup
  /** The hash for password verification — kept OFF the User entity; adapter-only. */
  getPasswordHashByEmail(email: string): Promise<string | null>;
  list(): Promise<User[]>; // Users/Team screen
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  setStatus(id: string, status: User['status']): Promise<void>;
  /** Immediate-revoke lever: ++token_version; returns the new value. */
  bumpTokenVersion(id: string): Promise<number>;
  setRole(id: string, roleId: string): Promise<void>;
  /** On a successful login: clear failed_login_count + locked_until, set last_login_at. */
  recordLogin(id: string, at: string): Promise<void>;
  /**
   * On a failed login: ++failed_login_count, returning the NEW count. It does NOT set
   * `locked_until` itself — the caller (the Phase-2 `AuthenticateUseCase`) runs the pure
   * `lockoutPolicy` over the returned count + the last-failed time and calls
   * {@link setLockedUntil} when the threshold is crossed. The `at` arg is the failure
   * timestamp (recorded as `last_login_at`'s sibling by the policy caller, not here).
   */
  recordFailedLogin(id: string, at: string): Promise<number>;
  setLockedUntil(id: string, until: string | null): Promise<void>;
  /** Failed-login counters for the pure lockout policy (kept off the `User` entity). */
  getLoginState(
    id: string,
  ): Promise<{ failedLoginCount: number; lockedUntil: string | null } | null>;
}

/**
 * The role registry (Auth/IAM). Roles are named bundles of permissions; the actual
 * grants live in `RolePermissionRepository`. Both adapters identical (LSP).
 */
export interface RoleRepository {
  insert(role: Role): Promise<void>;
  getById(id: string): Promise<Role | null>;
  getByName(name: string): Promise<Role | null>;
  list(): Promise<Role[]>;
  /** Count users still assigned this role — guards delete (RoleInUseError). */
  countUsers(roleId: string): Promise<number>;
  delete(id: string): Promise<void>; // guarded by is_system + countUsers in the use-case
}

/**
 * The `(role_id, permission_key)` grants (Auth/IAM). The single source of "what can a
 * role do". `setForRole` is a REPLACE-set (clears then writes the given keys). Both
 * adapters identical (LSP). A mutation bumps the global `perm_version` in the use-case.
 */
export interface RolePermissionRepository {
  /** The permission keys granted to one role (deduped). */
  permissionsForRole(roleId: string): Promise<Permission[]>;
  /** Every grant row across all roles — for claim resolution + the panel role editor. */
  list(): Promise<{ roleId: string; permissionKey: Permission }[]>;
  /** Replace the entire grant set for a role (delete-then-insert), atomically. */
  setForRole(roleId: string, permissions: Permission[]): Promise<void>;
}

/**
 * Server-side refresh tokens (Auth/IAM). Stored only as SHA-256 hashes; rotation +
 * `family_id` lineage drive reuse-detection. Both adapters identical (LSP).
 */
export interface RefreshTokenRepository {
  issue(token: StoredRefresh): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefresh | null>;
  /**
   * Rotate: stamp the predecessor `oldId` (`revoked_at` + `replaced_by`) and insert the
   * successor (same `family_id`), atomically — no window where both are current.
   */
  rotate(oldId: string, replacement: StoredRefresh): Promise<void>;
  /** Revoke every row in a family (reuse-detection theft response). Returns the count. */
  revokeFamily(familyId: string, at: string): Promise<number>;
  /** Revoke every row for a user ("log out everywhere"). Returns the count. */
  revokeAllForUser(userId: string, at: string): Promise<number>;
  /** Cron cleanup: delete rows already past `expires_at` as of `now`. Returns the count. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * A tiny key/value store for global auth counters (Auth/IAM) — currently the single
 * `perm_version` counter bumped on any `role_permissions` edit. A DEDICATED table
 * (`auth_meta`, migration 0023), NOT the `settings` table: a `settings` row would
 * surface in the panel's `GET /api/settings` view / trip the settings catalog. Both
 * adapters identical (LSP).
 */
export interface AuthMetaRepository {
  /** The current global permission-version counter (0 when never bumped). */
  getPermVersion(): Promise<number>;
  /** Atomically increment + return the new global permission-version counter. */
  bumpPermVersion(): Promise<number>;
}

/** Aggregate handed to the composition root; groups the focused repositories. */
export interface Database {
  sources: SourceRepository;
  deals: DealRepository;
  crawlRuns: CrawlRunRepository;
  evidence: EvidenceRepository;
  manualCapture: ManualCaptureRepository;
  fieldProposals: FieldProposalRepository;
  conditionVocabulary: ConditionVocabularyRepository;
  changes: ChangeRepository;
  reviews: ReviewRepository;
  sourceReviews: SourceReviewRepository;
  catalog: SubscriptionCatalogRepository;
  team: TeamRepository;
  alerts: AlertRepository;
  settings: SettingsRepository;
  // Auth/IAM (Phase 1): the identity store + RBAC + refresh-token registry.
  users: UserRepository;
  roles: RoleRepository;
  rolePermissions: RolePermissionRepository;
  refreshTokens: RefreshTokenRepository;
  authMeta: AuthMetaRepository;
}
