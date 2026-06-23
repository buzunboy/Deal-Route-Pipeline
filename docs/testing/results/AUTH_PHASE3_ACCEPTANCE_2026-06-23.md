# Auth/IAM Phase 3 — Acceptance Proof (live, against a running server)

_A **real** against-a-running-`serve` run (NOT a unit test), recorded with the repo's
live-test convention (a sibling to `docs/testing/results/AUTH_PHASE2_ACCEPTANCE_2026-06-23.md`
— the **auth-flow** variant). Phase 3 adds the **Users & Roles admin API**, so this proof
records the **end-to-end self-service loop**: an admin creates a user with a role; that role
is enforced cross-call; a new role + reassignment changes what the user can do; a disable
kills the session immediately; and the last-admin guard refuses an unrecoverable lockout._

The point of this run: prove the four things Phase 3 exists to guarantee —
**one admin action provisions a login-capable account** (step 2→3), **that role is enforced
on the pipeline cross-call** (step 5), **runtime RBAC edits take effect** (steps 6→7), and
**the org can never lock itself out of its own IAM** (step 9, the last-admin guard). Steps
**2 → 3 → 5** are the headline; step **9** is the safety net. If any of those fails, the
phase is not done.

---

## 0. Run metadata

| Field | Value |
|---|---|
| Date (UTC) | 2026-06-23 ~17:50 |
| Git branch / base commit | `claude/trusting-williamson-857616` (off `claude/auth-phase2` @ `69b934a`) |
| Run kind | full-into-throwaway-DB (`dealroute_p3_acc`, local Postgres 16) — migrations `0019–0023` applied |
| Server | real `serve` on `http://localhost:3066` (AuthApi + ReviewApi + PublicApi, one port) |
| JWT signing | real **ES256** key (PKCS8 PEM) via `AUTH_JWT_PRIVATE_KEY` + `AUTH_JWT_KID=acc-key-1` |
| Password hash | real **Argon2id** (`@node-rs/argon2`, OWASP-floor params) |
| Access TTL / legacy token | 900s / none configured (pure per-user-JWT mode, no dual-accept token) |
| LLM / Fetcher | `stub` / default (no extraction — candidates seeded directly via the real `Container`) |
| Writes / publishes | 1 deal approved→published (into the throwaway DB), by design |
| Secrets handling | the ES256 key (`/tmp/p3_es256.pem`) was generated for the run and **deleted after** |

> Seed: `seed-user --email ada@dealroute.de --name "Admin Ada" --role admin --password …`
> → `Created user ada@dealroute.de (admin) — can now POST /auth/login.` (one admin, no hand-SQL.)

---

## 1. The acceptance flow (steps 1–9 + the self-service password step 10)

| # | Step | Expected | Observed | ✅ |
|---|---|---|---|:--:|
| 1 | admin `POST /auth/login` (correct pw) | 200 + access token carrying the **admin** bundle | 200; perms include `team:manage`, `roles:manage` + the full set (16 keys) | ✅ |
| **2** | **admin `POST /api/users` → create reviewer "sam" (role=reviewer + initial pw)** | **201** | **201 `{"id":"9dc8399c-…","email":"sam@dealroute.de","role":"reviewer"}`** | ✅ |
| **3** | **`POST /auth/login` AS sam** | **200 + a token carrying the reviewer bundle** | **200; perms = `candidate:{read,approve,reject,edit}`, `manual-capture:write`, `evidence:read`, `sources:read`, `settings:read`, `team:read` (no `team:manage`)** | ✅ |
| 4 | sam approves a candidate; body `approver:"forged@evil.com"` | 200, and `reviews.approver` == sam's TOKEN email | 200; deal `published`, `verified_by:"sam@dealroute.de"` (NOT the forged body value) | ✅ |
| **5** | **sam hits a `team:manage` route (`POST /api/users`)** | **403 (role enforced cross-call)** | **403** | ✅ |
| 6 | admin creates role **"auditor"** (`candidate:read`+`sources:read`), then `PATCH /api/users/:sam role=auditor` | 201 then 200; the role-create **bumps `perm_version`** | role create → 201; `perm_version` 0→**1** on the role create; reassign → 200 | ✅ |
| **7** | **sam's session reflects the new perms → can read, can't approve** | **the new role is enforced** | **the reassignment bumped sam's `token_version`, so the OLD token is immediately dead (401); sam re-logs-in → auditor bundle (`candidate:read`,`sources:read`); `GET /api/candidates` → 200; approve → 403** | ✅ |
| 8 | admin disables sam (`PATCH status=disabled`) → sam's still-unexpired token | 200 then **401** (immediate revoke) | disable → 200; sam's next call → **401** | ✅ |
| **9** | **last-admin guard: admin disables / demotes the ONLY admin** | **refused (409) with a clear error** | **disable → 409; demote → 409; body: `"Refused: this is the last active user who can \"roles:manage\"; disabling or demoting them would lock everyone out of administration."`; the admin stays `active`** | ✅ |
| **10** | **self-service password change: sam (a reviewer, NO `team:manage`) `PATCH /api/profile`** | **correct current pw → 200; old token then 401; new pw logs in, old pw 401; wrong current → 401; `newPassword` alone → 400** | **wrong current → 401 `{"error":"invalid email or password"}`; `newPassword` w/o `currentPassword` → 400; correct current → 200 `{"updated":true,"name":"Sam","password_changed":true}`; old access token → 401; login new pw → 200, old pw → 401** | ✅ |

