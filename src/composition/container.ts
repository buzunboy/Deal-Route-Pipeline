import { RECOMMENDED_MIN_OUTPUT_TOKENS, type Config } from '../config/index.js';
import {
  ExtractUseCase,
  CrawlSourceUseCase,
  DiscoverSiteUseCase,
  IngestCommunityUseCase,
  ReviewUseCase,
  SourceReviewUseCase,
  TeamUseCase,
  AlertsUseCase,
  SettingsUseCase,
  MonitorSourceUseCase,
  MetricsUseCase,
  DailyBudgetGuard,
  NoopBrowserAgent,
  DiscoverBroadUseCase,
  AuthorizationUseCase,
  AuthenticateUseCase,
  RefreshUseCase,
  LogoutUseCase,
  ProvisionUserUseCase,
  ManageRolesUseCase,
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
  type PasswordHasher,
  type TokenIssuer,
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
import { PersistingAlerter } from '../adapters/alerting/persisting-alerter.js';
import { Argon2idHasher } from '../adapters/security/argon2id-hasher.js';
import { JoseTokenIssuer } from '../adapters/security/jose-token-issuer.js';

/**
 * The ONE composition root. It reads typed config and constructs concrete
 * adapters behind the ports, then assembles the use-cases. Nothing else in the
 * codebase does `new SomeAdapter()`; everything receives its dependencies.
 *
 * `usePersistence: false` swaps Postgres for an in-memory DB so the pipeline runs
 * with no external services (dry-run, demos, tests).
 */
export interface ContainerOptions {
  /** When false, use the in-memory DB (no Postgres needed). Default true. */
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
    passwordHasher?: PasswordHasher;
    tokenIssuer?: TokenIssuer;
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
  // Auth/IAM ports (Phase 1). Constructed here (the one composition root); the use-cases
  // + HTTP guard that consume them are wired in Phase 2.
  readonly passwordHasher: PasswordHasher;
  readonly tokenIssuer: TokenIssuer;
  // Auth/IAM use-cases (Phase 2): the IdP login/refresh/logout + permission resolution.
  readonly authorization: AuthorizationUseCase;
  readonly authenticateUser: AuthenticateUseCase;
  readonly refreshSession: RefreshUseCase;
  readonly logoutSession: LogoutUseCase;
  // Auth/IAM use-cases (Phase 3): the runtime Users & Roles admin surface.
  readonly provisionUser: ProvisionUserUseCase;
  readonly manageRoles: ManageRolesUseCase;

  readonly extract: ExtractUseCase;
  readonly crawlSource: CrawlSourceUseCase;
  readonly discoverSite: DiscoverSiteUseCase;
  readonly discoverBroad: DiscoverBroadUseCase;
  readonly ingestCommunity: IngestCommunityUseCase;
  readonly review: ReviewUseCase;
  readonly sourceReview: SourceReviewUseCase;
  readonly team: TeamUseCase;
  readonly alerts: AlertsUseCase;
  readonly settings: SettingsUseCase;
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
    this.warnIfLowOutputTokens(config);
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
    // The DELIVERY alerter (webhook/Slack or noop), then WRAP it so every alert is
    // also PERSISTED (ACR-8) — the panel's Alerts screen + bell read the store, while
    // delivery still goes to the inner alerter. Best-effort: a persist failure never
    // affects the lane. A test-supplied `overrides.alerting` is still wrapped, so the
    // persisted-alert path is exercised end-to-end through the real Container.
    this.alerting = new PersistingAlerter(
      overrides.alerting ?? this.buildAlerter(config),
      this.db.alerts,
      this.clock,
      this.logger,
    );
    // Auth/IAM ports (Phase 1): the Argon2id hasher + the jose ES256 token issuer.
    // The issuer takes the injected Clock so iat/exp are deterministic in tests; keys
    // load lazily and fail loudly on first use (Phase 2's init() parses them at boot).
    // Test overrides let integration tests inject a deterministic hasher/issuer while
    // exercising the real wiring (same pattern as clock/llm/alerting).
    this.passwordHasher = overrides.passwordHasher ?? new Argon2idHasher(config.auth.argon2);
    this.tokenIssuer = overrides.tokenIssuer ?? new JoseTokenIssuer(config.auth.jwt, this.clock);

    // NB: there is intentionally no job queue. v1 runs as external cron invoking
    // the CLI (`crawl --due`, `monitor --due`, `ingest --community-due`) — see
    // README "Deployment". An in-process worker is future work; wire it then.

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
    this.team = new TeamUseCase(this.db, this.clock, this.logger);
    this.alerts = new AlertsUseCase(this.db, this.clock, this.logger);
    this.settings = new SettingsUseCase(this.db, config, this.clock, this.logger);
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
    this.metrics = new MetricsUseCase(this.db, this.clock, this.logger);
    this.dailyBudgetGuard = new DailyBudgetGuard(
      this.db,
      this.clock,
      this.logger,
      config.agent.dailyBudgetEur,
      this.alerting,
    );

    // Auth/IAM use-cases (Phase 2): the IdP. `authorization` is shared by the login/refresh
    // claim-minting AND the per-request JWT guard (so they never diverge). The realm
    // (iss/aud), TTLs, and lockout knobs come from `config.auth`.
    const realm = { iss: config.auth.jwt.iss, aud: config.auth.jwt.aud };
    this.authorization = new AuthorizationUseCase(this.db);
    this.authenticateUser = new AuthenticateUseCase(
      this.db,
      this.passwordHasher,
      this.tokenIssuer,
      this.clock,
      this.logger,
      config.auth.ttls,
      config.auth.login,
      realm,
    );
    this.refreshSession = new RefreshUseCase(
      this.db,
      this.tokenIssuer,
      this.clock,
      this.logger,
      config.auth.ttls,
      realm,
    );
    this.logoutSession = new LogoutUseCase(this.db, this.clock, this.logger);

    // Auth/IAM use-cases (Phase 3): the runtime Users & Roles admin surface. Both take
    // the SAME password policy as the login path + the seed-user CLI, so a too-short
    // admin-set/reset password is rejected identically everywhere.
    this.provisionUser = new ProvisionUserUseCase(
      this.db,
      this.passwordHasher,
      this.clock,
      this.logger,
      config.auth.passwordPolicy,
    );
    this.manageRoles = new ManageRolesUseCase(
      this.db,
      this.passwordHasher,
      this.clock,
      this.logger,
      config.auth.passwordPolicy,
    );
  }

  /**
   * One-time async startup step, called after construction by the entry points that
   * run real work (`serve` + the CLI lanes). Consumes a queued `daily_budget_queued`
   * setting (ACR-10 Settings): if one was stamped under a PRIOR deployment, THIS
   * deployment adopts its euros as the daily-budget ceiling and clears the row
   * (next-deploy semantics). A no-op when there's nothing queued. Safe to skip in
   * tests that don't exercise the budget. Idempotent within a process (consume deletes
   * the row), so a second call finds nothing.
   */
  async init(): Promise<void> {
    const adopted = await this.settings.consumeQueuedBudget();
    if (adopted !== null) this.dailyBudgetGuard.setCeiling(adopted);

    // Auth/IAM (Phase 2): if a JWT signing key is configured, parse it ONCE at boot and
    // FAIL LOUDLY on a malformed/incomplete key (a format mismatch must never silently
    // disable auth — it would leave the surface unintentionally open). When NO key is set
    // auth is intentionally disabled (open/legacy mode); we skip the check and `serve.ts`
    // warns instead. `ensureReady` lives on the `JoseTokenIssuer` adapter, not the port.
    if (
      this.config.auth.jwt.privateKey !== undefined &&
      this.tokenIssuer instanceof JoseTokenIssuer
    ) {
      await this.tokenIssuer.ensureReady();
    }
  }

  private buildFetcher(config: Config): Fetcher {
    const inner = this.buildInnerFetcher(config);
    // Wrap with the politeness decorator so the per-domain rate-limit (always) and
    // robots.txt (opt-in via RESPECT_ROBOTS_TXT, default off under best-effort-read)
    // are actually enforced. Behind the Fetcher port, so the crawl use-case and
    // concrete fetchers are unchanged. EVERY inner fetcher — incl. the C-2 browser
    // one — is wrapped, so the access policy applies uniformly (no lane bypasses
    // the rate-limit).
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

  /**
   * Warn (don't fail) when the LLM output-token ceiling is below the recommended
   * floor: dense DE pages overflow the extraction JSON and truncate past recovery,
   * failing the whole page. The schema floor stays at 4096 (a hard backstop), so a
   * deliberately-low value is allowed — but it's almost always a stale env override,
   * so surface it loudly at startup. Skipped for `stub` (offline, no real call).
   */
  private warnIfLowOutputTokens(config: Config): void {
    if (config.llm.provider === 'stub') return;
    if (config.llm.maxOutputTokens < RECOMMENDED_MIN_OUTPUT_TOKENS) {
      this.logger.warn('LLM_MAX_OUTPUT_TOKENS is below the recommended floor', {
        configured: config.llm.maxOutputTokens,
        recommended: RECOMMENDED_MIN_OUTPUT_TOKENS,
        impact:
          'dense pages can truncate the extraction JSON past recovery and fail the page; ' +
          'unset LLM_MAX_OUTPUT_TOKENS to use the default.',
      });
    }
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
