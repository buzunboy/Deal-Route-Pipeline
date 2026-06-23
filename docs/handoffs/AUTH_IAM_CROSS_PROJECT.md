# Handoff — Cross-Project Auth/IAM (Pipeline becomes the IdP)

**For:** a FRESH Claude Code session (no memory of the planning conversation) implementing this cold.
**From:** the DealRoute pipeline session that planned it.
**Date:** 2026-06-23.
**Spans two repos:** the **Pipeline** (this repo — becomes the identity provider) and the **Admin Panel** (separate repo — the consumer).

> **TL;DR.** Replace the current auth (one shared static Bearer token on the pipeline + a static env JSON reviewer allow-list on the panel; `approver` is untrusted body text) with a **self-hosted IdP inside the pipeline**: a real `users`/`roles`/`permissions` store, **per-user ES256 JWTs** the pipeline verifies on every call, **permission-based RBAC** configurable from the panel, and **immediate revocation**. An admin creates a user in the panel; that one action provisions a login-capable account whose role is enforced on **both** the panel (page access) and the pipeline (API access). The static shared token and the env allow-list are retired.

## How to use this document

1. **Read the approved plan first — it is the source of truth:** `~/.claude/plans/replicated-sprouting-quail.md` (the `Context`, all locked owner decisions, the token/key design, the phased rollout). This handoff *expands* that plan into executable detail; if the two ever disagree, the plan's decisions win.
2. **Read the "Reviewer corrections" block directly below before touching code** — it lists the stale line-anchors and real gaps a completeness critic found in the section drafts. The full critique is appended at the very end (`Appendix — Reviewer critique`).
3. Then work the four implementation sections **in phase order** (Pipeline P1 → Pipeline P2&3 → Panel P4 → the cross-cutting Token/Security/Testing/Rollout section, which applies throughout).
4. The repo conventions are binding: `.claude/rules/{architecture,code-style,testing,api-and-openapi}.md`. Every feature needs unit + integration tests; every HTTP change updates `docs/api/openapi.yaml` + regenerates Postman in the **same commit**; log deferred findings in `docs/KNOWN_ISSUES.md`.

---

## ⚠️ Reviewer corrections — apply these (verified against the repos 2026-06-23)

The section drafts below were authored against the real files, but a completeness critic + a verification pass found these issues. **Apply them as you go.** (Full critique in the appendix.)

### Line anchors are indicative, not exact — grep, don't trust the number
Several hard line numbers in the drafts are stale (files are short and shift). **Locate by symbol, not line.** Verified anchors as of 2026-06-23:

| Symbol / thing | Real location (verified) | Draft sometimes says |
|---|---|---|
| `ReviewApi.authorized()` | `review-api.ts` **L605** ✓ | L605 (correct) |
| `safeEqual` (constant-time) | `review-api.ts` **L792** ✓ | L792 (correct) |
| `mapErrors` (the typed-error→status method, called ~15×) | `review-api.ts` — **method exists**, called at L271, 292, 319, 369… **grep `mapErrors` and read its `instanceof DomainError` switch before extending it** | "L618" — unverified; do not trust |
| `applyCors` | `review-api.ts` **L594**; sets `access-control-allow-methods` at **L597** = `'GET, POST, PATCH, OPTIONS'` (**no `DELETE`** — you must add `DELETE` here for `DELETE /api/roles/:id`); `allow-headers` at L598 already includes `Authorization` | "as applyCors already does it" |
| `serve.ts` dispatch | file is **~84 lines**: `reviewApi` ctor **L20**, `authToken` **L34**, `corsAllowOrigin` **L35**, `/v1/` dispatch **L47**, `reviewApi.handle` **L49**, no-token warning **L63–66** | various wider ranges |
| Panel `lib/auth/config.ts` | **87 lines**: `loginLimiter` L25, `Credentials.authorize` fn **L33–46**, Google provider `if (env.AUTH_GOOGLE_ID…)` **L50–58**, `signIn` **L71**, `jwt` callback **L77** (current signature is `jwt: ({ token }) =>` — **no `user` arg today**; your replacement adds it) | off by a few |
| Panel `lib/auth/edge-config.ts` | session callback **L30–34**; `authorized: ({ auth }) => Boolean(auth)` **L28**; the "no bcrypt/providers/allow-list import" comment **L6–7** | off by 1–2 |
| Panel `lib/api/route-helpers.ts` | `parseAllowlist` import **L7**, `allowlist` **L22**, pipeline token **L26**, allow-list re-checks **L72 and L95**, `isAllowed:` arg **L152** | off by a few |
| Panel `types/next-auth.d.ts` | augmentation **L4–20**, only `role` declared; **keep the `import "next-auth"` at L1** when you rewrite it | drops the import |

### Real gaps to close (not just cosmetic)
- **`mapErrors` is the most-reused helper in the new HTTP code.** Before extending it for the new auth errors, grep it in `review-api.ts`, read its `instanceof DomainError` switch, and add the new cases (`InvalidCredentialsError`→401, `AccountDisabledError`→403, `AccountLockedError`→429, `RefreshTokenInvalidError`/`RefreshReuseDetectedError`→401, `PermissionDeniedError`→403, `RoleInUseError`→409, `RoleNotFoundError`→404) following its existing shape.
- **`bearerAuth` is ALREADY defined** in `docs/api/openapi.yaml` (used at L259). So you do **not** need to define the scheme — just apply `security: [{ bearerAuth: [] }]` to the newly-gated operations (incl. all the now-authed GETs) and regenerate Postman.
- **The integration harness `resetDb()` TRUNCATEs `team_members`.** Migration `0019` **renames** `team_members`→`users`, so you must **change that TRUNCATE to `users` (rename, not append)** or post-0019 integration setup fails on a missing table. The harness lives under `test/integration/harness.ts` (referenced by every `*.integration.test.ts`).
- **Lockfile regen when removing `bcryptjs`.** The panel removal step must run `pnpm install` to update `pnpm-lock.yaml`, then `pnpm verify`. `bcryptjs@2.4.3` (package.json L33) + `@types/bcryptjs@2.4.6` (L56).
- **`nav-config.ts` Team group** (panel, ~L46) — read the current `{ label:'Team', items:[…] }` block in full before editing; the draft proposes a replacement without showing the current items.
- **Two different `DUMMY_HASH` constants.** The pipeline gets a NEW **Argon2id** dummy-hash constant (constant-time login for unknown emails). The panel's existing `DUMMY_HASH` (`allowlist.ts:60`) is **bcrypt** and is being **deleted**. Do not reuse the panel's value in the pipeline.
- **Last-admin lockout guard.** Make `ManageRolesUseCase.setUserStatus`/`assignRoleToUser` refuse to disable or demote the *last* user holding `roles:manage`/`team:manage` — with a unit test. Wire it in as a concrete to-do in Phase 3, not just an "open risk."

### Risks the drafts under-state — treat these as required implementation details
- **Refresh single-flight (most likely production breakage).** With ~5 reviewers and a SPA firing parallel `/api/*` calls, the naïve Auth.js `jwt`-callback rotation **will double-refresh and trip family-reuse-revocation, logging everyone out.** Mitigate in §4.2: a module-level in-flight promise keyed by the refresh token (single-flight), **or** a short refresh-reuse grace window server-side. This is mandatory, not optional.
- **Dual-accept legacy-token audit pollution.** During the cutover window, do **not** synthesize a full-permission "legacy" identity that writes `reviews.approver = 'legacy-token@system'` on real decisions — it pollutes the email-keyed audit trail the whole consolidation exists to protect. Time-box the dual-accept window hard, restrict the legacy path to non-audited reads if possible, and exclude any synthetic actor from `review_count` derivation.
- **`perm_version` storage collision.** Store the global `perm_version` counter in a dedicated **`auth_meta`** table, **not** the `settings` table — an un-cataloged `settings` row can surface in the panel's `GET /api/settings` view / trip `SettingsUseCase.buildSettingsView`'s catalog logic.
- **ES256 key format must be pinned.** `AUTH_JWT_PRIVATE_KEY` as "JWK or PEM" needs different `jose` imports (`importJWK` vs `importPKCS8`). Pin **one** format in config and branch explicitly at startup; a format mismatch must **fail loudly at boot**, never silently disable auth.

---

## Pipeline — Phase 1: Identity foundation (domain + DB)

> **Scope of this phase.** Lay the pure domain, the database tables, the repository/auth ports, the two new vendor adapters (Argon2id hasher, jose token issuer), and the composition-root wiring. **No HTTP route changes** here — `src/adapters/http/review-api.ts` and `src/adapters/cli/commands/serve.ts` are untouched until Phase 2. The static-token `ReviewApi.authorized()` (`review-api.ts:605`) keeps working unchanged through this phase. The exit bar is: `npm run check` + `npm run test:integration` green, with the new pure-rule unit tests, the two port-contract suites, and the round-trip integration coverage that `testing.md` mandates for a new table/column.

This phase mirrors the existing house patterns exactly: pure zod entities in `src/domain/` (like `src/domain/team/team-member.ts`), typed `DomainError` subclasses in `src/domain/errors/errors.ts`, focused repository ports on the `Database` aggregate in `src/application/ports/repositories.ts`, drizzle tables in `src/adapters/db/postgres/schema.ts` with a generated migration, an LSP-paired in-memory + Postgres adapter, a shared port-contract suite under `test/contracts/`, and one wiring site in `src/composition/container.ts`.

---

### 1. New domain folder `src/domain/auth/`

All four files are **pure** — zod + plain TS, no vendor SDK, no I/O (matches `team-member.ts`). Each gets a barrel re-export so they flow out through `src/domain/index.js` the way `TeamMemberSchema`/`TeamRole` already do. **The password hash never appears on any domain entity** — it lives only in the DB row and the `PasswordHasher`/`UserRepository` adapter boundary.

#### `permission.ts` — the closed permission set (a zod enum)

A `z.enum` so a typo in a guard is a **compile error**, not a silent un-gated route. The string set is **derived directly from the write sites in `review-api.ts`** (every place that today calls `this.authorized(req)`), plus the read-gating note. This is the canonical mapping the cold session must reproduce — it is the same table the Phase-2 route→permission registry keys off:

```ts
import { z } from 'zod';

/**
 * Fine-grained permission keys. Roles are named BUNDLES of these (DB data); pages
 * and APIs require a permission, never a role name — so adding a role is data, not
 * code. The enum is the closed universe of keys: a typo is a compile error, and
 * the keys are seeded into the `permissions` table (migration 0021) so the panel UI
 * can enumerate them without the enum shipping to the client.
 */
export const Permission = z.enum([
  'candidate:read',   // GET /api/candidates*, /reviews, /counts, /freshness
  'candidate:approve',// POST /api/candidates/:id/approve
  'candidate:reject', // POST /api/candidates/:id/reject
  'candidate:edit',   // PATCH /api/candidates/:id
  'sources:read',     // GET /api/sources*, /pending, /reviews
  'sources:write',    // POST /api/sources
  'sources:review',   // POST /api/sources/:id/approve|reject
  'settings:read',    // GET /api/settings
  'settings:write',   // PATCH /api/settings/:key
  'team:read',        // GET /api/team
  'team:manage',      // POST /api/team→/api/users, PATCH /api/users/:id
  'roles:manage',     // GET/POST/PATCH/DELETE /api/roles, GET /api/permissions
  'alerts:manage',    // POST /api/alerts/:id/acknowledge|resolve
  'field-proposals:promote', // POST /api/field-proposals/:key/promote
  'manual-capture:write',    // POST /api/manual-capture-tasks(/:id/complete)
  'evidence:read',    // GET /api/evidence/:id/:artifact (the one gated GET today)
]);
export type Permission = z.infer<typeof Permission>;

/** All permission keys, e.g. to seed the `permissions` table and grant `admin`→all. */
export const ALL_PERMISSIONS = Permission.options;
```