**Bonus (catalogue + JWKS + no-token), same run:**

| Check | Expected | Observed | ✅ |
|---|---|---|:--:|
| `GET /api/permissions/me` as sam | the caller's own perms (any authed) | 200 `{email:"sam@…", role:"reviewer", permissions:[…]}` | ✅ |
| `GET /.well-known/jwks.json` | the ES256 **public** key only | 200 `{kty:EC, crv:P-256, alg:ES256, kid:acc-key-1}`; **no private `d`** | ✅ |
| `GET /api/users` with no token | 401 (reads require auth) | 401 | ✅ |

---

## 2. The reason-for-existing proofs (verbatim observations)

1. **One admin action → a login-capable account, role enforced cross-call (steps 2→3→5).**
   `POST /api/users` (as admin) returned `201` and minted `sam@dealroute.de` with role
   `reviewer`. Sam then logged in (`POST /auth/login` → `200`) and received a token carrying
   exactly the reviewer permission bundle — *and was immediately restricted*: hitting the
   `team:manage`-gated `POST /api/users` returned `403`. No env edit, no redeploy, no second
   identity store: the pipeline alone provisioned + enforced the account.

2. **Identity is never forged (step 4).** Sam approved a candidate with a deliberately
   forged `approver:"forged@evil.com"` in the body. The published deal recorded
   `verified_by:"sam@dealroute.de"` and the reviews row's `approver` is sam's verified token
   email — the body value was ignored. The headline Phase-2 fix still holds through the
   Phase-3 surface.

3. **Runtime RBAC takes effect, with a strong revoke (steps 6→7).** Creating the `auditor`
   role bumped the global `perm_version` (0→1). Reassigning sam to `auditor` bumped sam's
   `token_version`, which **immediately killed sam's existing access token** (`401`) — a
   *stronger* guarantee than waiting out the token window. Sam re-authenticated and the fresh
   token carried the `auditor` bundle: `GET /api/candidates` → `200` (can read), approve →
   `403` (auditor lacks `candidate:approve`). The role edit was honoured end-to-end.

   > Design note: a **user role reassignment** bumps that user's `token_version` (immediate
   > per-user revoke); the global `perm_version` is bumped by **role-permission edits**
   > (create/update-permissions/delete a role) so a permission change is honoured before a
   > live token expires. Both levers were exercised here.

4. **Immediate disable (step 8).** Disabling sam (`PATCH status=disabled`) returned `200`;
   sam's still-unexpired token 401'd on the next request, and (verified in the integration
   suite) the user's refresh tokens were revoked so they can't refresh back in.

5. **The org can't lock itself out (step 9 — the safety net).** With Ada the only admin, both
   `PATCH status=disabled` and `PATCH role=reviewer` on Ada returned `409` with a clear,
   actionable message; Ada stayed `active`. The last-admin lockout guard protects the last
   active holder of `roles:manage`/`team:manage`.

---

## 3. Trust-invariant checklist

| Invariant | Status |
|---|:--:|
| `approver`/`actor` is token-derived on every admin write (never the body) | ✅ |
| A reviewer cannot create a user / grant themselves a privileged role (→ 403) | ✅ (steps 5; unit + integration cover self-escalation via PATCH role too) |
| All `/api/users`/`/api/roles`/`/api/permissions` writes are permission-gated | ✅ |
| `GET /api/permissions/me` is any-authed; the catalogue is `roles:manage` | ✅ |
| Provisioned password is Argon2id-hashed; never stored/returned plain | ✅ |
| A role-permission edit bumps the global `perm_version` | ✅ |
| A user security change (role/status/password) bumps that user's `token_version` | ✅ |
| Disable revokes refresh tokens + immediately 401s the access token | ✅ |
| `is_system` roles can't be deleted / re-scoped (unit + integration) | ✅ |
| **Last-admin lockout guard refuses disabling/demoting the only admin (409)** | ✅ |
| **Self-service password change verifies the CURRENT password (401 on mismatch) + bumps token_version** | ✅ |
| Self-password is self-keyed by the token — a body actor/email can't target another user | ✅ |
| The public `/v1/*` allow-list gained no auth/internal field | ✅ (untouched) |

