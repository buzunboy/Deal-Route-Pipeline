/**
 * A real Argon2id encoded hash of a throwaway value (Auth/IAM). `AuthenticateUseCase`
 * verifies a submitted password against THIS when the email is unknown, so an
 * unknown-email login costs the same wall-clock time as a real verify — defeating
 * user-enumeration via timing. The PasswordHasher port does the verify; the domain
 * never imports the Argon2 SDK (layering), so this is a pre-computed literal.
 *
 * The cost params are baked into the encoded string (`m=19456,t=2,p=1`) — the OWASP
 * floor and the config defaults (`AUTH_ARGON2_*`). If those defaults change, the cost
 * here drifts from a live hash, so a unit test asserts this is a verifiable Argon2id
 * string and that verifying a wrong password against it returns false. The plaintext
 * is intentionally never exported — only the cost of verifying against it matters, and
 * a real login can never match it (no user is provisioned with this secret).
 *
 * Distinct from the Admin-Panel's `DUMMY_HASH` (a bcrypt constant being retired) —
 * this one is Argon2id and lives pipeline-side.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$2gPDOsx6LZyskXr17TvfXQ$7FJi5lmSD2pesfmU1QC8a2ZpHx3Cf2bwGKhdO+Rcfa8';
