import { z } from 'zod';
import { Permission } from './permission.js';

/**
 * The access-token claim set (Auth/IAM). An ES256-signed JWS carries EXACTLY these
 * claims — the set is fixed and closed, so the verifier (`TokenIssuer.verifyAccess`)
 * rejects a token missing a required claim. Built by the pure `buildAccessClaims`
 * rule and signed by `JoseTokenIssuer`; never assembled ad-hoc anywhere else.
 *
 * Authorization is decided ONLY from `perms` (a `Set` in the per-request guard),
 * never from `role` — `role` is carried for the panel's cosmetic page-gating and
 * for audit/log readability. The OCP win: a new role is data, never a code branch.
 *
 * NOTE: no `password_hash` or any secret ever appears here (it isn't even on the
 * `User` entity `buildAccessClaims` reads from). `sub` is the user UUID, not the
 * email — the email can be display-renamed without invalidating tokens.
 */
export const AccessClaimsSchema = z.object({
  iss: z.string().min(1), // pinned + verified (config AUTH_JWT_ISS)
  aud: z.string().min(1), // pinned + verified (config AUTH_JWT_AUD)
  sub: z.string().uuid(), // users.id
  email: z.string().email(), // becomes `approver` server-side; never from the body
  name: z.string(), // display only
  role: z.string().min(1), // role NAME — display/debug only, NOT an authz input
  perms: z.array(Permission), // the resolved permission set (sorted, deduped)
  token_version: z.number().int().nonnegative(), // per-user immediate-revoke lever
  perm_version: z.number().int().nonnegative(), // global perms-staleness lever
  iat: z.number().int().nonnegative(), // issued-at (epoch seconds)
  exp: z.number().int().nonnegative(), // iat + access TTL (epoch seconds)
  jti: z.string().min(1), // unique per mint (audit / future denylist hook)
});
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;
