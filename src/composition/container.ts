import type { Config } from '../config/index.js';
import {
  ExtractUseCase,
  CrawlSourceUseCase,
  DiscoverSiteUseCase,
  IngestCommunityUseCase,
  ReviewUseCase,
  SourceReviewUseCase,
  MonitorSourceUseCase,
  MetricsUseCase,
  DailyBudgetGuard,
  NoopBrowserAgent,
  DiscoverBroadUseCase,
  SystemClock,
  type Fetcher,
  type FeedReader,
  type Llm,
  type EvidenceStore,
  type Database,
  type Logger,
  type Clock,
  type SearchProvider,
  type BrowserAgent,
  type Alerting,
} from '../application/index.js';
import {
  SEED_VOCABULARY,
  DomainDenylist,
  type Vocabulary,
  type SuffixOracle,
} from '../domain/index.js';
import { tldtsSuffixOracle } from '../adapters/suffix/tldts-suffix-oracle.js';
import { S3Client } from '@aws-sdk/client-s3';
import { ConsoleLogger } from '../adapters/logger/console-logger.js';
import { LocalFsEvidenceStore } from '../adapters/evidence-store/local-fs-evidence-store.js';
import { S3EvidenceStore } from '../adapters/evidence-store/s3-evidence-store.js';
import { AnthropicLlm } from '../adapters/llm/anthropic-llm.js';
import { OpenAiLlm } from '../adapters/llm/openai-llm.js';
import { StubLlm } from '../adapters/llm/stub-llm.js';
import { PlaywrightFetcher } from '../adapters/fetcher/playwright-fetcher.js';
import { BrowserRenderFetcher } from '../adapters/fetcher/browser-render-fetcher.js';
import { FirecrawlFetcher } from '../adapters/fetcher/firecrawl-fetcher.js';
import { HostedBrowserFetcher } from '../adapters/fetcher/hosted-browser-fetcher.js';
import { PoliteFetcher } from '../adapters/fetcher/polite-fetcher.js';
import { StubSearchProvider } from '../adapters/search/stub-search-provider.js';
import { BraveSearchProvider } from '../adapters/search/brave-search-provider.js';
import { FirecrawlSearchProvider } from '../adapters/search/firecrawl-search-provider.js';
import { SearchBrowserAgent } from '../adapters/agent/search-browser-agent.js';
import { RssFeedReader } from '../adapters/feed/rss-feed-reader.js';
import { InMemoryDb } from '../adapters/db/in-memory/in-memory-db.js';
import { PostgresDb } from '../adapters/db/postgres/postgres-db.js';
import { NoopAlerter } from '../adapters/alerting/noop-alerter.js';
import { WebhookAlerter } from '../adapters/alerting/webhook-alerter.js';

/**
 * The ONE composition root. It reads typed config and constructs concrete
 * adapters behind the ports, then assembles the use-cases. Nothing else in the
 * codebase does `new SomeAdapter()`; everything receives its dependencies.
 *
 * `usePersistence: false` swaps Postgres/pg-boss for in-memory equivalents so the
 * pipeline runs with no external services (dry-run, demos, tests).
 */
export interface ContainerOptions {
  /** When false, use in-memory DB + queue (no Postgres needed). Default true. */
  usePersistence?: boolean;
  vocabulary?: Vocabulary;
  /**
   * Test-only adapter overrides. The composition root is the one place injection
   * belongs, so integration tests can exercise the REAL wiring + real Postgres
   * while swapping out the genuinely-external edges (network fetch, LLM, feeds,
   * wall clock) for deterministic doubles. Production passes none of these.
   */
  overrides?: {
    fetcher?: Fetcher;
    feedReader?: FeedReader;
    llm?: Llm;
    clock?: Clock;
    searchProvider?: SearchProvider;
    browserAgent?: BrowserAgent;
    alerting?: Alerting;
    suffixOracle?: SuffixOracle;
  };
}

