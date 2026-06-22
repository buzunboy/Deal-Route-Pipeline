import { createServer, type ServerResponse } from 'node:http';
import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { ReviewApi } from '../../http/review-api.js';
import { PublicApi } from '../../http/public-api.js';
import { REVIEW_TEST_PAGE } from '../../http/test-page.js';

/**
 * `serve` — start the HTTP surface on one port: the PUBLIC read API (`/v1/*`,
 * unauthenticated, read-only over published deals) and the gated admin review API
 * (`/api/*` + the test page). Dispatch is by path prefix and TOTAL: a `/v1/*`
 * request is ALWAYS handled by `PublicApi` (which 404s its own unknown paths) and
 * never falls through to the admin router, so a public path can never reach an
 * admin/state-changing route. Runs until interrupted.
 */
export async function serve(config: Config): Promise<void> {
  const container = new Container(config, { usePersistence: true });
  const reviewApi = new ReviewApi(
    container.review,
    container.sourceReview,
    container.team,
    container.alerts,
    container.logger,
    {
      staticPageHtml: REVIEW_TEST_PAGE,
      authToken: config.reviewApi.authToken,
      corsAllowOrigin: config.reviewApi.adminCorsAllowOrigin,
      // Same CDN base the public API resolves screenshot URLs from — so the admin
      // panel's evidence frame gets resolvable artifact URLs (ACR-13).
      evidenceCdnBaseUrl: config.evidence.s3?.cdnBaseUrl,
    },
  );
  const publicApi = new PublicApi(container.db.deals, container.clock, container.logger, {
    cdnBaseUrl: config.evidence.s3?.cdnBaseUrl,
    corsAllowOrigin: config.publicApi.corsAllowOrigin,
  });

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Total prefix dispatch: /v1/* is the public router's alone.
    const handler =
      path === '/v1' || path.startsWith('/v1/')
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
  console.log(`Review test page:  http://localhost:${port}/`);
  console.log(`Review API base:   http://localhost:${port}/api`);
  if (config.reviewApi.authToken === undefined) {
    console.log(
      'WARNING: no REVIEW_API_TOKEN set — approve/reject are unauthenticated. ' +
        'Bind to a trusted network or set REVIEW_API_TOKEN.',
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