---

## 4. How to reproduce

```sh
# 1. throwaway DB + ES256 key
createdb dealroute_p3_acc
node -e "const{generateKeyPair,exportPKCS8}=require('jose');generateKeyPair('ES256',{extractable:true}).then(async({privateKey})=>require('fs').writeFileSync('/tmp/p3.pem',await exportPKCS8(privateKey)))"

export DATABASE_URL="postgres://$(whoami)@localhost:5432/dealroute_p3_acc"
export AUTH_JWT_PRIVATE_KEY="$(cat /tmp/p3.pem)" AUTH_JWT_KID=acc-key-1 AUTH_ACCESS_TTL_SECONDS=900 LLM_PROVIDER=stub REVIEW_API_PORT=3066

# 2. migrate + seed ONE admin
npx drizzle-kit migrate
node dist/adapters/cli/main.js seed-user --email ada@dealroute.de --name "Admin Ada" --role admin --password admin-password-1

# 3. boot + run the curl loop (login → create sam → login-as → approve → 403 → auditor → disable → last-admin 409)
node dist/adapters/cli/main.js serve   # then the curls in §1

# 4. cleanup
dropdb dealroute_p3_acc && rm /tmp/p3.pem
```

_Result: **all 9 steps green** (headline 2/3/5 + safety-net 9 included). Phase 3 is done._

---

## 5. Post-review hardening (code-reviewer follow-up, same day)

A `code-reviewer` pass after this live run found one **Blocker** + two should-fixes, all fixed
and covered by the (green) test suite — they are additive to the 9 steps above (none changed a
step's outcome):

- **Blocker — `updateRole` was a third lockout lever.** The last-admin guard covered disable
  + demote but **not** a role permission-set edit. Since a custom role may grant
  `roles:manage`/`team:manage`, `PATCH /api/roles/:name` removing those keys could strip the
  last admin org-wide. **Fixed:** new pure rule `wouldRoleEditRemoveLastHolder` +
  `assertRoleEditNotLastAdmin`, called from `updateRole`; unit + HTTP + reasoning verified that
  all three levers (disable / demote / role-perm-edit) now 409. (See KNOWN_ISSUES "Custom roles
  MAY grant the critical admin permissions … the last-admin guard covers all three lockout levers".)
- **Should-fix — `PATCH /api/users/:id` could half-apply** a multi-field patch (e.g. status
  applied, then password 400s). **Fixed:** a single `ManageRolesUseCase.updateUser` validates
  everything up front (role exists, password policy, last-admin) before any write, single-bumps
  `token_version`, and revokes refreshes only on a committed disable. Unit + HTTP test for
  `{status:disabled, password:short}` → 400, nothing applied.
- **Defense-in-depth — `RoleRepository.update`** now refuses to RENAME a system role at the
  adapter boundary (both adapters; contract-tested), so the comment no longer overstates the guard.

All gates re-run green after the fixes: `npm run check` (1093 unit), `npm run test:integration`
(146, incl. the Postgres contract suite), `npm run api:check`.

---

## 6. Follow-up requirement — self-service "change my own password" (added same day)

A non-admin reviewer previously had **no way to change their own password** (the admin
`changePassword` is gated `team:manage`; `PATCH /api/profile` was name-only). Closed:

- **`ManageRolesUseCase.changeOwnPassword({ actor, currentPassword, newPassword })`** — keyed
  on the token-derived `actor`; **verifies the current password** against the stored hash
  (constant-time, generic 401 on mismatch — the authorization is the proof, not a permission),
  runs the same `validatePasswordPolicy`, re-hashes, and bumps `token_version` (logs out other
  sessions).
- **`PATCH /api/profile`** now accepts optional `{ currentPassword, newPassword }` alongside
  `name`; self-only (token-keyed — no `:id`, so it can't target another user), password fields
  all-or-nothing (a `newPassword` without `currentPassword` is a 400). OpenAPI + Postman updated
  in the same change.
- Live-proven (step 10 above) + unit + HTTP + integration. Re-run green: `npm run check`
  (**1102** unit), `npm run test:integration` (**147**), `npm run api:check`.
