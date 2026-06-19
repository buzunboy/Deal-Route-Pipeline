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
  SystemClock,
  type Fetcher,
  type FeedReader,
  type Llm,
  type EvidenceStore,
  type Database,
  type Logger,
  type Clock,
  type SearchProvider,
} from '../application/index.js';
import { SEED_VOCABULARY, type Vocabulary } from '../domain/index.js';
import { ConsoleLogger } from '../adapters/logger/console-logger.js';
import { LocalFsEvidenceStore } from '../adapters/evidence-store/local-fs-evidence-store.js';
import { AnthropicLlm } from '../adapters/llm/anthropic-llm.js';
import { OpenAiLlm } from '../adapters/llm/openai-llm.js';
import { StubLlm } from '../adapters/llm/stub-llm.js';
import { PlaywrightFetcher } from '../adapters/fetcher/playwright-fetcher.js';
import { FirecrawlFetcher } from '../adapters/fetcher/firecrawl-fetcher.js';
import { PoliteFetcher } from '../adapters/fetcher/polite-fetcher.js';
import { StubSearchProvider } from '../adapters/search/stub-search-provider.js';
import { BraveSearchProvider } from '../adapters/search/brave-search-provider.js';
import { FirecrawlSearchProvider } from '../adapters/search/firecrawl-search-provider.js';
import { RssFeedReader } from '../adapters/feed/rss-feed-reader.js';
import { InMemoryDb } from '../adapters/db/in-memory/in-memory-db.js';
import { PostgresDb } from '../adapters/db/postgres/postgres-db.js';

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

  readonly extract: ExtractUseCase;
  readonly crawlSource: CrawlSourceUseCase;
  readonly discoverSite: DiscoverSiteUseCase;
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
    // NB: there is intentionally no job queue wired here. v1 runs as external
    // cron invoking the CLI (`crawl --due`, `monitor --due`, `ingest
    // --community-due`) — see README "Deployment". The `Queue` port + pg-boss/
    // in-memory adapters remain in the tree for the future in-process worker
    // (Phase C scheduler), but are not a runtime dependency of the container.

    this.extract = new ExtractUseCase(this.llm, this.logger);
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
    );
    this.review = new ReviewUseCase(this.db, this.clock, this.logger);
    this.sourceReview = new SourceReviewUseCase(this.db, this.clock, this.logger);
    this.monitor = new MonitorSourceUseCase(
      this.fetcher,
      this.db,
      this.crawlSource,
      this.clock,
      this.logger,
      config.fetcher.userAgent,
      config.fetcher.timeoutMs,
    );
    this.metrics = new MetricsUseCase(this.db, this.logger);
    this.dailyBudgetGuard = new DailyBudgetGuard(
      this.db,
      this.clock,
      this.logger,
      config.agent.dailyBudgetEur,
    );
  }

  private buildFetcher(config: Config): Fetcher {
    let inner: Fetcher;
    if (config.fetcher.kind === 'firecrawl') {
      if (!config.fetcher.firecrawlApiKey) {
        throw new Error('FETCHER=firecrawl requires FIRECRAWL_API_KEY.');
      }
      inner = new FirecrawlFetcher(config.fetcher.firecrawlApiKey, config.fetcher.timeoutMs);
    } else {
      const playwright = new PlaywrightFetcher(config.fetcher.timeoutMs);
      this.closables.push(playwright);
      inner = playwright;
    }
    // Wrap with the politeness decorator so robots.txt + per-domain rate limiting
    // are actually enforced (the config promised them). Behind the Fetcher port,
    // so the crawl use-case and concrete fetchers are unchanged.
    return new PoliteFetcher(inner, {
      respectRobotsTxt: config.crawl.respectRobotsTxt,
      minIntervalMs: config.crawl.perDomainRateLimitMs,
      userAgent: config.fetcher.userAgent,
      logger: this.logger,
    });
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
    // S3 adapter is a documented extension point; local-fs is the dev default.
    if (config.evidence.kind === 's3') {
      throw new Error('S3 evidence store is not wired in Phase A. Use EVIDENCE_STORE=local.');
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
    for (const c of this.closables) {
      await c.close();
    }
  }
}
