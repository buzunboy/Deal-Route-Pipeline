import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { ReviewApi } from '../../http/review-api.js';
import { REVIEW_TEST_PAGE } from '../../http/test-page.js';

/**
 * `serve` — start the review API + thin test page. The API is the durable
 * contract for the future admin panel; the page is a thin harness for system
 * validation. Runs until interrupted.
 */
export async function serve(config: Config): Promise<void> {
  const container = new Container(config, { usePersistence: true });
  const api = new ReviewApi(container.review, container.logger, {
    staticPageHtml: REVIEW_TEST_PAGE,
    authToken: config.reviewApi.authToken,
  });
  await api.listen(config.reviewApi.port);
  console.log(`Review test page:  http://localhost:${config.reviewApi.port}/`);
  console.log(`Review API base:   http://localhost:${config.reviewApi.port}/api`);
  if (config.reviewApi.authToken === undefined) {
    console.log(
      'WARNING: no REVIEW_API_TOKEN set — approve/reject are unauthenticated. ' +
        'Bind to a trusted network or set REVIEW_API_TOKEN.',
    );
  }

  const shutdown = async (): Promise<void> => {
    await api.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
