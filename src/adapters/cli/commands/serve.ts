import { createServer, type ServerResponse } from 'node:http';
import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { ReviewApi } from '../../http/review-api.js';
import { PublicApi } from '../../http/public-api.js';
import { AuthApi } from '../../http/auth-api.js';
import { REVIEW_TEST_PAGE } from '../../http/test-page.js';

/**
 * `serve` — start the HTTP surface on one port: the PUBLIC read API (`/v1/*`,
 * unauthenticated, read-only over published deals), the UNAUTHENTICATED auth API
 * (`/auth/*` + the public JWKS — the IdP), and the gated admin review API (`/api/*` +
 * the test page). Dispatch is by path prefix and TOTAL: `/auth/*` + `/.well-known/jwks.json`
 * go to `AuthApi` (most specific first), then `/v1/*` to `PublicApi`, else `ReviewApi`. So
 * a public/auth path can never fall through to an admin/state-changing route. Runs until
 * interrupted.
 */
export async function serve(config: Config): Promise<void> {
  // Auth/IAM Phase 5: per-user JWT is the ONLY auth path — the legacy static REVIEW_API_TOKEN
  // and the open trusted-network mode are retired. With no signing key the IdP can't verify
  // tokens, which would silently lock the entire `/api/*` surface (every request 401s) with
  // no fallback — so fail LOUDLY at startup instead. This is the documented post-cutover
  // posture (was a soft warning during the dual-accept window).
  if (config.auth.jwt.privateKey === undefined) {
    console.error(
      'FATAL: AUTH_JWT_PRIVATE_KEY is not set. Per-user JWT is the only auth path since the ' +
        'Phase-5 cutover (the legacy REVIEW_API_TOKEN was retired). Configure an ES256 signing ' +
        'key (see .env.example) before starting `serve`.',
    );
    process.exit(1);
  }

  const container = new Container(config, { usePersistence: true });
  // Adopt a queued daily budget if one was set under a prior deployment (ACR-10 Settings),
  // and parse the JWT signing key once (fails loudly on a malformed key — Auth/IAM).
  await container.init();
  const reviewApi = new ReviewApi(
    container.review,
    container.sourceReview,
    container.team,
    container.alerts,
    container.metrics,
    container.settings,
    // The evidence store backs the gated `GET /api/evidence/:id/:artifact` endpoint
    // that streams screenshot/html/terms bytes to the panel (the authed complement of
    // the screenshot-only public CDN).
    container.evidenceStore,
    container.logger,
    {
      staticPageHtml: REVIEW_TEST_PAGE,
      corsAllowOrigin: config.reviewApi.adminCorsAllowOrigin,
      // Per-user JWT guard — ALWAYS wired (the hard-fail above guarantees a signing key).
      // Every `/api/*` request is verified against a per-user ES256 bearer; identity +
      // permissions come from the claims, the `approver` is the token email, and there is no
      // static-token or open fallback.
      auth: {
        tokenIssuer: container.tokenIssuer,
        db: container.db,
        authorization: container.authorization,
        // Auth/IAM (Phase 3): the Users & Roles admin surface (`/api/users`, `/api/roles`).
        provisionUser: container.provisionUser,
        manageRoles: container.manageRoles,
      },
    },
  );
  const authApi = new AuthApi(
    container.authenticateUser,
    container.refreshSession,
    container.logoutSession,
    container.tokenIssuer,
    container.logger,
    {
      corsAllowOrigin: config.reviewApi.adminCorsAllowOrigin,
      // A signing key is guaranteed present (the hard-fail above), so the IdP is configured.
      authConfigured: true,
    },
  );
  const publicApi = new PublicApi(container.db.deals, container.clock, container.logger, {
    cdnBaseUrl: config.evidence.s3?.cdnBaseUrl,
    corsAllowOrigin: config.publicApi.corsAllowOrigin,
  });

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Total prefix dispatch: /auth/* + JWKS first (most specific), then /v1/* (public
    // router's alone), else the gated /api/* admin router.
    const handler =
      path.startsWith('/auth/') || path === '/.well-known/jwks.json'
        ? authApi.handle(req, res)
        : path === '/v1' || path.startsWith('/v1/')
          ? publicApi.handle(req, res)
          : reviewApi.handle(req, res);
    handler.catch((err) => {
      container.logger.error('HTTP request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendError(res, 500, 'internal error');
    });
  });

  await new Promise<void>((resolve) => server.listen(config.reviewApi.port, () => resolve()));
  const port = config.reviewApi.port;
  console.log(`Public read API:   http://localhost:${port}/v1`);
  console.log(`Auth API / JWKS:   http://localhost:${port}/auth  ·  /.well-known/jwks.json`);
  console.log(`Review test page:  http://localhost:${port}/`);
  console.log(`Review API base:   http://localhost:${port}/api`);
  // Auth posture (Phase 5): per-user JWT is the only path. A signing key is guaranteed present
  // (the hard-fail above), so the gated surface is always authenticated — there is no
  // static-token or open mode left to warn about.
  console.log('Auth: per-user JWT (ES256) — every /api/* request requires a valid token.');

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}