Notes the cold session must honour:
- `PATCH /api/profile` is **self-only** (any authed user editing their own row) — it is deliberately *not* a permission; it is enforced by `claims.email === target.email`, not a key.
- Every **`GET /api/*` read** requires a *valid token* but **no named permission** (the plan's "all reads require auth" decision). The read-permission keys above (`candidate:read`, `sources:read`, `settings:read`, `team:read`) exist so a future role can be *denied* a read; the Phase-2 registry maps the bare GETs to "auth required" by default, and only `GET /api/evidence/:id/:artifact` keeps its named `evidence:read` (it is the one sensitive GET today).

#### `role.ts` — the role entity

```ts
import { z } from 'zod';

export const RoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),          // 'admin' | 'reviewer' | custom
  description: z.string().default(''),
  is_system: z.boolean(),           // protects built-in admin/reviewer from delete/rename
});
export type Role = z.infer<typeof RoleSchema>;
```

`is_system` is the guard `ManageRolesUseCase.deleteRole` (Phase 3) checks before throwing `RoleInUseError`/refusing deletion — declared here so the invariant lives with the entity.

#### `user.ts` — supersedes `team-member.ts`

This is the consolidation seam. **Read `src/domain/team/team-member.ts` before writing this** — `User` is a strict superset of `TeamMember`, preserving every field by the **same name and type** so existing read paths keep working and, critically, **`reviews.approver` stays keyed on `email`**:

| `team-member.ts` (preserved) | `user.ts` |
|---|---|
| `id: z.string().uuid()` | unchanged |
| `name: z.string().min(1)` | unchanged |
| `email: z.string().email()` — *the auth identity the reviews log keys on as `approver`* | **unchanged — this is the non-negotiable invariant.** Every review decision is keyed on `email`; `approver` (token-derived from Phase 2 on) equals `claims.email` equals this. Do not re-key reviews on `user_id`. |
| `created_at: z.string().min(1)` (ISO-8601) | unchanged |
| `role: TeamRole` (enum `'admin'\|'reviewer'`) | **replaced by `role_id: z.string().uuid()`** — role is now a FK to the `roles` table (permission-based RBAC), not an inline enum. The `TeamUseCase` read model maps `role_id`→role name for the Team screen. |
| `status: TeamMemberStatus` (`'active'\|'invited'`) | **widened to `z.enum(['active','invited','disabled'])`** — `disabled` is new (a disabled user 401s; see `token_version`). |

New fields (all adapter-backed; none ever LLM-proposed):

```ts
export const UserStatus = z.enum(['active', 'invited', 'disabled']);
export const AuthProvider = z.enum(['password', 'google']);

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),          // === reviews.approver — UNCHANGED identity
  role_id: z.string().uuid(),
  status: UserStatus,
  auth_provider: AuthProvider.default('password'),
  google_sub: z.string().nullable().default(null), // OIDC subject; null until SSO (P6)
  token_version: z.number().int().nonnegative().default(0), // immediate-revoke lever
  created_at: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;
```

**Password hash is NOT on this schema.** It is a `password_hash text` *column* read/written only by `UserRepository` + `PasswordHasher`; the domain `User` never carries it (so it can't leak through a DTO or a log line). Mirror `TeamMemberView`/`toTeamMemberView` for the panel projection (it stays derived `review_count` from the reviews log via `ReviewRepository.countByApprover()`), now over `User`.

> **`TeamMember` does not get deleted in this phase.** The plan keeps `TeamUseCase` as the read model over the consolidated table. Keep the `TeamMember*` exports as a thin alias/projection of `User` (or have the `TeamUseCase` map `User`→`TeamMemberView`) so the existing `/api/team` handler and its tests stay green until the panel cutover. Dropping the legacy name is explicitly deferred to "after P5" (plan, "Open items deliberately deferred").

#### `auth-errors.ts` — extend `src/domain/errors/`

New `DomainError` subclasses following the exact pattern in `errors.ts` (abstract `code`, constructor context, `instanceof`-distinguishable). Add them to the `errors/index.ts` barrel. Each documents its **HTTP status** the way the existing ones do (the Phase-2 `mapErrors` switch in `review-api.ts:618` will translate them):

| Error class | `code` | HTTP | Notes |
|---|---|---|---|
| `InvalidCredentialsError` | `INVALID_CREDENTIALS` | **401** | **Generic** message for *both* unknown-email and wrong-password (anti-enumeration; the always-run-hasher in Phase 2/3's `AuthenticateUseCase` backs this up). |
| `AccountDisabledError` | `ACCOUNT_DISABLED` | **403** | `status === 'disabled'`. |
| `AccountLockedError` | `ACCOUNT_LOCKED` | **429** | Carries `locked_until` in context. |
| `RefreshTokenInvalidError` | `REFRESH_INVALID` | **401** | Not found / expired / revoked. |
| `RefreshReuseDetectedError` | `REFRESH_REUSE` | **401** | A rotated-out family member was presented ⇒ revoke whole family. Subclass-of or sibling-to `RefreshTokenInvalidError` (so a generic 401 catch still works). |
| `PermissionDeniedError` | `PERMISSION_DENIED` | **403** | Carries the missing `Permission` in context (used by the Phase-2 registry). |
| `RoleNotFoundError` | `ROLE_NOT_FOUND` | **404** | `ProvisionUserUseCase` validates the role exists. |
| `RoleInUseError` | `ROLE_IN_USE` | **409** | Deleting a role still assigned to users / a `is_system` role. |

These are constructed by the **use-cases** (Phase 3) and the **JWT guard** (Phase 2); defining them now keeps the domain complete and lets the pure rules below reference `PermissionDeniedError`.

#### Pure rules to unit-test

All pure, clock-injected where time matters (use the existing `Clock` port's `now(): Date` — `src/application/ports/clock.ts`; tests pass a `FixedClock`). Co-locate as `src/domain/auth/rules.ts` (or one file per rule, the repo does both). **These are the Phase-1 trust-critical unit surface** — table-driven tests per `testing.md`'s "pure logic = unit tested":

| Function | Signature | Must guarantee |
|---|---|---|
| `permissionsForRole` | `(roleName: string, grants: ReadonlyArray<{ role_id: string; permission_key: Permission }>, roleId: string) => Set<Permission>` (or simply `(roleId, grants) => Set<Permission>`) | Resolves the effective permission **set** for a role from `role_permissions` rows. `admin`→`ALL_PERMISSIONS`; an unknown role→empty set (deny by default). Idempotent, order-independent, dedup'd. This is what `buildAccessClaims` inlines and what `AuthorizationUseCase.permissionsForUser` (Phase 3) calls. |
| `hasPermission` | `(perms: ReadonlySet<Permission>, required: Permission) => boolean` | Pure membership check. The single chokepoint the Phase-2 route registry calls — **never** matches on role name. Exhaustiveness test: assert every `Permission.options` key is decidable. |
| `lockoutPolicy` | `(failedCount: number, lastFailedAt: Date \| null, now: Date) => { locked: boolean; lockedUntil: Date \| null }` | Pure brute-force gate (no I/O). Defined boundaries (config-driven thresholds, named constants — no magic numbers): below threshold ⇒ not locked; at/above ⇒ locked until `lastFailedAt + lockoutWindow`; **a window that has elapsed ⇒ not locked** (auto-unlock). Test the exact off-by-one at the window edge with a `FixedClock`. Feeds `AccountLockedError` + the `failed_login_count`/`locked_until` user columns. |
| `buildAccessClaims` | `(user: User, perms: ReadonlySet<Permission>, roleName: string, permVersion: number, now: Date, ttlSeconds: number, jti: string) => AccessClaims` | Builds the **exact** claim object the plan pins: `{ iss, aud, sub: user.id, email, name, role: roleName, perms: [...sorted], token_version: user.token_version, perm_version: permVersion, iat, exp: iat+ttl, jti }`. Pure (no signing — that's `TokenIssuer`). Guarantees: `exp = iat + ttl`; `perms` deterministically ordered (so tests are stable); **never** includes `password_hash` or any secret. `iss`/`aud` injected from config, not hard-coded. |
| `validateRefreshRotation` | `(stored: StoredRefresh, presented: { tokenHash: string }, now: Date) => 'ok' \| 'expired' \| 'reuse'` | The pure heart of refresh rotation/reuse-detection. `ok` when the stored row matches, is unexpired, and is **not yet rotated** (`revoked_at === null`, `replaced_by === null`); `expired` when `now >= expires_at`; **`reuse`** when a row that is already revoked/replaced is presented again (⇒ the use-case revokes the whole `family_id`). Pure — the actual hashing/compare uses `timingSafeEqual` in the adapter, but the *decision* is testable in isolation (fresh / rotated / expired / reuse cases, per the plan's testing list). |

---

### 2. Drizzle migrations `0019…0023`

**Latest existing migration is `0018_bright_blackheart.sql`** (the `settings` table). Edit `src/adapters/db/postgres/schema.ts` to add the new `pgTable`s and the `users` rename, then **generate** the SQL — do **not** hand-write migration files:

```sh
npm run db:generate     # drizzle-kit generate → writes drizzle/0019_*.sql … and updates drizzle/meta/
```

Drizzle emits one file per `generate` run; to land five logically-distinct migrations (`0019`…`0023`) generate incrementally (add the `users` rename to the schema, generate `0019`; add `roles`, generate `0020`; …) OR generate one file and split — **prefer incremental generate** so `drizzle/meta/_journal.json` and the snapshot stay consistent (the repo's `0014`/`0016`/`0017`/`0018` were each single-table generates). Match the existing `pgTable` house style exactly: `uuid('…').primaryKey()`, `text('…').notNull()`, `timestamp('…', { withTimezone: true, mode: 'string' })`, `boolean(...).notNull().default(...)`, `index(...)`, `uniqueIndex(...)`, and `sql\`…\`` for partial-index predicates (see `alertEvents.openDedupeUnique`).

**Every new table/column also needs the round-trip integration coverage `testing.md` mandates** ("A new DB table/column → a drizzle migration AND integration coverage of the round-trip"), driven through the real `Container` + Postgres in `test/integration/`.

#### `0019` — consolidate `team_members` → `users`

This is the only **destructive-rename** migration; it preserves ids + emails so `reviews.approver` (keyed on email) is untouched and existing rows survive. In `schema.ts`, **rename the `teamMembers` export to `users`** (`pgTable('users', …)`), keep `id`/`name`/`email`/`createdAt` identical, change `role text` → `role_id uuid`, widen `status` to allow `disabled`, and add the new columns. The generated SQL is an `ALTER TABLE RENAME` + `ADD COLUMN`s + a backfill, e.g.:

```sql
ALTER TABLE "team_members" RENAME TO "users";
-- email stays UNIQUE (the rename carries the index; reviews.approver = email is intact)
ALTER TABLE "users" ADD COLUMN "password_hash" text;                 -- nullable (admin sets later / SSO)
ALTER TABLE "users" ADD COLUMN "token_version" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "auth_provider" text NOT NULL DEFAULT 'password';
ALTER TABLE "users" ADD COLUMN "google_sub" text;                    -- nullable; OIDC, P6
ALTER TABLE "users" ADD COLUMN "role_id" uuid;                       -- FK added in 0020 after roles exist
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamptz;
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "locked_until" timestamptz;
-- preserve the old enum 'role' values so the 0020/0022 seed can map them to role_id;
-- keep the legacy text "role" column for one migration, then drop it after backfill.
```

Index note: the old `team_members_email_unique` rides the rename — keep email unique (it is the auth/`approver` identity). The legacy `role text` column should remain until `0020`/`0022` backfill `role_id` from it, then be dropped (drizzle will emit the `DROP COLUMN` once you remove it from `schema.ts`).

#### `0020` — `roles`

```ts
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isSystem: boolean('is_system').notNull().default(false),
}, (t) => ({ nameUnique: uniqueIndex('roles_name_unique').on(t.name) }));
```
Seed (in the generated migration's body or a follow-on seed step) the two **system** roles `admin` and `reviewer` (`is_system = true`), then backfill `users.role_id` from the legacy `users.role` text (`'admin'`→admin.id, else reviewer.id) and add the FK `users.role_id → roles.id`.

#### `0021` — `permissions`

A table of permission keys so the panel "Roles & permissions" UI can enumerate them **without** the `Permission` enum shipping to the client:
```ts
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),     // matches Permission.options exactly
  label: text('label').notNull(),    // human label for the panel UI
});
```
Seed one row per `ALL_PERMISSIONS` key. A test asserts the table seed and the `Permission` enum are in sync (drift guard).

#### `0022` — `role_permissions`

```ts
export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull(),       // FK → roles.id
  permissionKey: text('permission_key').notNull(), // FK → permissions.key
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionKey] }) }));
```
Composite PK `(role_id, permission_key)` + FKs. Seed: `admin` → **all** keys; `reviewer` → the read keys + `candidate:approve|reject|edit` + `manual-capture:write` + `evidence:read` (the plan's "read + approve/reject/edit + manual-capture subset"). **Any mutation here bumps the global `perm_version`** (Phase 3's `ManageRolesUseCase`).

#### `0023` — `refresh_tokens` + global `perm_version`

```ts
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),                       // FK → users.id
  tokenHash: text('token_hash').notNull(),                 // SHA-256 hex of the opaque token (never the token itself)
  familyId: uuid('family_id').notNull(),                   // lineage for reuse-detection
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  replacedBy: uuid('replaced_by'),                         // the rotation successor's id (null until rotated)
  userAgent: text('user_agent'),
  ip: text('ip'),
}, (t) => ({
  userIdx: index('refresh_tokens_user_idx').on(t.userId),
  hashUnique: uniqueIndex('refresh_tokens_token_hash_unique').on(t.tokenHash), // lookup-by-hash + dedupe
  familyIdx: index('refresh_tokens_family_idx').on(t.familyId),
}));
```

The **global `perm_version`** is a single counter. Per the plan, store it as a **row in the existing `settings` table** (key `'perm_version'`, `value` text-encoded int — matches the `settings` schema's `value text` shape) rather than a new table, so there is no extra migration surface; `RefreshTokenRepository`/`AuthorizationUseCase` read it via the existing `SettingsRepository`. (If a typed home is preferred, a tiny `auth_meta(key text pk, value text)` table is the documented alternative — the plan permits either; default to `settings`.)

#### The in-memory adapter must mirror

`InMemoryDb` (`src/adapters/db/in-memory/in-memory-db.ts`) is a **first-class shippable** adapter and the reference the Postgres adapter's contract suite runs against. For each new repo, add an `InMemory*Repo` field on `InMemoryDb` exactly as `team`/`alerts`/`settings` are (lines 84–86), with the same Map-backed, deep-cloned-on-read semantics. There is **no migration for in-memory** — the mirror is the in-memory class implementing the same port. LSP is enforced by the shared contract suite (§3).

---

### 3. New ports + adapters

#### Repository ports (on the `Database` aggregate, `src/application/ports/repositories.ts`)

Follow the file's ISP convention (one focused interface per table; all imported types come from `../../domain/index.js`; every method documents LSP where both adapters must agree). Add four interfaces and four fields to the `Database` aggregate (alongside `team`, `alerts`, `settings`):

```ts
export interface UserRepository {
  insert(user: User & { passwordHash: string | null }): Promise<void>;
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;                 // === reviews.approver lookup
  /** The hash for password verification — kept OFF the User entity; adapter-only. */
  getPasswordHashByEmail(email: string): Promise<string | null>;
  list(): Promise<User[]>;                                         // Team/Users screen
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  setStatus(id: string, status: User['status']): Promise<void>;
  bumpTokenVersion(id: string): Promise<number>;                  // immediate-revoke; returns new value
  setRole(id: string, roleId: string): Promise<void>;
  recordLogin(id: string, at: string): Promise<void>;            // last_login_at + reset failed_login_count
  recordFailedLogin(id: string, at: string): Promise<number>;    // ++failed_login_count; returns new count
  setLockedUntil(id: string, until: string | null): Promise<void>;
}

export interface RoleRepository {
  insert(role: Role): Promise<void>;
  getById(id: string): Promise<Role | null>;
  getByName(name: string): Promise<Role | null>;
  list(): Promise<Role[]>;
  /** Count users still assigned this role — guards delete (RoleInUseError). */
  countUsers(roleId: string): Promise<number>;
  delete(id: string): Promise<void>;          // guarded by is_system + countUsers in the use-case
}

export interface RolePermissionRepository {
  permissionsForRole(roleId: string): Promise<Permission[]>;
  list(): Promise<{ roleId: string; permissionKey: Permission }[]>;
  setForRole(roleId: string, permissions: Permission[]): Promise<void>; // replace-set; bumps perm_version in the use-case
}

export interface RefreshTokenRepository {
  issue(token: StoredRefresh): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefresh | null>;
  /** Rotate: revoke `oldId` (set revoked_at + replaced_by) and issue the successor — same family_id. */
  rotate(oldId: string, replacement: StoredRefresh): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;          // reuse-detection nuke
  revokeAllForUser(userId: string): Promise<void>;        // "log out everywhere"
  deleteExpired(now: Date): Promise<number>;              // cron cleanup (cron lane deferred, plan)
}
```

`StoredRefresh` is the row shape (mirrors the `refresh_tokens` columns). `Permission` is imported from `../../domain/index.js`. Add to the aggregate:

```ts
export interface Database {
  // …existing…
  users: UserRepository;
  roles: RoleRepository;
  rolePermissions: RolePermissionRepository;
  refreshTokens: RefreshTokenRepository;
}
```

> The global `perm_version` is read/written through the existing `SettingsRepository` (key `'perm_version'`) — no new port needed.

Implement each in **both** `InMemoryDb` and `PostgresDb` (PgRepo subclasses through `run(op, fn, idempotent?)`, matching `PgTeamRepo`/`PgAlertRepo`/`PgSettingsRepo` at `postgres-db.ts:151–153`). **All four must pass a shared port-contract suite** added under `test/contracts/` (the file already houses `database-contract.ts` — extend it, or add `auth-repositories-contract.ts` run for both the in-memory and Postgres `Database`), proving in-memory ≡ Postgres for: insert/get-by-email round-trip, hash never returned from `getByEmail`, `bumpTokenVersion` monotonic, refresh `rotate` sets `revoked_at`+`replaced_by` and keeps `family_id`, `revokeFamily` kills all rows, `deleteExpired` is bounded by `now`. The Postgres side runs in the integration tier (`vitest.integration.config.ts`).

#### `PasswordHasher` port + `Argon2idHasher` adapter

New port file (e.g. `src/application/ports/password-hasher.ts`, exported via `src/application/ports/index.js`):

```ts
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;          // returns the encoded Argon2id string (salt+params inline)
  verify(hash: string, plaintext: string): Promise<boolean>; // constant-time; false on mismatch/garbage
  needsRehash(hash: string): boolean;                // true when stored params lag current config
}
```

Adapter **`Argon2idHasher`** in `src/adapters/security/argon2id-hasher.ts` (new `src/adapters/security/` folder, or `src/adapters/auth/`) wrapping **`@node-rs/argon2`** (prebuilt binaries — no node-gyp on Fly.io; bcrypt via a `bcryptjs` adapter is the documented fallback, not shipped). Memory/iterations/parallelism come from config (named constants, no magic numbers). It must pass a **`PasswordHasher` port-contract suite** (`test/contracts/password-hasher-contract.ts`): round-trip `verify(hash(p), p) === true`, tampered hash → `false`, wrong password → `false`, `needsRehash` flips when params change. A trivial in-memory/fake hasher (e.g. identity-with-marker, used by unit tests of the use-cases) passes the same suite for substitutability.

#### `TokenIssuer` port + `JoseTokenIssuer` adapter

New port (`src/application/ports/token-issuer.ts`):

```ts
export interface TokenIssuer {
  signAccess(claims: AccessClaims): Promise<string>;                 // ES256 JWS compact
  verifyAccess(token: string): Promise<AccessClaims>;                // throws on bad alg/iss/aud/exp/sig
  jwks(): Promise<{ keys: JsonWebKey[] }>;                            // public keys for /.well-known/jwks.json
  currentKid(): string;
}
```

`AccessClaims` is the exact shape `buildAccessClaims` produces. Adapter **`JoseTokenIssuer`** in `src/adapters/security/jose-token-issuer.ts` wrapping **`jose`**: signs with `alg: 'ES256'` + `kid`; **verify pins `algorithms: ['ES256']`** and checks `issuer`/`audience` (alg-confusion-safe — never accepts `none`/HS256). Keys load from config (`AUTH_JWT_PRIVATE_KEY` JWK/PEM + `AUTH_JWT_KID`, optional `…_NEXT` for rotation overlap). It must pass a **`TokenIssuer` port-contract suite** (`test/contracts/token-issuer-contract.ts`): sign↔verify round-trip; **reject** `alg=none`, an HS256-swapped token, an expired token (inject `Clock`/exp), wrong `iss`, wrong `aud`, a tampered signature; assert the JWKS shape (public-only, correct `kid`/`crv`). These are the **adversarial boundary tests** `testing.md` requires for a new parser boundary — match `review-api.test.ts` depth.

> Both new vendor deps (`@node-rs/argon2`, `jose`) are added to `package.json` in this phase since the adapters import them. No business-logic file imports either SDK — only these two adapters do (DIP).

#### Wiring into the single composition root

`src/composition/container.ts` is the **one** place these are constructed (no `new` elsewhere — the file's own doc states this). Mirror the existing construction style (the `buildDatabase`/`buildEvidenceStore`/`buildAlerter` helpers, `overrides.clock ?? new SystemClock()`, the `closables` list):

- The new repos arrive **for free** on `this.db` — `buildDatabase(config, usePersistence)` (`container.ts:405`) already returns the `Database` aggregate; once `InMemoryDb`/`PostgresDb` expose `users`/`roles`/`rolePermissions`/`refreshTokens`, no container change is needed for them beyond the existing call.
- Add two new fields + builders for the auth adapters, e.g.:
  ```ts
  readonly passwordHasher: PasswordHasher;
  readonly tokenIssuer: TokenIssuer;
  // …in the constructor, after this.db is built:
  this.passwordHasher = new Argon2idHasher(config.auth.argon2);
  this.tokenIssuer = new JoseTokenIssuer(config.auth.jwt, this.clock);
  ```
  Add matching `overrides?.passwordHasher` / `overrides?.tokenIssuer` to `ContainerOptions.overrides` (same pattern as `clock`/`llm`/`alerting`) so integration tests can inject a deterministic hasher/issuer while exercising the real wiring.
- **Reuse the existing `Clock`** (`this.clock`) for every TTL/lockout/`now` — do **not** introduce a second clock.
- **No use-cases or HTTP wiring in this phase.** `AuthenticateUseCase`/`RefreshUseCase`/`AuthApi`/the JWT guard are Phase 2–3. The new config block (`config.auth.*`: JWT keys/iss/aud/TTLs, Argon2 params, lockout knobs) is added to `src/config/config.ts` now because the adapters need it; `serve.ts`'s startup warning and the `REVIEW_API_TOKEN` retirement land in Phase 5.

---

### Phase-1 exit checklist

- `src/domain/auth/` (`permission.ts`, `role.ts`, `user.ts`, `rules.ts`) + `auth-errors.ts` merged into `src/domain/errors/`, all re-exported through `src/domain/index.js`; `TeamMember*` preserved as an alias/projection so `/api/team` stays green.
- Migrations `0019`–`0023` generated via `npm run db:generate` (journal + snapshot consistent); `team_members` renamed to `users` with email + ids preserved (reviews.approver intact); `roles`/`permissions`/`role_permissions`/`refresh_tokens` created + seeded; `perm_version` row in `settings`.
- `InMemoryDb` mirrors every new repo; `PostgresDb` implements each via `PgRepo`.
- `PasswordHasher`/`TokenIssuer` ports + `Argon2idHasher`/`JoseTokenIssuer` adapters; `@node-rs/argon2` + `jose` added to `package.json`; constructed only in `container.ts` with test overrides.
- **Tests:** unit (`permissionsForRole`, `hasPermission`, `lockoutPolicy`, `buildAccessClaims`, `validateRefreshRotation`, permission-enum↔`permissions`-table exhaustiveness); port-contract suites for `PasswordHasher`, `TokenIssuer`, and the four repos (in-memory ≡ Postgres, LSP); integration round-trip for the new tables through the real `Container` + Postgres. `npm run check` + `npm run test:integration` green.
- **No HTTP/OpenAPI change** this phase — `docs/api/openapi.yaml` + the Postman regen are Phase 2 (when `/auth/*` and the `bearerAuth` markings land). Log the dual-accept-window note in `docs/KNOWN_ISSUES.md` when Phase 2 opens it, not here.

---

## Pipeline — Phases 2 & 3: Auth endpoints + per-request enforcement + Users/Roles API

This section is the executable detail for plan phases **P2 (auth endpoints + dual-accept JWT guard)** and **P3 (Users & Roles admin API)** on the **Pipeline** repo (the IdP). It assumes **P1 has landed**: `src/domain/auth/` (the `Permission` enum, `Role`/`User` entities, `auth-errors.ts`, the pure rules `permissionsForRole`/`hasPermission`/`lockoutPolicy`/`buildAccessClaims`/`validateRefreshRotation`), migrations `0019–0023` (the `team_members → users` consolidation + `roles`/`permissions`/`role_permissions`/`refresh_tokens` + the global `perm_version`), the `PasswordHasher` (`Argon2idHasher`) and `TokenIssuer` (`JoseTokenIssuer`) ports+adapters, and the new `UserRepository`/`RoleRepository`/`RolePermissionRepository`/`RefreshTokenRepository` on the `Database` aggregate — all wired in `src/composition/container.ts`. Everything below builds *on top of* those.

All code lives in the worktree root `/Users/burakuzunboy/Claude/Projects/Discover Delas/LLM-Pipeline/.claude/worktrees/elegant-lamarr-c3f85f`. Paths are repo-relative.

> **House-style invariants to honour throughout** (from `.claude/rules/`): every external input is parsed through a zod schema at the boundary before use; typed `DomainError` subclasses map to HTTP status via a `mapErrors`-style switch (never a leaked 500); dependencies are constructor-injected from the **one** composition root (`container.ts`) — no `new VendorClient()` in a use-case; the injected `Clock` (never `Date.now()`/`new Date()`) drives every TTL/lockout/`iat`/`exp`; constant-time compares (`timingSafeEqual`) for any secret; a use-case change ⇒ unit **and** integration tests; an HTTP-surface change ⇒ `docs/api/openapi.yaml` updated in the **same** commit + `npm run api:postman` + `npm run api:check`.

---

### 2.1 New use-cases — `src/application/auth/`

Each is a class with constructor-injected ports, mirroring `TeamUseCase` (`src/application/team/team.ts`): private readonly `db`, `clock`, `logger`, plus the new `hasher`/`tokenIssuer` ports where needed. Export them from `src/application/index.ts` (the barrel the container imports from). Construct them in `container.ts` and expose as `readonly` Container fields (see §2.5). All identity-mutating methods take no body-supplied `approver` — the HTTP layer derives the actor from the verified token and passes it in.

Shared injected ports (P1 deliverables) used below:
- `PasswordHasher` — `hash(plain): Promise<string>`, `verify(hash, plain): Promise<boolean>`, `needsRehash(hash): boolean`. Adapter `Argon2idHasher` (`@node-rs/argon2`).
- `TokenIssuer` — `signAccess(claims): Promise<string>`, `verifyAccess(jwt): Promise<AccessClaims>` (pins `algorithms:['ES256']`, validates `iss`/`aud`; throws on failure), `jwks(): JsonWebKeySet`, `currentKid(): string`. Adapter `JoseTokenIssuer`.
- New repos: `UserRepository`, `RoleRepository`, `RolePermissionRepository`, `RefreshTokenRepository`, plus an `AuthMetaRepository` (or a `perm_version` row in the existing `settings`/`auth_meta`) exposing `getPermVersion()`/`bumpPermVersion()`.

A small constant is needed in `src/domain/auth/` and reused by `AuthenticateUseCase` (constant-time even for an unknown email):

```ts
// src/domain/auth/dummy-hash.ts — a real Argon2id hash of a throwaway value,
// computed once at module load (NOT a literal — keep params in sync with the hasher).
// Verified against on the unknown-email path so the login latency is identical
// whether or not the email exists (defeats user enumeration via timing).
```

#### `AuthenticateUseCase` (`authenticate.ts`)
- **Responsibility:** verify an email+password, enforce status/lockout, mint an access JWT + a refresh token (store only its hash), and reset/raise the failed-login counter. The single trust-critical login path.
- **Input:** `{ email: string, password: string, userAgent?: string, ip?: string }`.
- **Output:** `{ accessToken: string, accessTokenExpires: string /*ISO*/, refreshToken: string /*opaque, returned ONCE*/, refreshTokenExpires: string, permissions: string[], user: { id, email, name, role } }`.
- **Flow:**
  1. Normalise `email = email.trim().toLowerCase()` (mirror `TeamUseCase.inviteMember`).
  2. `const user = await db.users.getByEmail(email)`.
  3. **Constant-time even for unknown email:** if `user === null`, run `await hasher.verify(DUMMY_HASH, password)` (discard the result) and throw `InvalidCredentialsError` (401, generic message — never "no such user"). Same wall-clock cost as a real verify.
  4. **Lockout:** `lockoutPolicy(user.failed_login_count, user.locked_until, clock.now())` (pure, clock-injected). If locked ⇒ `AccountLockedError` (429, with `Retry-After` derived from `locked_until`).
  5. **Status:** `user.status !== 'active'` ⇒ `AccountDisabledError` (403). (`invited` users with a set password are `active`; `disabled` is 403.)
  6. `const ok = await hasher.verify(user.password_hash, password)`. On failure: `db.users.recordFailedLogin(user.id, clock.now())` (increments `failed_login_count`, sets `locked_until` when the threshold is hit — the policy boundary lives in `lockoutPolicy`), then `InvalidCredentialsError` (401).
  7. **Success:** `db.users.recordSuccessfulLogin(user.id, clock.now())` (zero `failed_login_count`, clear `locked_until`, set `last_login_at`). If `hasher.needsRehash(user.password_hash)` ⇒ best-effort `db.users.setPasswordHash(user.id, await hasher.hash(password))` (do NOT bump `token_version` on a transparent rehash — same credential).
  8. `const perms = await authorization.permissionsForUser(user.id)`; `const permVersion = await authMeta.getPermVersion()`.
  9. `const claims = buildAccessClaims(user, perms, permVersion, clock.now(), accessTtlSeconds)` (pure; sets `iss`/`aud`/`sub`/`email`/`name`/`role`/`perms`/`token_version`/`perm_version`/`iat`/`exp`/`jti`). `const accessToken = await tokenIssuer.signAccess(claims)`.
  10. Mint refresh: `const raw = randomToken(32)` (a `node:crypto` `randomBytes(32).toString('base64url')` helper in `src/application/shared/`); store **only** `sha256(raw)` via `db.refreshTokens.issue({ userId, tokenHash, familyId: newId(), issuedAt, expiresAt, userAgent, ip })`. Return the **raw** token to the caller (the only time it's visible).
  11. Log `info('login succeeded', { email })` — never the token.
- **Trust paths to test:** unknown email is constant-time + generic 401; wrong password increments + can lock; `disabled` ⇒ 403 even with the right password; lockout window boundaries (just-before / just-at via `FixedClock`); refresh stored as hash, raw never persisted; success resets the counter.

#### `RefreshUseCase` (`refresh.ts`)
- **Responsibility:** rotate a refresh token (revoke the presented one, issue a successor in the same family), detect reuse of a rotated-out token, re-check `status`+`token_version`, and mint a fresh access token. The rotating-refresh + reuse-detection core.
- **Input:** `{ refreshToken: string, userAgent?: string, ip?: string }`. **Output:** same shape as `AuthenticateUseCase` (new access + new refresh).
- **Flow:**
  1. `const hash = sha256(refreshToken)`; `const stored = await db.refreshTokens.findByHash(hash)`.
  2. `validateRefreshRotation(stored, clock.now())` (pure) → `'ok' | 'expired' | 'reuse' | 'unknown'`:
     - `unknown` (no row) ⇒ `RefreshTokenInvalidError` (401).
     - `expired` (`now >= expires_at`) ⇒ `RefreshTokenInvalidError` (401).
     - `reuse` (row exists but `revoked_at != null` — a rotated-out token was replayed) ⇒ `db.refreshTokens.revokeFamily(stored.familyId, clock.now())` then `RefreshReuseDetectedError` (401). **Theft response: kill the whole lineage.**
     - `ok` ⇒ continue.
  3. Reload the user: `const user = await db.users.getById(stored.userId)`. `status !== 'active'` ⇒ revoke the family + `AccountDisabledError`/401 (a disabled user can't refresh back in). If the user's `token_version` advanced past what this lineage was issued under, treat as revoked (401) — bump-on-disable propagates here too.
  4. `db.refreshTokens.rotate(stored.id, { newHash, replacedBy, issuedAt, expiresAt })` — atomically marks the old `revoked_at`/`replaced_by` and inserts the successor with the **same** `family_id`.
  5. Re-resolve perms + perm_version, `buildAccessClaims`, `signAccess`, return the new pair.
- **Trust paths:** fresh rotates; expired 401s; **reuse revokes the family** (a subsequent refresh of any family member 401s); disabled-mid-session can't refresh; rotation is atomic (no window where both old+new are valid).

#### `LogoutUseCase` (`logout.ts`)
- **Responsibility:** end sessions. **Inputs/outputs:**
  - `logout(refreshToken: string): Promise<void>` — `findByHash` → `revokeFamily(familyId)`. Idempotent: an unknown/already-revoked token is a silent no-op (logout must never error-leak). Returns 204-equivalent.
  - `logoutEverywhere(userId: string): Promise<void>` — `db.refreshTokens.revokeAllForUser(userId)` **and** `db.users.bumpTokenVersion(userId)`. The `token_version` bump invalidates every outstanding **access** token on the next pipeline request (the refresh revoke handles refresh). "Log out everywhere" = immediate global cut.
- **Trust paths:** logout is idempotent; `logoutEverywhere` both revokes refreshes and bumps `token_version` (proven by a follow-on `/api/*` call 401-ing).

#### `ProvisionUserUseCase` (`provision-user.ts`)
- **Responsibility:** one admin action creates a **login-capable** account (name/email/role + admin-set initial password). The headline self-service-provisioning use-case.
- **Input:** `{ actor: string /*token-derived admin email, for the audit line*/, name, email, roleName: string, initialPassword: string, forcePasswordChange?: boolean }`. **Output:** the created `User` (never the hash).
- **Flow (mirror `TeamUseCase.inviteMember` for normalisation + boundary-validation):**
  1. Normalise email (trim+lowercase). Reject a duplicate: `db.users.getByEmail` non-null ⇒ `InvalidPatchError`/`UserAlreadyExistsError` (409).
  2. **Validate the role exists:** `const role = await db.roles.getByName(roleName)`; null ⇒ `RoleNotFoundError` (400/404).
  3. Validate the password against a minimal policy (length floor; keep it a pure rule `validatePasswordPolicy` in `src/domain/auth/` so it's unit-tested) ⇒ `InvalidPatchError` (400) on failure.
  4. `const passwordHash = await hasher.hash(initialPassword)`.
  5. Assemble + boundary-validate the `User` (status `'active'`, `auth_provider:'password'`, `token_version:0`, `failed_login_count:0`, `created_at: clock.nowIso()`, `id: newId()`), parse through the domain schema (the `validateMember`-style guard), `db.users.create(user, passwordHash)`.
  6. Log `info('user provisioned', { actor, email, role: roleName })`.
- **Trust paths:** duplicate email 409s; unknown role rejected; password hashed (never stored plain); the returned DTO has no hash; one call yields an account that can immediately `POST /auth/login`.

#### `ManageRolesUseCase` (`manage-roles.ts`)
- **Responsibility:** the runtime-editable RBAC + user-admin surface. Every role-permission mutation bumps the **global** `perm_version`; every user security change bumps that user's `token_version`.
- **Methods (all take a token-derived `actor` for audit; outputs are the affected entity):**
  - `listRoles()` / `getRole(name)` — read.
  - `createRole({ actor, name, description, permissions: string[] })` — validate each permission key against the `Permission` enum (a bad key ⇒ `InvalidPatchError`/400); insert role + `role_permissions`; **bump `perm_version`**.
  - `updateRolePermissions({ actor, roleName, permissions })` — replace the set; guard nothing here on `is_system` *names* (admins may re-scope built-ins' perms is a product call — default: **block editing `is_system` roles' permission set** to keep `admin`=all; document the choice); **bump `perm_version`**.
  - `deleteRole({ actor, roleName })` — `is_system` ⇒ `RoleInUseError`/`SystemRoleError` (409); if any user holds it ⇒ `RoleInUseError` (409); else delete + **bump `perm_version`**.
  - `assignRoleToUser({ actor, userId, roleName })` — validate role exists; `db.users.setRole`; **bump that user's `token_version`** (perms changed ⇒ existing tokens must re-mint).
  - `setUserStatus({ actor, userId, status: 'active'|'disabled' })` — `db.users.setStatus`; **bump `token_version`** (immediate revoke on disable); on disable also `db.refreshTokens.revokeAllForUser(userId)`.
  - `changePassword({ actor, userId, newPassword })` (admin reset) and the self-service `changeOwnPassword({ actor, currentPassword, newPassword })` (verify current first) — re-hash; **bump `token_version`** ("log out everywhere on password change").
- **Trust paths:** unknown permission key rejected; system-role delete/edit blocked; deleting an in-use role 409s; disable bumps `token_version` **and** revokes refreshes; password change bumps `token_version`; every `role_permissions` write bumps `perm_version` (proven by a token issued pre-change being re-resolved post-change — see §2.4 step 2c).

#### `AuthorizationUseCase` (`authorization.ts`)
- **Responsibility:** resolve a user's effective permission set from role → `role_permissions`. The single source of truth for "what can this user do", reused by claim-minting (login/refresh) and by `GET /api/permissions/me`, and by the per-request guard on a `perm_version` mismatch.
- **`permissionsForUser(userId: string): Promise<Set<Permission>>`:** `const user = await db.users.getById(userId)` (null ⇒ empty set); `const keys = await db.rolePermissions.listForRole(user.role_id)`; return `new Set(keys)` (or run through the pure `permissionsForRole(role, rolePermRows)` rule so the projection is unit-tested). No side effects, no caching beyond the request.
- **Trust paths:** a user with no role ⇒ empty set (deny-by-default); the set exactly equals the seeded `role_permissions`; substitutable so the guard and the claim-minter never diverge.

---

### 2.2 New `AuthApi` router — `src/adapters/http/auth-api.ts`

A **third** bare-Node `http` router, sibling to `ReviewApi` (`src/adapters/http/review-api.ts`) and `PublicApi` (`src/adapters/http/public-api.ts`). It owns the **unauthenticated** auth endpoints (`/auth/*`) and the **public** JWKS endpoint. Construction mirrors `ReviewApi`: constructor takes the auth use-cases + `logger` + an options bag (`{ corsAllowOrigin? }`). It exposes `handle(req, res)` (the same testable, socket-free entry the other two routers expose) — `serve.ts` calls it; it does **not** bind its own socket.

**Reuse from `review-api.ts` verbatim** (do NOT re-implement): copy/share `readBody` (+ `MAX_BODY_BYTES`/`TOO_LARGE`/`MALFORMED` sentinels → 413/400), `sendJson`, `sendError`, `parseIntParam`, the `applyCors`/OPTIONS-preflight pattern, and a `mapErrors`-style typed-error→status switch (extended with the new auth errors — see §2.3 table). The cleanest move is to **extract these shared HTTP helpers into `src/adapters/http/http-helpers.ts`** and import them into all three routers (a small refactor; note it in the PR). The `applyCors` block must advertise `Authorization, Content-Type` and `GET, POST, PATCH, DELETE, OPTIONS` (the panel sends bearers cross-origin), and pin the exact `corsAllowOrigin` (never `*` — this surface is credentialed), exactly as `ReviewApi.applyCors` already does.

> **Where the Users/Roles endpoints live:** the plan lists `/api/users`, `/api/roles`, `/api/permissions`, `/api/permissions/me`. These are **gated `/api/*` admin endpoints** and therefore belong on **`ReviewApi`** (which already owns `/api/*` and, post-P2, owns the `authenticate(req)` guard + the route→permission registry — §2.4). The dedicated `AuthApi` router owns ONLY the **unauthenticated** `/auth/*` + the **public** JWKS. Implement the user/role/permission handlers as new route blocks in `review-api.ts`, each gated by its registry permission. Inject `ProvisionUserUseCase`/`ManageRolesUseCase`/`AuthorizationUseCase` into `ReviewApi`'s constructor alongside the existing use-cases. (Dispatch stays clean: `serve.ts` routes `/auth/*` + `/.well-known/*` → `AuthApi`, everything else → the `/v1` vs `/api` split — see §2.6.)

#### Endpoints owned by `AuthApi` (`/auth/*` + JWKS)

| Method | Path | Auth | Request body (zod) | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/auth/login` | none (the credential IS the auth) | `{ email: string.email(), password: string.min(1) }` | `200 { accessToken, accessTokenExpires, refreshToken, refreshTokenExpires, permissions: string[], user: { id, email, name, role } }` | 400 malformed/validation, 401 `InvalidCredentialsError`, 403 `AccountDisabledError`, 429 `AccountLockedError` (+ `Retry-After`), 413 oversized |
| `POST` | `/auth/refresh` | the presented refresh token (in body) | `{ refreshToken: string.min(1) }` | `200` (same shape as login — new pair) | 400, 401 `RefreshTokenInvalidError`/`RefreshReuseDetectedError`, 403 disabled, 413 |
| `POST` | `/auth/logout` | the presented refresh token (in body) | `{ refreshToken: string.min(1) }` | `204` (empty) | 400, 413. Unknown/already-revoked token still `204` (idempotent — never confirm validity) |
| `GET` | `/.well-known/jwks.json` | none (public) | — | `200 { keys: [JWK] }` with `Cache-Control: public, max-age=300` | — (always serves the current public key set) |

- **`POST /auth/login`** body parsing: `LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) })`; on `!parsed.success` ⇒ `sendError(res, 400, 'email and password are required')`. Pull `userAgent`/`ip` from `req.headers['user-agent']` / the socket for the refresh-token row (best-effort; never trusted for auth). Wrap the use-case call in the shared `mapErrors`. **Do not** echo whether the email exists — the use-case already returns a uniform 401.
- **`POST /auth/refresh`**: `RefreshBody = z.object({ refreshToken: z.string().min(1) })`. The token travels in the **body** (not a bearer header) because the panel holds it server-side in its Auth.js JWT; this keeps the access-token bearer slot free for `/api/*`.
- **`POST /auth/logout`**: `LogoutBody = z.object({ refreshToken: z.string().min(1) })` → `LogoutUseCase.logout`. Always `204`. (The global "log out everywhere" is an authenticated `/api/*` action — see the users table.)
- **`GET /.well-known/jwks.json`**: `sendJson(res, 200, tokenIssuer.jwks())` with the cache header. No body read, no auth. This is the only path `AuthApi` serves that the *pipeline itself* doesn't consume (the panel does **not** verify — it forwards; the pipeline verifies). It exists for completeness / future verifiers and for the live smoke test ("JWKS reachable").

#### Endpoints added to `ReviewApi` (`/api/users`, `/api/roles`, `/api/permissions`) — gated

| Method | Path | Permission | Request body (zod) | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/api/users` | `team:manage` | `{ name, email: email(), role: string, password: string.min(MIN_PW), force_password_change?: boolean }` | `201 { id, email, role }` | 400 validation/bad-role, 409 duplicate email, 401/403 |
| `GET` | `/api/users` | `team:manage` | — | `200 { users: [{ id, name, email, role, status, last_login_at, review_count }] }` | 401/403 |
| `PATCH` | `/api/users/:id` | `team:manage` (status/role/password) · self for own name | partial: `{ name?, role?, status?: 'active'\|'disabled', password? }` | `200 { user }` | 400, 404 user, 409 (e.g. last-admin disable), 401/403 |
| `GET` | `/api/roles` | `roles:manage` | — | `200 { roles: [{ name, description, is_system, permissions: string[] }] }` | 401/403 |
| `POST` | `/api/roles` | `roles:manage` | `{ name, description?, permissions: string[] }` | `201 { role }` | 400 bad permission key, 409 dup name, 401/403 |
| `PATCH` | `/api/roles/:name` | `roles:manage` | `{ description?, permissions?: string[] }` | `200 { role }` | 400, 404 role, 409 system-role, 401/403 |
| `DELETE` | `/api/roles/:name` | `roles:manage` | — | `200 { deleted: true }` | 404, 409 `RoleInUseError`/system, 401/403 |
| `GET` | `/api/permissions` | `roles:manage` | — | `200 { permissions: [{ key, label?, group? }] }` (enumerated from the seeded `permissions` table so the panel can render the role editor without shipping the enum) | 401/403 |
| `GET` | `/api/permissions/me` | **any valid token** | — | `200 { permissions: string[], role, email }` (from the request's verified claims / `AuthorizationUseCase`) | 401 |

Each new `ReviewApi` block follows the existing template exactly (see `review-api.ts:262–307`, the promote block): match the route with a regex (use the existing `UUID_SEG` for `/api/users/:id`; a `[^/]+` capture for `/api/roles/:name` since role names are free-form string keys, like the `settings/:key` and `field-proposals/:key` blocks); call `this.authenticate(req)` (§2.4) and check the registry permission *before* `readBody`; `readBody` → 413/400 sentinels; `safeParse` the body → 400; wrap the use-case in `this.mapErrors`. **`approver`/`actor` is taken from the authenticated identity, never the body.** For `PATCH /api/users/:id`, the self-name path is allowed when `identity.userId === :id` even without `team:manage` (mirrors the existing `PATCH /api/profile` "own row only" intent) — gate the role/status/password sub-fields on `team:manage`.

> `/api/users` **supersedes** the existing `POST /api/team` + `PATCH /api/profile` blocks. During the dual-accept window keep `/api/team` working (it already writes the row that `0019` renames to `users`); the panel migrates to `/api/users` in P4; remove `/api/team` in P5. `GET /api/users` reuses the `TeamUseCase` read model (`listTeam`, now over `users`) for the `review_count` derivation.

---

### 2.3 New domain auth-errors → HTTP status (extend `mapErrors`)

Add these to `src/domain/auth/auth-errors.ts` (P1) as `DomainError` subclasses (the exact pattern of `src/domain/errors/errors.ts` — a `readonly code` string + a contextual message), and extend the shared `mapErrors` switch with the rows below (the `ReviewApi.mapErrors` at `review-api.ts:618` is the template; the extracted shared helper carries all rows):

| Error | Status | Notes |
|---|---|---|
| `InvalidCredentialsError` | **401** | generic message only ("invalid email or password") — never reveals which |
| `AccountDisabledError` | **403** | |
| `AccountLockedError` | **429** | handler also sets `Retry-After` from `locked_until` |
| `RefreshTokenInvalidError` | **401** | covers unknown + expired |
| `RefreshReuseDetectedError` | **401** | family already revoked by the use-case before this maps |
| `PermissionDeniedError` | **403** | thrown by the per-request guard when the registry permission is absent |
| `RoleNotFoundError` | **404** (or 400 in provision) | |
| `RoleInUseError` / `SystemRoleError` | **409** | delete/edit of a system or referenced role |
| `UserAlreadyExistsError` | **409** | duplicate email on provision |
| `UnauthenticatedError` | **401** | no/invalid token on a gated `/api/*` |

Keep the **uniform 401 body** (`{ error: 'unauthorized' }`) the existing `authorized()` path already returns, so a probe can't distinguish "no token" from "bad token" from "revoked token".

---

### 2.4 Per-request enforcement — replace `ReviewApi.authorized()`

Today `ReviewApi.authorized(req): boolean` (`review-api.ts:605`) only constant-time-compares one static bearer against `this.authToken`. Replace it with an **identity-returning** guard and a **route→permission registry**.

#### `authenticate(req): Promise<Identity | null>`
Add to `ReviewApi` (inject `tokenIssuer`, `db` (for the user reload), and `AuthorizationUseCase` via the constructor). Returns `Identity` or `null` (the caller `sendError(res, 401, 'unauthorized')` on null — same shape as today):

```ts
interface Identity {
  userId: string;
  email: string;     // becomes `approver` everywhere
  role: string;
  perms: Set<string>;
  tokenVersion: number;
}
```

Flow (every step a 401 on failure, logged at `warn` server-side, generic to the client):
1. Read `Authorization: Bearer <jwt>`; absent/!startsWith ⇒ 401.
2. `const claims = await tokenIssuer.verifyAccess(jwt)` — **pins `algorithms:['ES256']`**, validates `iss === AUTH_JWT_ISS` and `aud === AUTH_JWT_AUD`, checks `exp`. Any throw (alg swap, `alg:none`, bad sig, wrong iss/aud, expired) ⇒ 401. (The verifier is `JoseTokenIssuer`; the guard never touches `jose` directly.)
3. `const user = await db.users.getById(claims.sub)`:
   - a. `user === null || user.status !== 'active'` ⇒ 401/403 (a deleted/disabled user's still-unexpired token is dead).
   - b. `claims.token_version !== user.token_version` ⇒ **401 — immediate revoke** (the disable/role-change/password-change/`logoutEverywhere` lever).
   - c. **`perm_version` reconciliation:** `const current = await authMeta.getPermVersion()`; if `claims.perm_version !== current` ⇒ `perms = await authorization.permissionsForUser(user.id)` (re-resolve from DB so a mid-token permission change is honoured before `exp`); else `perms = new Set(claims.perms)` (the fast path — no DB read).
4. Return `{ userId: user.id, email: user.email, role: user.role, perms, tokenVersion: user.token_version }`.

**`approver` derivation (the headline fix):** every handler that currently reads `parsed.data.approver` from the body now passes `identity.email`. The body `approver` (and any body `role`) is **ignored** — accept-but-ignore for one release (so the panel can cut over without a lockstep deploy), then drop the field from the request schemas in P5. Concretely, in each gated block call `const identity = await this.authenticate(req); if (!identity) return sendError(res, 401, 'unauthorized');` then `requirePermission(identity, '<perm>')` (throws `PermissionDeniedError` → 403 via `mapErrors`, or pre-check and `sendError(res, 403, 'forbidden')`), and call the use-case with `identity.email` as the approver/actor.

#### Route → permission registry
A single central table evaluated before each handler (a `const ROUTE_PERMISSIONS` map of `{ method, test: (path)=>boolean, permission }`, or — simpler and matching the existing per-block style — call `requirePermission(identity, '<perm>')` inline in each block). Derived exhaustively from the current `authorized(req)` call-sites in `review-api.ts`:

| Method · Path | Required permission |
|---|---|
| `POST /api/candidates/:id/approve` (`:381`) | `candidate:approve` |
| `POST /api/candidates/:id/reject` (`:405`) | `candidate:reject` |
| `PATCH /api/candidates/:id` (`:362`) | `candidate:edit` |
| `GET /api/evidence/:id/:artifact` (`:350`) | `evidence:read` |
| `POST /api/field-proposals/:key/promote` (`:263`) | `field-proposals:promote` |
| `POST /api/manual-capture-tasks` (`:285`) | `manual-capture:write` |
| `POST /api/manual-capture-tasks/:id/complete` (`:312`) | `manual-capture:write` |
| `POST /api/sources` (`:428`) | `sources:write` |
| `POST /api/sources/:id/approve` (`:551`) | `sources:review` |
| `POST /api/sources/:id/reject` (`:567`) | `sources:review` |
| `POST /api/team` → `POST /api/users` (`:454`) | `team:manage` |
| `PATCH /api/profile` (`:471`) | self (any authed; own row only — no named permission) |
| `PATCH /api/users/:id` | `team:manage` (status/role/password); self for own name |
| `PATCH /api/settings/:key` (`:486`) | `settings:write` |
| `POST /api/alerts/:id/acknowledge` (`:512`) | `alerts:manage` |
| `POST /api/alerts/:id/resolve` (`:525`) | `alerts:manage` |
| `GET/POST/PATCH/DELETE /api/roles[...]` | `roles:manage` |
| `GET /api/permissions` | `roles:manage` |
| `GET /api/permissions/me` | self (any valid token) |
| **Every other `GET /api/*` read** (`/api/candidates*`, `/api/audit`, `/api/published`, `/api/metrics*`, `/api/settings`, `/api/sources*`, `/api/team`, `/api/alerts`, `/api/field-proposals`, `/api/manual-capture-tasks`, `/api/candidates/:id/reviews`, `/api/sources/:id/reviews`) | **valid token only** — no named permission, but no longer open |

**The reads-now-require-auth change:** today GET `/api/*` blocks have **no** `authorized()` call (only POST/PATCH do). Post-P2 every GET handler must first `const identity = await this.authenticate(req); if (!identity) return sendError(res, 401, 'unauthorized');` before serving. Add the guard to each read block (`/api/candidates`, `/api/candidates/counts`, `/api/candidates/freshness`, `/api/field-proposals`, `/api/audit`, `/api/published`, `/api/metrics/throughput`, `/api/metrics`, `/api/settings`, `/api/manual-capture-tasks`, `/api/candidates/:id/reviews`, `/api/evidence/:id/:artifact` (already gated — now `evidence:read`), `/api/sources`, `/api/sources/pending`, `/api/sources/:id/reviews`, `/api/team`, `/api/alerts`). `GET /api/health` stays **open** (a liveness probe). `GET /` (test page) stays open. The `OPTIONS` preflight stays unauthenticated (it carries no bearer — the existing `:184` block is correct as-is).

**`PublicApi` (`/v1/*`) is untouched** — no JWKS dependency, no bearer, no `authenticate`. The existing `serve.ts` total prefix dispatch already guarantees a `/v1/*` request never reaches `ReviewApi`.

**Dual-accept window (P2 only):** to let the panel cut over without a flag-day, `authenticate` may *also* accept the legacy static `REVIEW_API_TOKEN` when it's still configured: if the bearer equals the static token (constant-time, the existing `safeEqual` at `review-api.ts:792`), synthesize a system identity with the full permission set and `email: 'legacy-token@system'`. This keeps every old caller working while new per-user JWTs flow. **Remove this branch in P5** (the static token is retired). Document it as a temporary, explicitly-time-boxed exception in `docs/KNOWN_ISSUES.md`.

---

### 2.5 Wiring in `container.ts`

In the `Container` constructor (after the existing use-cases at `container.ts:208–236`), construct the auth ports + use-cases and expose them as `readonly` fields:

```ts
// Ports (P1 adapters):
this.passwordHasher = new Argon2idHasher(config.auth.argon2);          // src/adapters/auth/argon2id-hasher.ts
this.tokenIssuer    = new JoseTokenIssuer(config.auth.jwt, this.clock); // src/adapters/auth/jose-token-issuer.ts (Clock for iat/exp)

// Use-cases:
this.authorization = new AuthorizationUseCase(this.db, this.logger);
this.authenticate  = new AuthenticateUseCase(
  this.db, this.passwordHasher, this.tokenIssuer, this.authorization, this.clock, this.logger, config.auth.ttls,
);
this.refresh       = new RefreshUseCase(this.db, this.tokenIssuer, this.authorization, this.clock, this.logger, config.auth.ttls);
this.logout        = new LogoutUseCase(this.db, this.clock, this.logger);
this.provisionUser = new ProvisionUserUseCase(this.db, this.passwordHasher, this.clock, this.logger, config.auth.passwordPolicy);
this.manageRoles   = new ManageRolesUseCase(this.db, this.passwordHasher, this.clock, this.logger);
```

- Add `import` lines for the adapters (alongside the existing adapter imports at the top) and the use-cases (extend the barrel import from `../application/index.js`).
- `JoseTokenIssuer` takes the injected `this.clock` so `iat`/`exp` are deterministic in tests (a `FixedClock` makes token tests reproducible) — mirrors how every TTL-bearing use-case already takes `this.clock`.
- The existing `init()` (`container.ts:248`) is the natural place to **fail loudly** if the signing key is malformed (parse it once at startup), keeping the loud-failure policy (`buildLlm`/`buildEvidenceStore` set the precedent).
- These fields feed `serve.ts`: `AuthApi` gets `{ authenticate, refresh, logout, tokenIssuer }`; `ReviewApi`'s constructor is extended with `{ provisionUser, manageRoles, authorization, tokenIssuer }` and (transitionally) still receives `config.reviewApi.authToken` for the dual-accept branch.

> **LSP / contract-suite reminder (P1, restated):** `InMemoryDb` and `PostgresDb` must implement the new repos identically, both passing the shared port-contract suites under `test/contracts/`. The integration tier (`npm run test:integration`) drives the real `Container` + Postgres end-to-end (login → gated write → `approver` from token → disable → 401), per `.claude/rules/testing.md`.

---

### 2.6 Prefix dispatch in `serve.ts`

Extend the total prefix dispatch (`serve.ts:43–56`). Construct an `AuthApi` next to the existing `ReviewApi`/`PublicApi`, and add the `/auth/*` + `/.well-known/*` branch **first** (most specific), keeping the existing `/v1/*`-vs-`/api/*` split as the fallthrough so dispatch stays **total** (every request lands in exactly one router):

```ts
const authApi = new AuthApi(
  container.authenticate, container.refresh, container.logout, container.tokenIssuer, container.logger,
  { corsAllowOrigin: config.reviewApi.adminCorsAllowOrigin },
);
// ...
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const handler =
    path.startsWith('/auth/') || path === '/.well-known/jwks.json'
      ? authApi.handle(req, res)
      : path === '/v1' || path.startsWith('/v1/')
        ? publicApi.handle(req, res)
        : reviewApi.handle(req, res);     // /api/* + the test page
  handler.catch((err) => { /* existing generic-500 handler */ });
});
```

Extend the `ReviewApi` constructor call (`serve.ts:20–37`) with the new use-cases. Update the startup log block (`serve.ts:60–68`): print the auth base (`http://localhost:${port}/auth`) and the JWKS URL, and **change the warning** — instead of "no `REVIEW_API_TOKEN` set", warn when **no signing key** is configured (`config.auth.jwt.privateKey` unset) that auth is disabled / the surface is open, mirroring the existing no-token warning. During the dual-accept window keep the `REVIEW_API_TOKEN` warning too.

---

### 2.7 Config additions — `src/config/config.ts` + `.env.example`

Add an `auth` block to `ConfigSchema` (after `reviewApi`, before/after `publicApi`) and populate it in `loadConfig`'s `raw` object using the existing `emptyToUndefined` + default-string conventions (every numeric coerced via `z.coerce.number()`, every bool via the `boolish` helper):

```ts
auth: z.object({
  jwt: z.object({
    privateKey: z.string().optional(),     // ES256 private key (PEM or JWK JSON). Unset ⇒ auth disabled (startup warning).
    kid: z.string().optional(),            // key id stamped in the JWT header + JWKS
    nextPrivateKey: z.string().optional(), // optional overlap key for rotation (verify-old/sign-new)
    iss: z.string().min(1),                // default 'dealroute-pipeline'
    aud: z.string().min(1),                // default 'dealroute-panel'
  }),
  ttls: z.object({
    accessSeconds:  z.coerce.number().int().positive(),  // ~900 (15 min)
    refreshSeconds: z.coerce.number().int().positive(),  // ~604800 (7 days)
  }),
  argon2: z.object({                       // @node-rs/argon2 params (memory-hard; tuned for Fly)
    memoryCost: z.coerce.number().int().positive(),  // KiB, e.g. 19456 (19 MiB, OWASP floor)
    timeCost:   z.coerce.number().int().positive(),  // iterations, e.g. 2
    parallelism:z.coerce.number().int().positive(),  // e.g. 1
  }),
  passwordPolicy: z.object({
    minLength: z.coerce.number().int().min(8),         // e.g. 12
  }),
  login: z.object({
    maxFailedAttempts: z.coerce.number().int().positive(),  // lockout threshold, e.g. 5
    lockoutSeconds:    z.coerce.number().int().positive(),  // e.g. 900
  }),
}),
```

`loadConfig` additions (mirror the `reviewApi`/`agent` blocks):
```ts
auth: {
  jwt: {
    privateKey:     emptyToUndefined(env.AUTH_JWT_PRIVATE_KEY),
    kid:            emptyToUndefined(env.AUTH_JWT_KID),
    nextPrivateKey: emptyToUndefined(env.AUTH_JWT_PRIVATE_KEY_NEXT),
    iss:            env.AUTH_JWT_ISS ?? 'dealroute-pipeline',
    aud:            env.AUTH_JWT_AUD ?? 'dealroute-panel',
  },
  ttls:  { accessSeconds: env.AUTH_ACCESS_TTL_SECONDS ?? '900', refreshSeconds: env.AUTH_REFRESH_TTL_SECONDS ?? '604800' },
  argon2:{ memoryCost: env.AUTH_ARGON2_MEMORY_KIB ?? '19456', timeCost: env.AUTH_ARGON2_TIME_COST ?? '2', parallelism: env.AUTH_ARGON2_PARALLELISM ?? '1' },
  passwordPolicy: { minLength: env.AUTH_PASSWORD_MIN_LENGTH ?? '12' },
  login: { maxFailedAttempts: env.AUTH_LOGIN_MAX_ATTEMPTS ?? '5', lockoutSeconds: env.AUTH_LOGIN_LOCKOUT_SECONDS ?? '900' },
},
```

**Retiring `REVIEW_API_TOKEN`:** keep `reviewApi.authToken` in the schema through P2–P4 for the dual-accept branch, then **remove** it (and the `serve.ts` no-token warning) in P5; `config.reviewApi.adminCorsAllowOrigin` **stays** (CORS is independent of the token). The new `AUTH_JWT_*` keys are required for real auth — `serve.ts` warns at startup when `config.auth.jwt.privateKey` is unset (auth effectively disabled), the direct analogue of the current no-token warning.

`.env.example` — extend the "Review API" block (currently lines 102–115) with an `# ── Auth / IdP ──` section documenting every new var in the house comment style (what it is, the safe default, the security note that `AUTH_JWT_PRIVATE_KEY` is a secret never committed, and that the panel forwards per-user tokens — it does not hold a shared one). Mark `REVIEW_API_TOKEN` as **deprecated (dual-accept window; removed in P5)** rather than deleting the line yet.

---

### 2.8 Tests to add (per `.claude/rules/testing.md`)

- **Unit (`npm test`, against fakes):** each use-case's happy + trust-critical failure paths with a `FixedClock` — `AuthenticateUseCase` (unknown-email constant-time, wrong-password lockout boundaries, disabled→403), `RefreshUseCase` (fresh/expired/**reuse-revokes-family**/disabled-mid-session), `LogoutUseCase` (idempotent + `logoutEverywhere` bumps `token_version`), `ProvisionUserUseCase` (dup email, unknown role, hash-not-plain), `ManageRolesUseCase` (bad-permission-key, system-role guard, in-use 409, `perm_version` bump), `AuthorizationUseCase` (no-role⇒empty set).
- **HTTP-adapter unit (match `review-api.test.ts` depth):** `auth-api.test.ts` (login/refresh/logout/JWKS via `handle` with no socket) + new `review-api.test.ts` blocks for the user/role/permission endpoints and the **guard** (no token⇒401 on a read, `token_version` mismatch⇒401, missing-permission⇒403, body `approver`/`role` ignored, dual-accept legacy token still works).
- **Adversarial / boundary (the new parser edges — `/auth/login`, `/auth/refresh`, the JWT verifier):** `alg:none` / alg-swap / tampered-sig / expired / wrong-iss-aud / missing-claims all rejected; oversized body⇒413; malformed JSON⇒400; refresh reuse; lockout; **timing parity** unknown-vs-known email.
- **Integration (`npm run test:integration`, real `Container` + Postgres, injected `Clock`):** login → access+refresh → gated write with the token → the recorded `approver` equals the token's email (not any body value) → disable the user → next `/api/*` call 401s → refresh-after-disable fails.
- **Port-contract suites (both `InMemoryDb` + `PostgresDb`):** `PasswordHasher`, `TokenIssuer`, and the four new repos (in-memory ≡ Postgres).

### 2.9 OpenAPI / Postman (same commit — `.claude/rules/api-and-openapi.md`)

Touching the HTTP surface ⇒ update `docs/api/openapi.yaml` in the **same** change: add `/auth/login`, `/auth/refresh`, `/auth/logout`, `/.well-known/jwks.json`, `/api/users`, `/api/roles[/{name}]`, `/api/permissions`, `/api/permissions/me`; mark every gated `/api/*` op `security: [{ bearerAuth: [] }]` and note the required permission per op; keep `/auth/*` + JWKS `security: []`; mirror the **real** zod bounds (`limit` caps, the `Permission` enum values, the 401/403/409/429/413/400 status codes from §2.3). Then run `npm run api:lint` + `npm run api:postman` and commit **both** `openapi.yaml` and the regenerated `dealroute.postman_collection.json` (the `api:check` CI gate fails on structural drift). The public `PublicDeal` allow-list is **untouched** (no auth field leaks into `/v1/*`).

---

## Admin Panel — Phase 4: Cutover to per-user pipeline auth

This phase rewires the panel from its **static env allow-list + one shared `PIPELINE_TOKEN`** to the pipeline-as-IdP model: Credentials authenticate against `POST /auth/login`, the panel forwards a **per-user** access token on every proxy call, and page access gates off **permissions copied from the verified token** (cosmetic — the pipeline is the real gate). It assumes Pipeline P1–P3 are merged (the `/auth/*` + JWKS endpoints, the `/api/users|roles|permissions` admin surface, and the dual-accept window where the pipeline still accepts the old static token) so the panel can cut over while the pipeline tolerates both. Every claim below is anchored to the panel files as they exist today.

### 4.0 What the pipeline returns (the contract this phase consumes)

`POST {PIPELINE_API_URL}/auth/login` with `{ email, password }`:
- **200** → `{ user: { id, email, name, role }, accessToken, refreshToken, accessTokenExpires }` where `accessToken` is the ES256 JWT, `accessTokenExpires` is an absolute epoch-ms (the panel must not re-derive it from `exp` parsing — the pipeline owns TTL), and `permissions: string[]` is the inlined perm list (e.g. `["candidate:approve","settings:write"]`). (Permissions live in the token claims, but the login response surfaces them as a flat array so the panel never decodes the JWT.)
- **401** (`InvalidCredentialsError`, generic) / **403** (`AccountDisabledError`) / **429** (`AccountLockedError`) → no tokens.

`POST {PIPELINE_API_URL}/auth/refresh` with `{ refreshToken }`:
- **200** → a fresh `{ accessToken, refreshToken, accessTokenExpires, permissions }` (rotation: the old refresh is now revoked).
- **401** → refresh invalid / reuse-detected / user disabled → the panel must force re-login.

`GET {PIPELINE_API_URL}/api/permissions/me` (any authed user, gated on a valid token) → `{ permissions: string[] }` — used by the refresh path so a `perm_version`-driven re-resolution reaches the session without a full re-login.

> All three are **server-side only**. The browser never sees `accessToken`/`refreshToken` — they live exclusively on the Auth.js JWT (the HS256 `httpOnly` cookie) and are read back server-side via `auth()`.

### 4.1 Credentials provider → `POST /auth/login` (`lib/auth/config.ts`)

Today `lib/auth/config.ts:33-46` builds the Credentials `authorize` around `authorizeCredentials({ allowlist, limiter }, raw, ip)` (from `lib/auth/authorize.ts`), which bcrypt-compares against the parsed `REVIEWER_ALLOWLIST`. Replace the **verification source** with a pipeline call, but **keep the per-email/per-IP `RateLimiter`** (`lib/auth/rate-limit.ts`) as defense-in-depth in front of it.

Concretely, in `lib/auth/config.ts`:
- Delete the `allowlist` parse (`const allowlist = parseAllowlist(env.REVIEWER_ALLOWLIST)`, line 22) and the `findReviewer`/`parseAllowlist`/`Reviewer` import (line 10).
- Keep `loginLimiter` (lines 25–28) and the `clientIpFromHeaders` import (`lib/auth/authorize.ts:75`).
- Rewrite `authorize` to: parse `{ email, password }` with the existing `credentialsInput` zod shape (lift it out of `authorize.ts` or re-declare locally), short-circuit on `loginLimiter.isLocked(email/ip)`, call a new server-only `pipelineLogin(email, password)` helper, record a failure + return `null` on non-200, and on 200 `reset` the limiter and return the Auth.js user **plus** the tokens so the `jwt` callback can stash them.

Auth.js's Credentials `authorize` may only return a `User`-shaped object, so the tokens ride on it as extra fields and the `jwt` callback lifts them onto the token, then strips them from `session`:

```ts
// lib/auth/login.ts (new; server-only) — the ONLY place the panel calls /auth/login.
import "server-only";
import { parseServerEnv } from "@/lib/env/server";

const env = parseServerEnv();

export interface PipelineLoginOk {
  id: string;
  email: string;
  name: string;
  role: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpires: number; // epoch ms, from the pipeline
  permissions: string[];
}

export async function pipelineLogin(
  email: string,
  password: string,
): Promise<PipelineLoginOk | null> {
  const res = await fetch(`${env.PIPELINE_API_URL.replace(/\/$/, "")}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!res.ok) return null; // 401/403/429 → generic null (no enumeration)
  const data = (await res.json()) as unknown;
  // Parse through a zod schema (loginResponseSchema) before trusting it —
  // boundary validation, code-style.md "never trust raw data".
  return parseLoginResponse(data);
}
```

```ts
// lib/auth/config.ts — Credentials.authorize (rate-limit kept, allow-list gone)
authorize: async (raw, request) => {
  const headers =
    request && "headers" in request ? (request.headers as Headers) : new Headers();
  const ip = clientIpFromHeaders(headers);
  const parsed = credentialsInput.safeParse(raw);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;

  const emailKey = `email:${email.toLowerCase()}`;
  const ipKey = ip ? `ip:${ip}` : null;
  if (loginLimiter.isLocked(emailKey) || (ipKey && loginLimiter.isLocked(ipKey))) {
    return null; // surface RateLimitedError if you keep the throw-path; null is simpler post-cutover
  }

  const result = await pipelineLogin(email, password);
  if (!result) {
    loginLimiter.recordFailure(emailKey);
    if (ipKey) loginLimiter.recordFailure(ipKey);
    return null;
  }
  loginLimiter.reset(emailKey);
  if (ipKey) loginLimiter.reset(ipKey);

  // Tokens ride on the user object → lifted onto the JWT in the `jwt` callback.
  return {
    id: result.id,
    email: result.email,
    name: result.name,
    role: result.role,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    accessTokenExpires: result.accessTokenExpires,
    permissions: result.permissions,
  };
},
```

Then in the **`jwt` callback** (replacing the allow-list `jwt` at `lib/auth/config.ts:77-83`), stash the auth material on first sign-in (the `user` arg is only present at sign-in):

```ts
jwt: async ({ token, user }) => {
  // First sign-in: lift the pipeline tokens onto the Auth.js JWT.
  if (user && "accessToken" in user) {
    token.accessToken = (user as PipelineLoginOk).accessToken;
    token.refreshToken = (user as PipelineLoginOk).refreshToken;
    token.accessTokenExpires = (user as PipelineLoginOk).accessTokenExpires;
    token.permissions = (user as PipelineLoginOk).permissions;
    token.role = (user as PipelineLoginOk).role;
    return token;
  }
  // Subsequent calls: refresh-rotation (see §4.2).
  if (Date.now() < (token.accessTokenExpires as number) - REFRESH_SKEW_MS) {
    return token;
  }
  return refreshPipelineToken(token);
},
```

`token_version`/`perm_version` are **not** the panel's concern — they live in the pipeline's verified claims and are enforced pipeline-side. The panel only holds the opaque `accessToken`/`refreshToken` and the `permissions` array.

### 4.2 Refresh rotation in the `jwt` callback (the Auth.js refresh-token-rotation pattern)

This is the standard Auth.js [refresh-token-rotation](https://authjs.dev/guides/refresh-token-rotation) recipe: the `jwt` callback fires on every session read; if the access token is still fresh return the token unchanged, otherwise call `/auth/refresh`, swap the pair, and on failure stamp `token.error` so the `session` callback can force a re-login.

```ts
// lib/auth/refresh.ts (new; server-only)
const REFRESH_SKEW_MS = 30_000; // refresh ~30s early to avoid edge races

export async function refreshPipelineToken(token: JWT): Promise<JWT> {
  try {
    const res = await fetch(`${PIPELINE_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token.refreshToken }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`refresh ${res.status}`);
    const next = parseRefreshResponse(await res.json()); // zod-validated
    return {
      ...token,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken, // ROTATED — old one is now revoked pipeline-side
      accessTokenExpires: next.accessTokenExpires,
      permissions: next.permissions, // honors a perm_version-driven re-resolve
      error: undefined,
    };
  } catch {
    // Reuse-detected / disabled / expired → cannot recover; force re-login.
    return { ...token, error: "RefreshAccessTokenError" };
  }
}
```

The `session` callback (extending the edge-safe one at `lib/auth/edge-config.ts:30-35`) must surface the error and the permissions so client code reacts:

```ts
session: ({ session, token }) => {
  if (session.user) {
    session.user.role = (token.role as string) ?? "reviewer";
    session.user.permissions = (token.permissions as string[]) ?? [];
  }
  // Propagate so the client can signOut()/redirect on a dead refresh.
  (session as { error?: string }).error = token.error as string | undefined;
  return session;
},
```

`session.error === "RefreshAccessTokenError"` is consumed client-side (e.g. in `ShellChrome` or a small `useSessionGuard`) by calling `signOut({ redirectTo: "/login" })`. The access/refresh tokens are deliberately **not** copied onto `session` — only `role`, `permissions`, and `error` reach the client; the tokens stay on the server-only JWT.

> **Where to put the refresh logic split:** `refreshPipelineToken` must stay Node-only (it does `fetch` + reads `PIPELINE_API_URL`), so it lives in `lib/auth/refresh.ts` and is imported by `config.ts` (the Node config), **never** by `edge-config.ts`. The edge config keeps only the session/authorized pass-throughs (it must not import the refresh module — same ARCH-1 constraint that today keeps bcrypt/providers out of the edge bundle, see `edge-config.ts:5-9`).

### 4.3 Forwarding the per-user token (`lib/api/client.ts`, `lib/api/route-helpers.ts`)

Today `pipelineRequest` (`lib/api/client.ts:38-42`) hard-codes `Authorization: Bearer ${config.token}` from a single static `PipelineConfig.token`, and `route-helpers.ts:24-27` builds that config from `env.PIPELINE_TOKEN`. The cutover makes the token **per-request, per-user**:

- **`lib/api/client.ts`** — keep the `Authorization: Bearer ${config.token}` line exactly as-is (`client.ts:39`); the change is purely *what fills `config.token`*. The client stays the single place the header is attached and the single place response bodies are zod-parsed and stripped of pipeline internals (`client.ts:53-77`).
- **`lib/api/route-helpers.ts`** — resolve the access token from the session per request and pass it into `pipelineConfig`. Replace the module-level `pipelineConfig` (lines 24–27) with a per-call builder that reads the token off the session, and have `currentSession()` (lines 29–33) additionally return the access token:

```ts
// route-helpers.ts
async function currentSession(): Promise<
  (GuardSession & { accessToken: string }) | null
> {
  const session = await auth();
  const email = session?.user?.email;
  const accessToken = session?.accessToken; // server-only field on the JWT-backed session
  return email && accessToken ? { email, accessToken, role: session.user?.role } : null;
}

function configFor(accessToken: string) {
  return { baseUrl: env.PIPELINE_API_URL, token: accessToken };
}
```

Then `handleRead`, `handleAuthed`, `pipelineGet`, and `handleWrite` all take the token from the resolved session and call `pipelineRequest(configFor(session.accessToken), …)`. Because `accessToken` is needed server-side here, `auth()` must expose it on the session **for server reads only** — add it to the session in the `session` callback but mark it server-only in the type augmentation (see §4.5); it never ships to the client because the panel's own `/api/*` proxy responses (built by `handleRead`/`handleWrite`) never echo it.

- **Delete `PIPELINE_TOKEN`** from `lib/env/server.ts:21` (the `PIPELINE_TOKEN: z.string().min(1)` line) and stop reading `env.PIPELINE_TOKEN` in `route-helpers.ts:26`. With the token now per-user, there is no static credential to misconfigure.

> **Missing-token case:** if a proxy call resolves a session with no `accessToken` (e.g. a JWT minted under the old allow-list flow during rollout, or a dead refresh), `currentSession()` returns `null` and the existing `401 unauthorized` path in `handleRead`/`handleWrite` (`route-helpers.ts:72-74`, `95-97`) fires — the client sees the same 401 it already handles, prompting re-login.

### 4.4 Simplifying `lib/api/guard.ts` (CSRF stays; allow-list trust goes)

`guard.ts` runs three checks before a write (its doc at lines 5–17): (1) same-origin CSRF, (2) session exists, (3) **allow-list re-check**, plus it derives `approver` from the session. With the pipeline now (a) deriving `approver` from the verified token claims and (b) authorizing per-permission, checks (3) and the panel's `approver` injection are **no longer the trust source** — the pipeline ignores any body `approver` and enforces permissions cryptographically.

- **Keep `isSameOrigin`** (`guard.ts:25-32`) unchanged — CSRF protection is a panel-side concern the pipeline can't see (the pipeline only sees the panel's server-to-server call, not the browser origin). This is the one genuinely load-bearing check left in `guard.ts`.
- **Simplify `assertWrite`** (`guard.ts:61-95`): drop the `isAllowed` parameter and the membership throw (lines 90–92), and drop `withSessionApprover`'s injection requirement. The check collapses to: same-origin **and** a session exists. Keep returning the body, but **stop force-injecting `approver`** — the pipeline derives it from the token and ignores the body field (the plan's "accept-but-ignore for one release, then remove"). It's harmless to leave `withSessionApprover` stripping any client `approver` as belt-and-suspenders, but it is no longer a security control.

```ts
// guard.ts — post-cutover
export function assertWrite({ req, session, rawBody, allowedOrigin }: {
  req: Request;
  session: GuardSession | null;
  rawBody: unknown;
  allowedOrigin: string;
}): GuardResult {
  if (!isSameOrigin(req, allowedOrigin)) {
    throw new PipelineError("unauthorized", "Cross-origin request rejected.", 403);
  }
  if (!session?.email) {
    throw new PipelineError("unauthorized", "Authentication required.", 401);
  }
  // approver is no longer the panel's trust boundary — the pipeline derives it
  // from the verified token. Body passes through (client `approver` ignored).
  return { approver: session.email, body: stripApprover(rawBody) };
}
```

Correspondingly, `route-helpers.ts:147-153` drops the `isAllowed: (email) => findReviewer(allowlist, email) !== undefined` argument, and `handleAuthed`/`handleRead` (lines 72, 95) drop the `findReviewer(allowlist, …)` membership clause — a resolved session with an access token **is** the authorization; the pipeline rejects an under-permissioned token with its own 401/403, which `errorResponse` (`route-helpers.ts:45-51`) already maps via `kindForStatus`.

**Why this is safe:** the panel can no longer be the authority because JWT sessions aren't server-revocable (the old `guard.ts:73-76` comment), which is exactly why the membership re-check existed. Now revocation is the pipeline's `token_version` lever — a disabled user's next pipeline call 401s regardless of what the panel thinks. The panel's residual job is CSRF + "is there a logged-in session at all," and forwarding the token.

### 4.5 Page gating off `session.user.permissions`

Update the type augmentation and consume permissions in server components and the edge middleware.

- **`types/next-auth.d.ts`** — extend the augmentation (currently only `role`, lines 4–19) to add `permissions` to `Session["user"]` and the JWT, plus the server-only token fields and the session `error`:

```ts
declare module "next-auth" {
  interface Session {
    user: { role?: string; permissions?: string[]; name?: string | null;
            email?: string | null; image?: string | null };
    accessToken?: string; // server-only; never rendered client-side
    error?: string;
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    role?: string; permissions?: string[];
    accessToken?: string; refreshToken?: string;
    accessTokenExpires?: number; error?: string;
  }
}
```

- **Server components / route handlers** gate on `session.user.permissions` via a small helper:

```ts
// lib/auth/permissions.ts
import { auth } from "@/lib/auth/config";
import { redirect } from "next/navigation";

export async function requirePermission(perm: string) {
  const session = await auth();
  if (!session?.user?.permissions?.includes(perm)) redirect("/access-denied");
  return session;
}
```

```tsx
// app/(shell)/settings/page.tsx — example gate
import { requirePermission } from "@/lib/auth/permissions";
export default async function SettingsPage() {
  await requirePermission("settings:write"); // pipeline still enforces; this is UX
  return <SettingsScreen />;
}
```

This mirrors how server components already call `auth()` today (`app/(shell)/layout.tsx:23`, `app/(shell)/page.tsx:12`, `app/(shell)/profile/page.tsx:13`, `app/(shell)/queue/[id]/page.tsx:16`) — same source, now reading `permissions` instead of just `role`.

- **Edge middleware (`middleware.ts`)** stays a coarse gate. The `authorized` callback (`edge-config.ts:27`, `middleware.ts:18`) keeps gating on "a session exists" — that's all the edge runtime needs and can do without a JWKS fetch (the plan: page-gating is cosmetic; the pipeline is the real gate). Optionally, a per-route permission map can 307 to `/access-denied` for an obviously-missing permission, but it must read off the Auth.js session token only (no pipeline call on the edge hot path). Keep the matcher (`middleware.ts:33-37`) as-is.

- **Sidebar visibility** — `components/shell/sidebar.tsx` can filter `NAV_GROUPS` (`components/shell/nav-config.ts`) by permission so a reviewer never sees a link to a screen they can't open (e.g. hide **Roles** unless `permissions.includes("roles:manage")`). Pass `permissions` down from `ShellLayout` (`app/(shell)/layout.tsx:26`, alongside the existing `role` resolution) into `ShellChrome`/`Sidebar`. Cosmetic — the gate is the page's `requirePermission` and the pipeline.

### 4.6 New "Users & Roles" screens + proxy routes

Mirror the **exact** Team pattern: a `page.tsx` under `app/(shell)/…` rendering a client screen component under `components/…`, a `hooks/use-*.ts` data hook over the panel's own `/api/*` (`fetchJson` + zod), and a `app/api/…/route.ts` proxy using `handleRead`/`handleWrite`. The Team screen is the template end-to-end: `app/(shell)/team/page.tsx` → `components/team/team-screen.tsx` → `hooks/use-team.ts` → `app/api/team/route.ts` (which is just `handleRead(pipelineTeamListSchema, "/api/team", pipelineToTeam)` + `handleWrite({...})`).

**Proxy routes** (each ~10 lines, copied from `app/api/team/route.ts`):

```ts
// app/api/users/route.ts
import { handleRead, handleWrite } from "@/lib/api/route-helpers";
import { pipelineUserListSchema, pipelineUserResultSchema } from "@/lib/api/pipeline-schema";
import { pipelineToUsers, userResultFromPipeline } from "@/lib/api/pipeline-adapter";

export async function GET() {
  return handleRead(pipelineUserListSchema, "/api/users", pipelineToUsers);
}
export async function POST(req: Request) {
  return handleWrite({
    req, schema: pipelineUserResultSchema, transform: userResultFromPipeline,
    path: "/api/users", method: "POST", // body: {name,email,role,initialPassword}; pipeline ProvisionUserUseCase
  });
}
```

```ts
// app/api/roles/route.ts — GET list + POST create + PATCH (update permissions)
export async function GET()  { return handleRead(pipelineRoleListSchema, "/api/roles", pipelineToRoles); }
export async function POST(req: Request) {
  return handleWrite({ req, schema: pipelineRoleResultSchema, path: "/api/roles", method: "POST" });
}
export async function PATCH(req: Request) {
  return handleWrite({ req, schema: pipelineRoleResultSchema, path: "/api/roles", method: "PATCH" });
}
```

```ts
// app/api/permissions/route.ts — read-only catalog (drives the Roles editor checkboxes)
export async function GET() {
  return handleRead(pipelinePermissionListSchema, "/api/permissions");
}
```

(For `DELETE /api/roles/:id` and `PATCH /api/users/:id`, add dynamic segments `app/api/roles/[id]/route.ts` / `app/api/users/[id]/route.ts`; `handleWrite` already supports `PATCH`, and a `DELETE` can reuse the same guard+`pipelineRequest` shape — extend `pipelineRequest`'s `method` union in `client.ts:23` to include `"DELETE"`.)

**Schemas** go in `lib/api/schemas.ts` (panel domain) + `lib/api/pipeline-schema.ts` (raw pipeline) + adapters in `lib/api/pipeline-adapter.ts`, exactly like `teamMemberSchema`/`teamListSchema`/`inviteResultSchema` (`schemas.ts:483-505`) and `pipelineToTeam`/`inviteResultFromPipeline`. The `User` panel shape extends today's `TeamMember` (`schemas.ts:483-491`) with `role_id`/`auth_provider`/`status: "active"|"invited"|"disabled"` — the pipeline's `users` table after the `team_members`→`users` consolidation.

**Screens:**
- `app/(shell)/users/page.tsx` → `components/users/users-screen.tsx` + a `create-user-drawer.tsx` (mirror `components/team/invite-drawer.tsx`). Same `PanelState` loading/empty/error states, `Card`/`Badge`/`Avatar` design-system primitives, `useUsers()`/`useCreateUser()` hooks (mirror `hooks/use-team.ts`). The create drawer collects name/email/**role select**/**initial password** (admin-set, per the plan) and `useCreateUser` POSTs to `/api/users` (the `approver` is no longer sent — the pipeline derives it).
- `app/(shell)/roles/page.tsx` → `components/roles/roles-screen.tsx`: lists roles, and a role editor toggles a permission matrix sourced from `GET /api/permissions`, saving via `PATCH /api/roles`. `is_system` roles (`admin`/`reviewer`) render their permission checkboxes read-only (the pipeline returns `RoleInUseError`/guards `is_system`; surface that as a disabled state + a `RoleInUseError`-mapped toast).

**Team screen → Users.** The cleanest move is to **rename Team to Users**: point `app/(shell)/team/page.tsx`'s render at the new `UsersScreen` (or rename the route to `/users` and 308-redirect `/team`), and update `NAV_GROUPS` (`components/shell/nav-config.ts:45-51`) — the **Team** group becomes:

```ts
{
  label: "Team",
  items: [
    { label: "Users", href: "/users" },
    { label: "Roles & permissions", href: "/roles" },
    { label: "Settings", href: "/settings" },
  ],
},
```

The existing `/team` "Team & users" entry (`nav-config.ts:48`) collapses into **Users** since users now *are* the login-capable accounts (the old screen's "allow-list mirror" caveat at `team-screen.tsx:83-85` and `schemas.ts:480` is obsolete — drop that copy). Gate the **Roles** nav item + page on `roles:manage` and **Users** on `team:manage` (§4.5).

### 4.7 Google SSO — OIDC-ready, shipped disabled

Leave the `Google(...)` provider in `lib/auth/config.ts:51-58` exactly as-is: it is **already** gated on `env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET`, so with those env vars unset (the shipped state) the provider simply isn't registered. The only change is the **`signIn` callback** (`lib/auth/config.ts:71-75`), which today calls `findReviewer(allowlist, email)`. Replace the allow-list lookup with a pipeline "known active user?" check so a Google sign-in is admitted only for a provisioned, active account:

```ts
signIn: async ({ user, account }) => {
  const email = user.email;
  if (!email) return false;
  if (account?.provider === "credentials") return true; // already vetted by /auth/login
  // Google (and any future OIDC): admit only a known, active pipeline user.
  return pipelineUserIsActive(email); // GET /api/users?email=… (or a lightweight lookup), server-only
};
```

Account-linking on `google_sub` and actually enabling the provider are **P6** (deferred) — this phase only swaps the gate from the retired allow-list to the pipeline so the wiring is correct the day the creds are set. Since the provider is unregistered without creds, the `pipelineUserIsActive` path is dormant in the shipped build.

### 4.8 Retire the legacy allow-list + static-token plumbing

Once §4.1–4.7 land, delete the dead paths (the plan's P5, done here at cutover):
- **`lib/auth/allowlist.ts`** and its test — remove the module, `parseAllowlist`, `findReviewer`, `isAllowed`, `verifyCredentials`, `DUMMY_HASH`, `ReviewerRole`. All imports are now gone: `config.ts:10`, `route-helpers.ts:7,22,72,95,152`, `authorize.ts:5`.
- **`lib/auth/authorize.ts`** — `authorizeCredentials` is no longer called (the Credentials `authorize` now calls `pipelineLogin`). Keep only `clientIpFromHeaders` (still used for the rate-limiter key) and `credentialsInput`; either move those two into `config.ts`/a small `lib/auth/request.ts` and delete the rest, or trim the file to just those exports. Drop `RateLimitedError` if the `authorize` path returns `null` on lockout instead of throwing.
- **`REVIEWER_ALLOWLIST`** — remove from `lib/env/server.ts:25-27` and from the env files / README / `.env.example`. Update the `server.ts` header comment (lines 12–15) that still references "the reviewer allow-list."
- **`PIPELINE_TOKEN`** — remove from `lib/env/server.ts:21` (§4.3).
- **`bcryptjs`** — remove `bcryptjs` (`package.json:33`) and `@types/bcryptjs` (`package.json:56`); the panel no longer hashes/compares passwords (the pipeline owns Argon2id). Confirm no other importer with `grep -rn bcrypt` before removing.
- **`lib/api/guard.ts`** — keep the file (CSRF), but its allow-list-driven `isAllowed` plumbing is gone (§4.4). Update the doc comment (lines 5–17) and the `assertWrite`/`withSessionApprover` SEC-1 notes, which currently describe allow-list re-checks that no longer apply.
- **`lib/api/route-helpers.ts`** — drop the `allowlist` module state (lines 7, 22) and the `findReviewer` clauses (lines 72, 95, 152).

### 4.9 Tests + docs (panel side)

Per the panel's `testing.md` and the plan's panel-test list:
- **Unit:** the `jwt`-callback refresh logic with a mocked `/auth/refresh` (fresh-token short-circuit, successful rotation swaps the pair + permissions, a 401 sets `token.error`); the simplified `guard.ts` (same-origin pass/fail, session-exists pass/fail — no more allow-list branch); `pipelineLogin`/`parseLoginResponse` boundary parsing (200 ok, 401/403/429 → null, malformed body rejected). These extend the existing `lib/api/guard.test.ts`, `lib/api/client.test.ts`.
- **Per-page permission gating:** `requirePermission` redirects to `/access-denied` when the permission is absent; renders when present.
- **Hooks/proxy:** `use-users`/`use-roles` mirror `hooks/use-team.test.tsx` (loading/error/success, mutation invalidation); the new `app/api/users|roles|permissions/route.ts` are covered like the team route (read transform, write guard, error mapping).
- **Playwright e2e:** login → land on a permitted screen → blocked on a screen whose permission the role lacks → create a user in **Users** and confirm that user can sign in.
- **Docs:** add ACR entries in `docs/API_CHANGE_REQUESTS.md` (auth cutover, Users/Roles screens, proxy-token change); rewrite `.claude/rules/auth.md` to "pipeline is the IdP; per-user JWT forwarded by the proxy; allow-list retired; CSRF stays panel-side"; update `README.md` + `.env.example` to drop `REVIEWER_ALLOWLIST`/`PIPELINE_TOKEN` and document the (unchanged) `PIPELINE_API_URL` + Google creds. Run `pnpm verify` (lint + typecheck + test) green before merge.

### 4.10 Cutover sequencing (within the dual-accept window)

Because Pipeline P2 keeps accepting the old static token alongside JWTs, this phase can ship without a flag-day: deploy the panel with §4.1–4.6 (Credentials→`/auth/login`, per-user token forwarding, refresh) **after** the real reviewers are seeded with admin-set passwords (Pipeline P3). Existing browser sessions minted under the allow-list have no `accessToken` on their JWT, so their next proxy call resolves `currentSession()` → `null` → 401 → re-login through `/auth/login` (clean, no stuck sessions). Only after the panel is fully on per-user tokens does Pipeline P5 remove the static-token acceptance — at which point the panel's `PIPELINE_TOKEN` is already gone (§4.3/§4.8), so there's nothing to break.

---

**Section file written to** `/Users/burakuzunboy/.claude/plans/replicated-sprouting-quail-agent-a381409d612443260.md` (the only file I created; nothing else was modified — plan mode). The markdown above is the deliverable for the handoff doc.

---

## Token & key design, Security, Testing, Rollout & Docs

> This section assumes the domain/migration/use-case/HTTP slices defined earlier in this handoff. It pins the exact crypto, threat-closure, test matrix, and cutover order so the implementing session cannot ship a half-verified or insecure auth system. Every concrete file/anchor below was checked against the live repos.

### 1. Token & key design

#### 1.1 Access-token claim shape (exact)

The access token is an **ES256-signed JWS compact string**, minted by `JoseTokenIssuer.signAccess(...)` (the `TokenIssuer` port adapter) and built by the pure domain rule `buildAccessClaims(user, perms, now, ttl)` in `src/domain/auth/`. The claim set is **fixed and closed** — the verifier rejects on missing required claims (§2), so do not add optional claims silently.

```jsonc
{
  "iss": "dealroute-pipeline",        // AUTH_JWT_ISS — pinned + verified
  "aud": "dealroute-panel",           // AUTH_JWT_AUD — pinned + verified
  "sub": "<user uuid>",               // users.id (NOT email — email can be display-renamed later)
  "email": "reviewer@dealroute.de",   // becomes `approver` server-side; never read from the body
  "name": "Reviewer Name",            // display only
  "role": "reviewer",                 // role NAME, display/debug only — NOT an authorization input
  "perms": ["candidate:approve", "candidate:reject", "candidate:edit", "manual-capture:write", "evidence:read"],
  "token_version": 3,                 // per-user counter — immediate-revoke lever
  "perm_version": 12,                 // global counter — perms-staleness lever
  "iat": 1750000000,
  "exp": 1750000900,                  // iat + ACCESS_TTL (~15 min)
  "jti": "<random uuid>"              // unique per mint (audit / future denylist hook)
}
```

Authorization is decided **only** from `perms` (a `Set` built in the per-request guard) — never from `role`. `role` is carried for the panel's cosmetic page-gating and for logs/audit readability. This is the OCP win: a new role is a row in `roles` + `role_permissions`, never a code branch on a role name.

**TTLs (config-driven, in `src/config/config.ts`, mirrored in `.env.example`):**
- `AUTH_ACCESS_TTL_SECONDS` — default `900` (15 min). Keep it short; theft window = TTL (§2 access-token theft).
- `AUTH_REFRESH_TTL_SECONDS` — default `604800` (7 days), rotated on every use.

Validate both with the same zod-coerced-int pattern the config file already uses for the other numeric knobs (see `reviewApi`/budget parsing in `config.ts`); reject `≤ 0`.

#### 1.2 Why ES256 (not HS256/RS256)

- **ES256 over HS256** — HS256 is symmetric: the verifier needs the *same* secret used to sign, so the secret would have to live wherever verification happens. ES256 lets us publish only the **public** key at JWKS while the private key stays in pipeline env. It is also the structural defense against the classic alg-confusion attack (§2).
- **ES256 over RS256** — smaller keys + signatures (token size matters, perms are inlined), same asymmetric property.

The library is **`jose`** (already the plan's locked choice): `importJWK`/`importPKCS8` for the private key, `jwtVerify(token, keyOrJWKS, { algorithms: ['ES256'], issuer, audience })` for verification, `createLocalJWKSet` / a hand-built `{ keys: [...] }` for the JWKS endpoint. **Never** call `jwtVerify` without the explicit `algorithms` allow-list.

#### 1.3 Where private keys live

- **Private signing key:** pipeline **env only** — `AUTH_JWT_PRIVATE_KEY` (a JWK JSON string or PKCS8 PEM) + `AUTH_JWT_KID` (the key id stamped into the JWS protected header). On Fly this is a `fly secrets set` value, never committed; `.env.example` ships the key **blank** with a comment, exactly like the existing `REVIEW_API_TOKEN=` line at `.env.example:106`.
- **Public key:** derived from the private key at startup and served read-only at `GET /.well-known/jwks.json` (public, `Cache-Control: max-age=300`).
- **Startup guard:** `serve.ts` must emit a warning when no signing key is configured, mirroring the existing no-token warning at `src/adapters/cli/commands/serve.ts:63-67`. During the dual-accept window (§4) an unset key is a warning (legacy static token still works); **after P5 cutover an unset key must be a hard fail** (`serve` exits non-zero) — there is no fallback once the static token is retired.

#### 1.4 JWKS rotation overlap procedure (current + next kid)

Rotation must never invalidate already-issued, still-valid access tokens. Use a **two-slot, publish-before-sign** procedure:

1. **Steady state:** sign with `AUTH_JWT_PRIVATE_KEY` (kid = `AUTH_JWT_KID`). JWKS serves `[current]`.
2. **Stage the next key:** set `AUTH_JWT_PRIVATE_KEY_NEXT` + `AUTH_JWT_KID_NEXT`. Deploy. JWKS now serves **both** kids (`[current, next]`), but signing still uses `current`. Verifiers (only the pipeline itself) can already accept `next`.
3. **Promote:** swap `NEXT` → primary (the new key becomes `AUTH_JWT_PRIVATE_KEY`/`KID`; demote the old key into the `NEXT` slot, or drop it from signing while keeping it in JWKS). Deploy. New tokens are signed with the new kid; old-kid tokens still verify because the old public key is still in JWKS.
4. **Retire:** after one full **access-token TTL** (15 min, the max lifetime of any old-kid token) plus a safety margin, remove the old key entirely. JWKS serves `[new]` only.

`JoseTokenIssuer` must therefore: stamp `kid` into every signed header, expose **both** public keys from `jwks()`, select the verification key **by the token's `kid`** (the standard `jose` JWKS resolver does this), and pick the signing key from the configured primary slot. Document this 4-step runbook in `docs/KNOWN_ISSUES.md` (the plan lists "key-rotation runbook" as a required KNOWN_ISSUES entry).

#### 1.5 Why the panel does NOT crypto-verify the pipeline token

The panel is a **forwarder, not a verifier**. It holds the user's access + refresh tokens server-side (on the Auth.js JWT) and attaches `Authorization: Bearer <accessToken>` when proxying to the pipeline — the same place `lib/api/route-helpers.ts:26` and `lib/api/client.ts:39` attach the static `PIPELINE_TOKEN` today. The **pipeline is the single source of authorization truth** (it owns the user table, `token_version`, and `perm_version`). If the panel also verified, it would need the JWKS on its hot path and would risk drifting from the pipeline's revocation state (a token the panel thinks is valid could already be `token_version`-revoked pipeline-side). So:
- The panel performs **no JWKS fetch and no signature check**.
- The panel's *own* gate is the **Auth.js HS256 session cookie** (`httpOnly`, `secure`, `sameSite:lax`) — used only for **cosmetic** page-gating (`session.user.permissions.includes('settings:write')`). It is explicitly **not** the security boundary; the pipeline re-checks every request.

#### 1.6 Cookie / CSRF posture

- **Pipeline:** stateless, no cookies. It reads identity from the `Authorization: Bearer` header only. CORS already pins the panel origin and advertises `Authorization` (see `applyCors` in `review-api.ts` and the existing `ADMIN_CORS_ORIGIN`); per-user bearers work over it unchanged. The new `AuthApi` (`/auth/*` + JWKS) must apply the **same** pinned-origin CORS block for the browser-initiated `/auth/login` and `/auth/refresh` calls.
- **Panel:** the session cookie is `httpOnly` (no JS access → XSS can't read it), `secure`, `sameSite:lax`. The **access/refresh tokens never reach the browser** — they live on the server-side Auth.js JWT and are attached only in the server proxy. CSRF on the panel's own `app/api/*` write handlers stays the existing **same-origin check** in `lib/api/guard.ts` (`isSameOrigin` — exact `Origin` match, `Sec-Fetch-Site: same-origin` fallback, never `same-site`). That check **stays** even though the pipeline now authorizes — it is defense-in-depth against a cross-site POST riding the session cookie.

---

### 2. Security review — threats → closure

Each row names the **precise mechanism** that closes the threat and where it lives. The first two are today's live gaps.

| Threat | Closure mechanism (precise) |
|---|---|
| **Algorithm confusion** (attacker submits `alg:none`, or an HS256 token signed with the public key as the HMAC secret) | `JoseTokenIssuer.verifyAccess` calls `jose.jwtVerify` with an explicit `algorithms: ['ES256']` allow-list. `alg:none` and `alg:HS256` are rejected before any key use. The private key is an EC key object — it is **never** passed anywhere as an HMAC secret, so the "public key as HMAC secret" variant has no code path. |
| **Body-supplied `approver`/`role` privilege escalation** (today's headline gap — `approver` is free-text the pipeline trusts verbatim; the `/api/*` body `role` could be forged) | The per-request guard (replacing `authorized()` at `review-api.ts:605`) returns `{ userId, email, role, perms, tokenVersion }` from the **verified claims**, and every use-case call derives `approver = claims.email`. The body `approver`/`role` are **accept-but-ignore for one release, then removed**. Authorization reads `perms` from the token, never any body field. The panel mirror (`withSessionApprover` in `guard.ts`) already strips the client `approver`; the pipeline is now the enforcing layer. |
| **Removed / disabled user still holds a live access token** | Two levers, both checked on **every** pipeline request: (a) the guard loads the user and rejects `status !== 'active'` (401/403); (b) `claims.token_version !== user.token_version` ⇒ 401. `setUserStatus`/`changePassword`/`logoutEverywhere` **bump `token_version`**, so the next request with the stale token 401s within seconds — no waiting for the 15-min TTL. |
| **Refresh-token theft / replay / reuse** | Refresh tokens are opaque ≥32-byte random, **stored only as SHA-256 hash** (a DB leak yields nothing usable). Every use **rotates** (old revoked, new issued under the same `family_id`). Presenting a **rotated-out** family member ⇒ `RefreshReuseDetectedError`: the **whole family is revoked** + 401 (so a thief who races the legit user gets the family killed). `RefreshUseCase` also re-checks `status` + `token_version`, so a disabled user can't refresh back into access. The pure `validateRefreshRotation(stored, presented, now)` → `ok|reuse|expired` is unit-tested for all four states. |
| **Access-token theft** | 15-min TTL caps the window. The token is **server-side only** — it never enters the browser, so XSS/`localStorage` exfiltration has nothing to steal panel-side. Combined with `token_version`, a known-compromised user can be killed immediately rather than waiting out the TTL. |
| **Panel-compromise blast radius** | The static all-powerful `PIPELINE_TOKEN` (whose leak = permanent full write) is **retired** (`lib/env/server.ts:20`). A compromised panel holds only **short-lived, per-user, individually-revocable** tokens scoped to that user's permissions — not an org-wide skeleton key. |
| **Timing side-channel / user enumeration** | `AuthenticateUseCase` **always runs the Argon2id hasher**, even for an unknown email (verify against a constant `DUMMY_HASH`), so "unknown email" and "wrong password" take the same time. Both return the **generic** `InvalidCredentialsError` (401) — never "no such user" vs "bad password". Token/string compares use `timingSafeEqual` (the existing `safeEqual` at `review-api.ts:792` is the precedent). The lockout response must not reveal whether the email exists (return the generic 429 the same way for known/unknown). |
| **Brute force** | **Argon2id** (`@node-rs/argon2`, memory-hard) makes each guess expensive. Pipeline-side **lockout**: `lockoutPolicy(failed, lastFailedAt, now)` (clock-injected, pure, unit-tested at the window boundaries) backed by `failed_login_count` + `locked_until` on the user row → `AccountLockedError` (429). The panel keeps its existing per-email/per-IP sliding-window `RateLimiter` (`lib/auth/rate-limit.ts`) as a first line of defense-in-depth. |

---

### 3. Testing matrix (mapped to the three repo tiers)

Per `.claude/rules/testing.md`: **every feature gets unit + integration; every parsed boundary gets adversarial unit tests; a new external edge gets a live smoke.** This is auth — the worst-case bug is a *wrong* identity authorizing a write — so the trust-path coverage below is mandatory, not optional. Tests are **co-located with their source** (e.g. `src/adapters/http/review-api.test.ts`, `src/domain/...test.ts`), matching the repo convention.

#### 3.1 Tier 1 — Unit (`npm test`, hermetic, fakes only)

**Pure domain rules in `src/domain/auth/` (table-driven):**
- `permissionsForRole` — `admin` → full set; `reviewer` → its seeded subset; unknown role → empty/throws.
- `hasPermission(perms, required)` — present / absent / empty-set.
- `lockoutPolicy(failed, lastFailedAt, now)` — below threshold → allow; at/over threshold within the window → lock; **window-boundary cases** (just inside vs just outside the cooldown, using a `FixedClock` time) → unlock.
- `buildAccessClaims(user, perms, now, ttl)` — exact claim shape (§1.1), `exp === iat + ttl`, `perms` reflects the resolved set, `token_version`/`perm_version` copied through, a fresh `jti` each call.
- `validateRefreshRotation(stored, presented, now)` — `ok` (current, unexpired), `expired` (past `expires_at`), `reuse` (presented hash matches a revoked/replaced row), and the reuse-vs-expired precedence.
- **Permission-enum exhaustiveness** — a test that fails to compile / fails an assertion if a `Permission` enum member has no route mapping in the route→permission registry (catches "added a permission, forgot to gate an endpoint").

**Use-cases against fakes (`test/fakes/in-memory-db.ts` + `FixedClock`):** `AuthenticateUseCase` (happy path; unknown email still runs hasher; disabled → `AccountDisabledError`; locked → `AccountLockedError`; bad password → generic `InvalidCredentialsError`), `RefreshUseCase` (rotate happy path; reuse → family revoked; expired; disabled-mid-session), `LogoutUseCase` (`logout` revokes family; `logoutEverywhere` bumps `token_version`), `ProvisionUserUseCase` (creates login-capable account; unknown role → `RoleNotFoundError`), `ManageRolesUseCase` (`is_system` guard → can't delete `admin`/`reviewer`; `RoleInUseError`; any role-permission mutation bumps global `perm_version`; `setUserStatus`/`changePassword` bump `token_version`).

#### 3.2 Tier 1 — Adapter **port-contract suites** (both implementations pass; lives next to `test/contracts/`)

The repo already ships shared contract suites (`test/contracts/database-contract.ts`, `evidence-store-contract.ts`, etc.) that every adapter + the in-memory fake must pass (LSP rule). Add:
- **`PasswordHasher` contract** — `Argon2idHasher` **and** a fake/bcrypt impl pass: `hash` then `verify(correct)` → true; `verify(tampered)` → false; `verify` against `DUMMY_HASH` for an unknown user → false but **runs** (timing parity); `needsRehash` flips when params change.
- **`TokenIssuer` contract** — `JoseTokenIssuer` (+ any fake): `signAccess` → `verifyAccess` round-trips and returns the exact claims; **wrong alg rejected**, **expired rejected** (advance the injected clock), **bad `iss`/`aud` rejected**, **tampered signature rejected**; `jwks()` returns the documented `{ keys: [...] }` shape with the right `kid`(s); during rotation, a token signed with the previous kid still verifies.
- **New repo contracts** — `UserRepository`, `RoleRepository`, `RolePermissionRepository`, `RefreshTokenRepository` (`issue/findByHash/rotate/revokeFamily/revokeAllForUser/deleteExpired`): **`InMemoryDb` ≡ Postgres** — identical observable behaviour, run in the integration tier for Postgres. Cover the timestamptz-vs-ISO row-mapper gotcha the repo has hit before.

#### 3.3 Tier 1 — **Adversarial boundary tests** (the non-negotiable set)

These are HTTP-level tests against the new `AuthApi` + the JWT guard, matching the depth of `src/adapters/http/review-api.test.ts` (which already asserts 413-oversize, 400-malformed-JSON, 400-no-approver, 401-no-bearer, non-UUID→404). Reuse the same `readBody`/413/`MALFORMED`/`safeEqual` helpers — they already exist in `review-api.ts`.

**`POST /auth/login`:**
- malformed JSON body → **400** (`MALFORMED`).
- oversized body → **413** (`MAX_BODY_BYTES`, drain-not-reset).
- missing/empty email or password → 400 (zod).
- **timing parity**: unknown email vs known-email-wrong-password both → generic **401 `InvalidCredentialsError`** with an indistinguishable body; assert the hasher ran in both (the constant-time guarantee — assert behaviorally, not on wall-clock).
- disabled user → **403**; locked user → **429**; Nth failed attempt within the window → **429** lockout.

**`POST /auth/refresh`:**
- malformed → 400; oversized → 413; missing token → 400.
- **reuse** (present a rotated-out token) → **401** + the whole family revoked (assert a subsequent valid-looking refresh from that family also 401s).
- expired refresh → 401.
- refresh by a user disabled after issuance → 401.

**The JWT verifier / per-request guard (against gated `/api/*`):**
- `alg:none` token → 401.
- `alg:HS256` token signed with the public key → 401 (alg confusion).
- tampered payload (valid structure, broken signature) → 401.
- expired access token (advance `FixedClock`) → 401.
- missing required claim (`sub`/`token_version`/`perm_version`/`email`) → 401.
- wrong `iss` or wrong `aud` → 401.
- valid token but `token_version` < user's current → 401 (**revocation**).
- valid token, sufficient perms → 200; valid token, **missing the named permission** → **403** (`PermissionDeniedError`).
- **body `approver`/`role` ignored** — POST a write with `{"approver":"attacker@evil","role":"admin", ...}`; assert the recorded `approver` equals the **token email**, and that the forged `role` does not grant anything.
- a GET `/api/*` read **without any token** → 401 (reads now require auth — a behavior change from today's open GETs; explicitly test it).
- `/v1/*` read **without a token** → still **200** (public feed untouched — regression guard).

#### 3.4 Tier 2 — Integration (`npm run test:integration`, real `Container` + real Postgres, injected `FixedClock`)

Add `test/integration/auth.integration.test.ts` using the existing `harness.ts` (`makeContainer(overrides, env)` + `applyMigrations` + `resetDb`). Add `users`, `roles`, `permissions`, `role_permissions`, `refresh_tokens` to the `resetDb()` `TRUNCATE` list (it currently truncates `team_members, alert_events, settings, ...`). The **one mandatory end-to-end scenario** (drives the real wiring a fake can't):

1. Provision a user with the `reviewer` role + an admin-set password.
2. `POST /auth/login` → 200 with access + refresh; assert the access token verifies and carries the seeded perms.
3. Gated write (e.g. `POST /api/candidates/:id/approve`) **with** the access token → 200; assert the persisted `reviews.approver` row equals the **token email**, not anything from the body.
4. `setUserStatus(disabled)` (bumps `token_version`).
5. The **same** previously-valid access token → next gated call **401** (immediate revoke, no TTL wait).
6. `POST /auth/refresh` with that user's refresh token **after disable** → **401** (status re-check).
7. A second integration case for the **migration round-trip**: confirm `0019` consolidated `team_members`→`users` with ids/emails preserved (so historical `reviews.approver` keyed on email still resolves) and the seeded `roles`/`permissions`/`role_permissions` read back through the new repos + schema parse.

A second case: a role-permission edit bumps `perm_version`; a token minted before the edit triggers the guard's **re-resolve-from-DB** path on the `perm_version` mismatch, and the newly-removed permission is denied **before** the token expires.

#### 3.5 Tier 3 — Live smoke (`npm run test:live`, gated by `RUN_LIVE_TESTS=1`, scheduled — never a PR gate)

Against `https://dealroute-api.fly.dev` post-deploy: login with a seeded reviewer → tokens; `GET /.well-known/jwks.json` reachable + well-formed; one gated write with the token → 200; the same write **without** a token → 401. (Self-skips when the gate env is unset, like the existing live tier.)

#### 3.6 Panel tests (`pnpm verify` — Vitest + RTL + Playwright, MSW-mocked pipeline)

Per the panel's `.claude/rules/testing.md` + `auth.md`:
- **`jwt`-callback refresh logic** (unit, MSW-mock `/auth/refresh`): `now < accessTokenExpires` → returns unchanged; expired → calls refresh + swaps the pair; refresh failure → sets `token.error` so `session` forces re-login. (The current callback is the stub at `lib/auth/config.ts:77`.)
- **Credentials authorize** now calls `POST {PIPELINE_API_URL}/auth/login` (MSW): 200 → tokens stashed; 401 → rejected; lockout surfaced.
- **`guard.ts`** — `isSameOrigin` (exact-origin / `Sec-Fetch-Site` fallback, reject `same-site`) and the simplified session-exists check; the **forged-`approver`-in-body is overridden** assertion (`withSessionApprover`) stays.
- **Server-secret leak test** (the panel's standing rule): assert no access/refresh token, `AUTH_SECRET`, or Google secret ever reaches a client chunk — and that **`PIPELINE_TOKEN`/`REVIEWER_ALLOWLIST` are gone** from `lib/env/server.ts`.
- **Per-page permission gating** — a screen whose required permission the role lacks is blocked.
- **Playwright e2e** — sign in → land on a permitted screen → get blocked on a screen the role can't access → create a user in the new Users screen and confirm that user can sign in and is restricted pipeline-side by role.

---

### 4. Rollout — phased dual-accept cutover (each phase leaves the system working)

Execute **in order**; do not merge a later phase before the earlier one is green. The dual-accept window (P2–P5) is what lets you flip without a flag-day outage.

- **P1 — Pipeline identity foundation (no HTTP change).** Land `src/domain/auth/`, migrations `0019–0023` (consolidate `team_members`→`users` by `ALTER TABLE` rename + add columns; seed `admin`/`reviewer`, permissions, `role_permissions`, the `perm_version` row), `PasswordHasher`/`TokenIssuer` ports + adapters, the four new repos on **both** `InMemoryDb` and Postgres, wired in `container.ts`. Tier-1 unit + port-contract + the integration migration round-trip. *System is unchanged externally — the old static-token API still serves; the new tables just exist.*
- **P2 — Auth endpoints + dual-accept guard.** Add `AuthApi` (`POST /auth/login|refresh|logout` + `GET /.well-known/jwks.json`), prefix-dispatched in `serve.ts` alongside the existing total `/v1/*` vs `/api/*` split (`serve.ts:44-49`). Add the per-request JWT guard **alongside** the legacy static-token check: a request is authorized if it presents **either** a valid bearer JWT **or** the legacy `REVIEW_API_TOKEN`. When a JWT is present, derive `approver` from the token; otherwise keep today's body `approver`. Reads stay open in P2 (don't break the panel before its cutover). Integration tests for both auth paths. *Old panel + new clients both work.*
- **P3 — Users & Roles admin API + seed reviewers.** Ship `/api/users`, `/api/roles`, `/api/permissions`, `/api/permissions/me`, backed by `ProvisionUserUseCase`/`ManageRolesUseCase` (gated `team:manage` / `roles:manage`). Seed the ~5 real reviewers with **admin-set initial passwords**. *Accounts now exist and can authenticate, but the panel still uses the static token until P4.*
- **P4 — Panel cutover.** `lib/auth/config.ts` Credentials → `POST /auth/login`; stash `accessToken`/`refreshToken`/`accessTokenExpires`/`permissions` on the Auth.js JWT; rotation in the `jwt` callback; `lib/api/route-helpers.ts` + `client.ts` forward `Authorization: Bearer <session.accessToken>` instead of `PIPELINE_TOKEN`; new Users/Roles screens + proxy routes; page-gating from `session.user.permissions`. *Panel now drives the per-user path; the pipeline still dual-accepts, so a rollback to the static token is possible.*
- **P5 — Retire legacy + harden + gate reads.** Remove the static-token branch from the guard (JWT-only); make `GET /api/*` **require a valid token**; stop accepting the body `approver` (remove the accept-but-ignore); make an unset `AUTH_JWT_PRIVATE_KEY` a hard startup fail; delete `REVIEW_API_TOKEN`/`reviewApi.authToken`, and panel-side delete `PIPELINE_TOKEN`/`REVIEWER_ALLOWLIST`/`lib/auth/allowlist.ts`/`bcryptjs`. **Regenerate OpenAPI + Postman.** *This is the irreversible step — only land it after P4 is verified live.*
- **P6 (deferred, not blocking):** enable Google SSO (account-linking on `google_sub`); email invite-link onboarding (needs an email sender). Built OIDC-ready in P1–P4, shipped disabled (creds unset).

### 4.1 Exact doc updates each repo's conventions require

**Pipeline (per `.claude/rules/api-and-openapi.md` — spec changes in the same commit):**
- `docs/api/openapi.yaml` — add `POST /auth/login|refresh|logout`, `GET /.well-known/jwks.json`, `GET/POST/PATCH/DELETE /api/users|roles`, `GET /api/permissions`, `GET /api/permissions/me`. Mark the gated `/api/*` set with `security: [{ bearerAuth: [] }]` and a per-route required-permission note; flip the previously-open `GET /api/*` reads to `bearerAuth`. Keep `/v1/*` as `security: []`. Mirror the **real** zod bounds + status codes (401 unauth, 403 forbidden/disabled, 409, 413, 400, 429 lockout). **Do not leak** internal fields — JWKS exposes only public-key material; `/api/permissions` enumerates permission *keys*, not user data.
- Run **`npm run api:lint`** then **`npm run api:postman`**, and commit `openapi.yaml` + the regenerated `dealroute.postman_collection.json` together. CI's `npm run api:check` (structure-only drift gate) **fails** if a new endpoint isn't regenerated.
- `docs/KNOWN_ISSUES.md` — append entries (use the file's template block): the **dual-accept window** (and its P5 removal trigger), **"reads now require auth"** behavior change, the **key-rotation runbook** (§1.4), and the deferred `refresh_tokens` `deleteExpired` cron.
- `docs/DealRoute_Status_and_Roadmap.md` — record the **IdP / permission-RBAC milestone** in §2 (built) and clear any related §3 (left) item.
- `.env.example` — add `AUTH_JWT_PRIVATE_KEY=`, `AUTH_JWT_KID=`, `AUTH_JWT_ISS=`, `AUTH_JWT_AUD=`, `AUTH_ACCESS_TTL_SECONDS=`, `AUTH_REFRESH_TTL_SECONDS=`, Argon2 params, login rate-limit knobs (all blank/commented like the existing `REVIEW_API_TOKEN=` at line 106); **remove `REVIEW_API_TOKEN`** at P5.

**Panel (per its `docs/API_CHANGE_REQUESTS.md` + `auth.md` conventions):**
- `docs/API_CHANGE_REQUESTS.md` — add ACR entries (next free `ACR-n`, with the file's Status/Category fields): auth cutover (Credentials → pipeline `/auth/login`), the new Users/Roles screens + their pipeline endpoints, and the proxy-token change (per-user bearer replacing `PIPELINE_TOKEN`). Mark them 🟢 `DONE` when wired.
- `.claude/rules/auth.md` — rewrite the "Decisions (locked)" block to: **pipeline is the IdP; per-user JWT verified pipeline-side; allow-list retired; `approver` derived from the verified token.** The existing wording (Auth.js allow-list with bcrypt-hashed passwords in env, "no true server-side revoke") is now **superseded** and must not be left contradicting the new model.
- `README.md` + `.env.example` — drop `REVIEWER_ALLOWLIST` and `PIPELINE_TOKEN`; document the new login flow (panel forwards a per-user token) and that user/role management lives in the panel UI.

---

### 5. Open risks / confirm-before-shipping

1. **`reviews.approver` key continuity.** Migration `0019` must preserve user **ids and emails** so historical `reviews.approver` (email-keyed) still resolves. Confirm no reviewer email changes during the consolidation, and that the seeded reviewers use the **same emails** as the existing `team_members` rows.
2. **Disabling the last admin.** `ManageRolesUseCase.setUserStatus` / role reassignment must refuse to disable or de-admin the **last active `admin`** (lockout-of-everyone risk) — add this guard + a test even though the plan doesn't spell it out.
3. **Clock skew on `exp`.** Confirm the pipeline and any caller agree on time; `jose` allows a small `clockTolerance` — decide whether to set one (a few seconds) to avoid spurious 401s, and pin it in config.
4. **JWKS cache vs rotation.** The 5-min JWKS `max-age` interacts with the rotation overlap window (§1.4): the old key must remain in JWKS for **at least** the access-TTL **plus** the JWKS cache horizon before retirement. Confirm the retirement delay covers both.
5. **Argon2 params on Fly.** `@node-rs/argon2` ships prebuilt binaries (no node-gyp), but confirm the chosen memory/time cost runs within Fly's memory limit and doesn't make login latency unacceptable; bcrypt is the documented fallback if the binary is unavailable.
6. **Refresh-token table growth.** No `deleteExpired` cron lands until P6/deferred — confirm the table won't grow unbounded before then (low volume at ~5 users, but log it).
7. **CORS on `/auth/*`.** Login/refresh are browser-initiated from the panel origin; confirm the new `AuthApi` applies the **same pinned-origin** CORS as `ReviewApi` (not `*`, since these carry credentials).
8. **Panel refresh-callback concurrency.** Two in-flight panel requests can both see an expired access token and both call `/auth/refresh`; with rotation, the second could trip **reuse detection** and kill the family. Confirm the `jwt`-callback serializes refresh (single-flight) so normal concurrency doesn't self-revoke.

### 6. Definition of done (per phase)

- **P1:** Migrations `0019–0023` apply cleanly forward; `team_members`→`users` consolidation preserves ids/emails; both `PasswordHasher` and `TokenIssuer` adapters pass their shared port contracts; the four repos pass `InMemoryDb ≡ Postgres`; all Tier-1 pure rules unit-tested; `npm run check` + `npm run test:integration` green. **No HTTP behavior changed.**
- **P2:** `AuthApi` dispatched in `serve.ts`; JWKS reachable; the guard dual-accepts JWT **or** legacy token; when a JWT is present `approver` comes from the token; the full §3.3 adversarial suite + the §3.4 integration scenario green; old panel still works against the running server.
- **P3:** `ProvisionUserUseCase`/`ManageRolesUseCase` shipped + gated; the ~5 reviewers seeded with admin-set passwords and able to `POST /auth/login`; `is_system`/`RoleInUseError`/last-admin guards tested; OpenAPI updated + `api:check` green.
- **P4:** Panel Credentials → `/auth/login`; per-user bearer forwarded; `jwt`-callback rotation (single-flight) tested; Users/Roles screens + page-gating live; `pnpm verify` + the Playwright login→permitted→blocked→provision-and-restrict e2e green; **no server secret in any client chunk**.
- **P5:** Static token + allow-list + `PIPELINE_TOKEN` **deleted** from both repos; `GET /api/*` requires a token; body `approver` no longer read; unset signing key is a hard startup fail; OpenAPI + Postman regenerated and committed; `auth.md`/`README`/`.env.example`/`KNOWN_ISSUES`/Status doc updated; full CI (lint + typecheck + unit + integration + `api:check`) green on both repos.
- **Cross-repo verification (gate for "done"):** local `serve` → `POST /auth/login` returns tokens; JWKS returns the key; a gated write with the token succeeds and records the token-derived `approver`; the same write **without** a token → 401; disabling the user → next call → 401. Live (post-deploy): `npm run test:live` against `dealroute-api.fly.dev` passes.

---

**Files referenced for this section (absolute paths):**
- Pipeline: `/Users/burakuzunboy/Claude/Projects/Discover Delas/LLM-Pipeline/.claude/worktrees/elegant-lamarr-c3f85f/src/adapters/http/review-api.ts` (`authorized()` ~L605, `readBody`/`MAX_BODY_BYTES`/`MALFORMED`/`TOO_LARGE`/`safeEqual` L755-797, `applyCors`), `.../src/adapters/cli/commands/serve.ts` (dispatch L44-49, warning L63-67), `.../src/config/config.ts` (`reviewApi.authToken` L152-164, L280-283), `.../src/adapters/http/review-api.test.ts` (adversarial patterns), `.../test/integration/harness.ts` (`makeContainer`/`resetDb`), `.../test/fakes/{fakes.ts (FixedClock), in-memory-db.ts}`, `.../test/contracts/{database,evidence-store}-contract.ts`, `.../docs/KNOWN_ISSUES.md` (entry template), `.../.env.example` (L106 `REVIEW_API_TOKEN=`).
- Panel: `/Users/burakuzunboy/Claude/Projects/Discover Delas/Admin-Panel/lib/api/guard.ts` (`isSameOrigin`/`withSessionApprover`), `.../lib/api/route-helpers.ts` (token attach L26), `.../lib/api/client.ts` (L39), `.../lib/auth/config.ts` (`jwt` callback L77), `.../lib/env/server.ts` (`PIPELINE_TOKEN` L20, `REVIEWER_ALLOWLIST` L27), `.../.claude/rules/auth.md`, `.../.claude/rules/testing.md`, `.../docs/API_CHANGE_REQUESTS.md`.

---

## Appendix — Reviewer critique (raw)

_The completeness/accuracy critic's full notes. The most important items are already distilled into the "Reviewer corrections" block near the top; this is the unabridged version for reference._

## Reviewer notes (apply before/while implementing)

### CORRECTIONS (factually wrong about the repos)

- **§2.x route + helper line anchors are mostly wrong** — *Pipeline Phases 2 & 3*. The draft cites `review-api.ts:618` for `mapErrors`, `:792` for `safeEqual`, `:605` for `authorized()`, and the route blocks at `:262–307`, `:350`, `:362`, `:381`, `:405`, `:428`, `:454`, `:471`, `:486`, `:512`, `:525`, `:551`, `:567`. Verified actuals: `authorized()` **L605** ✓, `safeEqual` **L792** ✓, but `applyCors` is **L594** (not a range; `access-control-allow-methods` is set at **L597** and currently lists only `GET, POST, PATCH, OPTIONS` — the draft says to *add* `DELETE`, correct, but cite L597 not "as `ReviewApi.applyCors` already does it"), and **there is no `private mapErrors`/`function mapErrors` match in the file at all** — grep found neither `private mapErrors` nor `function mapErrors`, yet `this.mapErrors(` is called ~15×. The cold session must locate the real `mapErrors` definition (it exists but the grep pattern/line is unconfirmed — flag: the draft's "L618" is unverified and the file is 890 lines). **Fix:** replace every hard line number with a grep anchor ("search for `private authorized`", "search for `function safeEqual`", "the `mapErrors` method") — the draft itself already warns anchors drift, so honor that.

- **`serve.ts` line ranges are all wrong** — *§2.6 + §4*. The draft cites dispatch at `serve.ts:43–56` / `:44–49`, constructor at `:20–37`, warning at `:60–68` / `:63–67`. The file is **only 84 lines**. Verified: `reviewApi` ctor starts **L20**, `authToken: config.reviewApi.authToken` **L34**, `corsAllowOrigin` **L35**, dispatch `path.startsWith('/v1/')` **L47**, `reviewApi.handle` **L49**, warning block **L63–66** (text: `'WARNING: no REVIEW_API_TOKEN set — approve/reject are unauthenticated...'`). The "L44-49" and "L60-68" ranges are close-ish but "L43-56" overshoots the dispatch. **Fix:** the dispatch snippet in §2.6 is structurally right; just correct the anchors (ctor L20, dispatch L45-49, warning L63-66).

- **Panel `config.ts` line refs are off by a few** — *§4.1, §4.7*. File is **87 lines**. Verified: `jwt` callback **L77** (draft says `:77-83` — the body is L77-84, ok-ish), `signIn` **L71** (draft `:71-75` ok), Google provider **L50-58** (draft says `:51-58` — starts at the `if (env.AUTH_GOOGLE_ID...)` at **L50**), `loginLimiter` **L25**, `authorizeCredentials` call **L41-45** (draft says authorize is at `:33-46` — the `authorize:` fn is L33-46 ✓). Minor, but the `jwt` callback today is `jwt: ({ token }) =>` (no `user` arg destructured) — the draft's replacement adds `user`, correct, but note the **current** signature so the diff is clean.

- **`edge-config.ts` anchors slightly off** — *§4.2, §4.5*. Session callback is **L30-34** (draft says `:30-35`); the bcrypt/providers-exclusion comment is **L6-7** (draft says `:5-9`); `authorized: ({ auth }) => Boolean(auth)` is **L28** (draft says `edge-config.ts:27`). The substance (edge config must not import the refresh module) is correct and well-grounded — the comment at L6-7 literally forbids importing bcrypt/providers/allow-list.

- **`route-helpers.ts` line refs** — *§4.3, §4.4, §4.8*. Verified: `import { findReviewer, parseAllowlist }` **L7**, `const allowlist = parseAllowlist(...)` **L22**, `pipelineConfig` **L24-28** (token at **L26**), `currentSession` **L29**, `pipelineGet` uses `pipelineConfig` **L60**, `handleAuthed` allow-list check **L71-72**, `handleRead` check **L94-95** (draft says `:72-74`/`95-97` for the 401 path and `:72`/`:95` for the membership clause — the membership `!findReviewer(allowlist, session.email)` is at **L72 and L95**, and the `isAllowed:` arg is at **L152** ✓). Mostly right; tighten "L72-74/95-97".

- **`types/next-auth.d.ts` augmentation range** — *§4.5*. The draft says "currently only `role`, lines 4–19". Verified the augmentation block is **L4-20** and yes only `role` is declared. Fine, but note the file *imports* `"next-auth"` at L1 and the draft's rewrite drops that import — keep it.

### GAPS (a cold implementer would be blocked or misled)

- **`mapErrors` location is unconfirmed — the single most-reused helper in both new sections.** Both the AuthApi extraction (§2.2) and the error table (§2.3) depend on extending `mapErrors`, but neither the draft nor my checks pinned its definition. **Fix:** add a step "locate `mapErrors` (grep `mapErrors` in `review-api.ts`; it is a method, ~L600s) and confirm its `instanceof DomainError` switch shape before extending."

- **Panel `package.json` bcrypt versions are exact but the removal step omits a lockfile/regen note** — *§4.8*. Confirmed `bcryptjs@2.4.3` (**L33**) + `@types/bcryptjs@2.4.6` (**L56**). Removing them requires a `pnpm install` to update `pnpm-lock.yaml`; the draft says "remove from package.json" but not "regenerate the lockfile + confirm `pnpm verify`." Add it.

- **The pipeline `DUMMY_HASH` (§2.1) and the panel `DUMMY_HASH` (allowlist.ts:60) are different things** — worth a one-line disambiguation so the cold session doesn't try to reuse the panel's. The panel's `DUMMY_HASH` is a *bcrypt* constant being deleted in §4.8; the pipeline's is a *new Argon2id* constant. The draft never says this; a reader skimming both sections could conflate them.

- **`nav-config.ts` Team group** — *§4.6*. Verified the **Team** group is at **L46** with structure `{ label, items: [...] }` and the file's existing groups (Home/Review/Catalog/Sources/Monitoring/Governance) end before it. The draft's proposed replacement adds a "Settings" item to the Team group — confirm Settings isn't already nav'd elsewhere (grep showed no `/settings` href in the dumped lines, so it may currently live *inside* Team or be missing). **Fix:** the cold session must read the full `nav-config.ts` Team block (L46-51) before editing, since the draft asserts a 3-item replacement without showing the current items.

- **No OpenAPI/Postman step in the P1 exit (correct) but §2.9 omits the `bearerAuth` securityScheme definition.** The draft says "mark every gated op `security: [{ bearerAuth: [] }]`" but never says to *define* the `bearerAuth` scheme under `components.securitySchemes` if it doesn't already exist. The current API uses a static token — verify whether `openapi.yaml` already declares `bearerAuth`; if not, defining it is a required prerequisite step.

- **`team_members` is referenced by `resetDb()` TRUNCATE in the integration harness** — *§3.4 covers adding the new tables but the rename in `0019` means the harness's existing `TRUNCATE team_members` line breaks after migration.* The draft says "add `users`... to the TRUNCATE list" but must also say "**rename** `team_members`→`users` in the existing TRUNCATE, not just append," or post-0019 integration setup fails on a missing table.

- **Last-admin lockout guard (§5 risk #2) is flagged but not assigned to a phase or test.** It's correctly called out as plan-silent, but the draft leaves it as a "confirm" rather than wiring it into `ManageRolesUseCase.setUserStatus`/`assignRoleToUser` with a unit test. For a cold session this should be a concrete to-do in §2.1/Phase 3, not just an open risk.

### RISKS the draft under-states

- **The dual-accept "synthesize a full-permission identity for the legacy token" (§2.4) is a privilege-escalation footgun.** A legacy-token identity with `email: 'legacy-token@system'` and ALL permissions will write `reviews.approver = 'legacy-token@system'` for any write during the window — polluting the audit trail with a non-user actor on real review decisions. The draft frames this as harmless; flag that it dirties `reviews.approver` (the email-keyed audit identity the whole consolidation is built to preserve) and should be time-boxed hard + excluded from `review_count` derivation.

- **`perm_version` storage in the `settings` table conflicts with the panel's `GET /api/settings` view.** §2.1/0023 stores `perm_version` as a `settings` row. But `SettingsUseCase.buildSettingsView`/the settings catalog enumerates settings rows for the panel UI — an un-cataloged `perm_version` row could surface in the settings screen or trip the catalog's override logic. The draft offers `auth_meta` as an alternative but defaults to `settings` without noting this collision. Recommend `auth_meta` to avoid it, or explicitly exclude `perm_version` from the settings catalog/view.

- **Refresh-callback single-flight (§5 risk #8) is the most likely production breakage and is only an "open risk."** With 5 reviewers and a SPA firing parallel `/api/*` calls, the documented Auth.js `jwt`-callback rotation *will* double-refresh and trip family-reuse-revocation on normal use, logging everyone out. This deserves to be a **required implementation detail in §4.2**, not a confirm-later — name the mitigation (a module-level in-flight promise keyed by refresh-token, or accept a short reuse grace window).

- **ES256 key format ambiguity (`AUTH_JWT_PRIVATE_KEY` "JWK or PEM").** §1.3/§2.7 accept both, but `jose` needs different import calls (`importJWK` vs `importPKCS8`) and the startup parse must branch. The draft says "parse it once at startup, fail loudly" without specifying the format-detection — an unhandled format mismatch is a silent auth-disabled state. Pin one format or specify the detection.