export class Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly fetcher: Fetcher;
  readonly feedReader: FeedReader;
  readonly llm: Llm;
  readonly evidenceStore: EvidenceStore;
  readonly db: Database;
  readonly vocabulary: Vocabulary;
  readonly searchProvider: SearchProvider;
  readonly browserAgent: BrowserAgent;
  readonly alerting: Alerting;
  readonly suffixOracle: SuffixOracle;

  readonly extract: ExtractUseCase;
  readonly crawlSource: CrawlSourceUseCase;
  readonly discoverSite: DiscoverSiteUseCase;
  readonly discoverBroad: DiscoverBroadUseCase;
  readonly ingestCommunity: IngestCommunityUseCase;
  readonly review: ReviewUseCase;
  readonly sourceReview: SourceReviewUseCase;
  readonly monitor: MonitorSourceUseCase;
  readonly metrics: MetricsUseCase;
  readonly dailyBudgetGuard: DailyBudgetGuard;

  /** Adapters needing teardown (browser, pools). Closed by `shutdown()`. */
  private readonly closables: { close(): Promise<void> }[] = [];

  constructor(config: Config, options: ContainerOptions = {}) {
    const usePersistence = options.usePersistence ?? true;
    const overrides = options.overrides ?? {};
    this.config = config;
    this.vocabulary = options.vocabulary ?? SEED_VOCABULARY;
    this.logger = new ConsoleLogger(config.logLevel);
    this.clock = overrides.clock ?? new SystemClock();

    this.fetcher = overrides.fetcher ?? this.buildFetcher(config);
    this.feedReader = overrides.feedReader ?? new RssFeedReader(config.fetcher.timeoutMs);
    this.llm = overrides.llm ?? this.buildLlm(config);
    this.evidenceStore = this.buildEvidenceStore(config);
    this.db = this.buildDatabase(config, usePersistence);
    this.searchProvider = overrides.searchProvider ?? this.buildSearchProvider(config);
    // The real Public Suffix List oracle (Step 6) — the one place the domain's
    // registrable-domain resolution depends on a PSL vendor; injected so every
    // pin/discovery site shares one instance and the domain layer stays vendor-free.
    // Built BEFORE the browser agent (the search agent threads it in).
    this.suffixOracle = overrides.suffixOracle ?? tldtsSuffixOracle;
    this.browserAgent = overrides.browserAgent ?? this.buildBrowserAgent(config);
    this.alerting = overrides.alerting ?? this.buildAlerter(config);
    // NB: there is intentionally no job queue wired here. v1 runs as external
    // cron invoking the CLI (`crawl --due`, `monitor --due`, `ingest
    // --community-due`) — see README "Deployment". The `Queue` port + pg-boss/
    // in-memory adapters remain in the tree for the future in-process worker
    // (Phase C scheduler), but are not a runtime dependency of the container.

    this.extract = new ExtractUseCase(this.llm, this.logger, this.suffixOracle);
    this.crawlSource = new CrawlSourceUseCase(
      this.fetcher,
      this.evidenceStore,
      this.db,
      this.extract,
      this.clock,
      this.logger,
      this.vocabulary,
      config.fetcher.userAgent,
      config.fetcher.timeoutMs,
      this.alerting,
    );
    this.discoverSite = new DiscoverSiteUseCase(
      this.fetcher,
      this.evidenceStore,
      this.db,
      this.extract,
      this.clock,
      this.logger,
      this.vocabulary,
      config.fetcher.userAgent,
      config.fetcher.timeoutMs,
      this.suffixOracle,
    );
    this.discoverBroad = new DiscoverBroadUseCase(
      this.browserAgent,
      this.evidenceStore,
      this.db,
      this.extract,
      this.clock,
      this.logger,
      this.vocabulary,
      DomainDenylist.fromConfig(this.suffixOracle, config.discovery.denyDomains),
      this.suffixOracle,
    );
    this.ingestCommunity = new IngestCommunityUseCase(
      this.fetcher,
      this.feedReader,
      this.llm,
      this.evidenceStore,
      this.db,
      this.extract,
      this.clock,
      this.logger,
      this.vocabulary,
      config.fetcher.userAgent,
      config.fetcher.timeoutMs,
      this.suffixOracle,
    );
    this.review = new ReviewUseCase(this.db, this.clock, this.logger, this.suffixOracle);
    this.sourceReview = new SourceReviewUseCase(
      this.db,
      this.clock,
      this.logger,
      this.suffixOracle,
      config.country,
    );
    this.monitor = new MonitorSourceUseCase(
      this.fetcher,
      this.db,
      this.crawlSource,
      this.clock,
      this.logger,
      config.fetcher.userAgent,
      config.fetcher.timeoutMs,
      this.alerting,
    );
    this.metrics = new MetricsUseCase(this.db, this.logger);
    this.dailyBudgetGuard = new DailyBudgetGuard(
      this.db,
      this.clock,
      this.logger,
      config.agent.dailyBudgetEur,
      this.alerting,
    );
  }

  private buildFetcher(config: Config): Fetcher {
    const inner = this.buildInnerFetcher(config);
    // Wrap with the politeness decorator so the per-domain rate-limit (always) and
    // robots.txt (opt-in via RESPECT_ROBOTS_TXT, default off under best-effort-read)
    // are actually enforced. Behind the Fetcher port, so the crawl use-case and
    // concrete fetchers are unchanged. EVERY inner fetcher — incl. the C-2 browser/
    // hosted-browser ones — is wrapped, so the access policy applies uniformly (no
    // lane bypasses the rate-limit).
    return new PoliteFetcher(inner, {
      respectRobotsTxt: config.crawl.respectRobotsTxt,
      minIntervalMs: config.crawl.perDomainRateLimitMs,
      userAgent: config.fetcher.userAgent,
      logger: this.logger,
    });
  }

  /** The concrete fetch backend, chosen by `FETCHER`. Browser-backed ones are closable. */
  private buildInnerFetcher(config: Config): Fetcher {
    const { kind, timeoutMs } = config.fetcher;
    switch (kind) {
      case 'firecrawl': {
        if (!config.fetcher.firecrawlApiKey) {
          throw new Error('FETCHER=firecrawl requires FIRECRAWL_API_KEY.');
        }
        return new FirecrawlFetcher(config.fetcher.firecrawlApiKey, timeoutMs);
      }
      case 'browser': {
        // C-2: local Playwright JS-render (networkidle + scroll) for JS-heavy SPAs.
        const browser = new BrowserRenderFetcher(timeoutMs);
        this.closables.push(browser);
        return browser;
      }
      case 'hosted-browser': {
        // C-2 hosted scaffold — fail loud without a key, throws until implemented.
        if (!config.fetcher.browserApiKey) {
          throw new Error('FETCHER=hosted-browser requires BROWSER_API_KEY.');
        }
        const hosted = new HostedBrowserFetcher(config.fetcher.browserApiKey, timeoutMs);
        this.closables.push(hosted);
        return hosted;
      }
      case 'playwright':
      default: {
        const playwright = new PlaywrightFetcher(timeoutMs);
        this.closables.push(playwright);
        return playwright;
      }
    }
  }

  private buildSearchProvider(config: Config): SearchProvider {
    // `stub` is the offline off-switch (default when no key is configured), so
    // Tier-4 broad discovery never reaches the open web until explicitly enabled.
    if (config.search.provider === 'stub') return new StubSearchProvider();
    if (config.search.provider === 'firecrawl') {
      // Reuses the existing Firecrawl key (the scrape adapter's key), so a missing
      // one fails loudly here rather than at first search.
      if (!config.fetcher.firecrawlApiKey) {
        throw new Error('SEARCH_PROVIDER=firecrawl requires FIRECRAWL_API_KEY.');
      }
      return new FirecrawlSearchProvider(config.fetcher.firecrawlApiKey);
    }
    if (!config.search.apiKey) {
      throw new Error('SEARCH_PROVIDER=api requires SEARCH_API_KEY.');
    }
    return new BraveSearchProvider(config.search.apiKey);
  }

  private buildAlerter(config: Config): Alerting {
    // `noop` is the DEFAULT off-switch — alerts are logged at debug, delivered
    // nowhere, until ALERT_KIND=webhook + ALERT_WEBHOOK_URL are set. A missing URL
    // fails loudly here rather than silently dropping alerts at runtime.
    if (config.alerting.kind === 'noop') return new NoopAlerter(this.logger);
    if (!config.alerting.webhookUrl) {
      throw new Error('ALERT_KIND=webhook requires ALERT_WEBHOOK_URL.');
    }
    return new WebhookAlerter(
      { url: config.alerting.webhookUrl, timeoutMs: config.alerting.timeoutMs },
      this.logger,
    );
  }

  private buildBrowserAgent(config: Config): BrowserAgent {
    // `noop` is the DEFAULT off-switch — Tier-4 broad discovery does not run until
    // AGENT=search is explicitly set, even when a search key is configured.
    if (config.agent.kind === 'noop') return new NoopBrowserAgent();
    // The thin search-API-first agent reuses the configured (polite) Fetcher, so
    // its fetches respect robots + per-domain rate limits exactly like all lanes.
    return new SearchBrowserAgent(
      this.searchProvider,
      this.fetcher,
      this.clock,
      this.logger,
      this.suffixOracle,
      {
        resultsPerQuery: config.search.resultsPerQuery,
        country: config.country,
        searchTimeoutMs: config.fetcher.timeoutMs,
        fetchTimeoutMs: config.fetcher.timeoutMs,
        userAgent: config.fetcher.userAgent,
        searchCostEur: config.agent.searchCostEur,
        inlineScrape: config.agent.inlineScrape,
      },
    );
  }

  private buildLlm(config: Config): Llm {
    if (config.llm.provider === 'stub') return new StubLlm();
    const common = {
      extractionModel: config.llm.extractionModel,
      discoveryModel: config.llm.discoveryModel,
      maxOutputTokens: config.llm.maxOutputTokens,
      timeoutMs: config.llm.timeoutMs,
    };
    if (config.llm.provider === 'openai') {
      if (!config.llm.openaiApiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY.');
      return new OpenAiLlm({ apiKey: config.llm.openaiApiKey, ...common });
    }
    if (!config.llm.anthropicApiKey) {
      throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
    }
    return new AnthropicLlm({ apiKey: config.llm.anthropicApiKey, ...common });
  }

  private buildEvidenceStore(config: Config): EvidenceStore {
    // local-fs is the dev default; S3/R2 is the production sibling.
    if (config.evidence.kind === 's3') {
      const s3 = config.evidence.s3;
      // The config schema requires the full S3 block once S3_BUCKET is set, but a
      // bare EVIDENCE_STORE=s3 with no S3_BUCKET leaves it undefined — fail loud
      // here rather than at first write (loud-failure policy).
      if (!s3) {
        throw new Error(
          'EVIDENCE_STORE=s3 requires the S3 config block (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).',
        );
      }
      const client = new S3Client({
        region: s3.region,
        // Custom endpoint ⇒ R2/MinIO-compatible; force path-style addressing so the
        // bucket is in the path, not a vhost subdomain those stores don't serve.
        ...(s3.endpoint ? { endpoint: s3.endpoint, forcePathStyle: true } : {}),
        credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      });
      const store = new S3EvidenceStore({ client, bucket: s3.bucket });
      // Register for teardown so shutdown() releases the S3 HTTP agent/sockets
      // (like every other vendor-backed adapter).
      this.closables.push(store);
      return store;
    }
    return new LocalFsEvidenceStore(config.evidence.localDir);
  }

  private buildDatabase(config: Config, usePersistence: boolean): Database {
    if (!usePersistence) return new InMemoryDb();
    if (config.database.url.trim() === '') {
      throw new Error(
        'Persistence enabled but DATABASE_URL is empty. Set it, or run a dry-run/offline command.',
      );
    }
    const db = PostgresDb.connect(config.database.url, {
      pool: config.database.pool,
      retry: config.database.retry,
      logger: this.logger,
    });
    this.closables.push(db);
    return db;
  }

  async shutdown(): Promise<void> {
    // Settle ALL closables independently: a browser close() that hangs/throws must
    // not strand the others (e.g. leave the Postgres pool open) — sequential await
    // would abort the rest on the first failure. Log failures; never throw.
    const results = await Promise.allSettled(this.closables.map((c) => c.close()));
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.error('container shutdown: a resource failed to close', {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }
}
