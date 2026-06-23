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
      authToken: config.reviewApi.authToken,
      corsAllowOrigin: config.reviewApi.adminCorsAllowOrigin,
      // Auth/IAM (Phase 2): wire the per-user JWT guard ONLY when a signing key is
      // configured. Without a key the issuer can't verify, so passing `auth` would make
      // EVERY /api/* request 401 (a key-less verify throws) — silently locking the surface
      // and contradicting the open-mode banner below. Omitting it when there's no key keeps
      // the genuinely-open trusted-network mode reachable (and the legacy `authToken` above
      // stays accepted alongside JWTs during the dual-accept window).
      ...(config.auth.jwt.privateKey !== undefined && {
        auth: {
          tokenIssuer: container.tokenIssuer,
          db: container.db,
          authorization: container.authorization,
          // Auth/IAM (Phase 3): the Users & Roles admin surface (`/api/users`, `/api/roles`).
          provisionUser: container.provisionUser,
          manageRoles: container.manageRoles,
        },
      }),
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
      // With no signing key the IdP can't mint/publish tokens — /auth/* 503s clearly.
      authConfigured: config.auth.jwt.privateKey !== undefined,
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
  // Auth posture warnings: with NO signing key, per-user JWT auth is disabled; with NO
  // legacy token either, the gated surface is fully OPEN (must be a trusted network).
  if (config.auth.jwt.privateKey === undefined) {
    console.log(
      'WARNING: no AUTH_JWT_PRIVATE_KEY set — per-user JWT auth is disabled (no /auth/login).',
    );
  }
  if (config.reviewApi.authToken === undefined && config.auth.jwt.privateKey === undefined) {
    console.log(
      'WARNING: neither AUTH_JWT_PRIVATE_KEY nor REVIEW_API_TOKEN set — /api/* is UNAUTHENTICATED. ' +
        'Bind to a trusted network or configure auth.',
    );
  }

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
