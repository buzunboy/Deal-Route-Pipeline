import { z } from 'zod';

/**
 * Typed configuration parsed from the environment at the composition root. All
 * config + secrets come from env (`code-style.md`); nothing is hard-coded in
 * business logic. Parsing happens ONCE, here, and the rest of the app receives a
 * typed `Config` — never `process.env`.
 */

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const ConfigSchema = z.object({
  llm: z.object({
    // `stub` is an offline, no-key provider for demos / e2e dry-run / CI.
    provider: z.enum(['anthropic', 'openai', 'stub']),
    extractionModel: z.string().min(1),
    discoveryModel: z.string().min(1),
    maxOutputTokens: z.coerce.number().int().positive(),
    timeoutMs: z.coerce.number().int().positive(),
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
  }),
  fetcher: z.object({
    // playwright = local headless Chromium (domcontentloaded; default). browser =
    // local Playwright JS-RENDER (networkidle + scroll) for JS-heavy SPAs (C-2).
    // firecrawl / hosted-browser = vendor APIs (hosted-browser is a C-2 scaffold).
    kind: z.enum(['playwright', 'browser', 'firecrawl', 'hosted-browser']),
    timeoutMs: z.coerce.number().int().positive(),
    userAgent: z.string().min(1),
    firecrawlApiKey: z.string().optional(),
    /** Hosted-browser vendor API key (only when FETCHER=hosted-browser). */
    browserApiKey: z.string().optional(),
  }),
  // Tier-4 broad-discovery search backend (Phase C, C-1). `stub` is the offline
  // off-switch (no network, like the noop browser agent); `api` is the real
  // dedicated search API (Brave); `firecrawl` reuses the Firecrawl key. The
  // composition root fails loudly if a real provider is selected without its key.
  search: z.object({
    provider: z.enum(['stub', 'api', 'firecrawl']),
    apiKey: z.string().optional(),
    resultsPerQuery: z.coerce.number().int().positive(),
  }),
  // Tier-4 broad discovery (Phase C, C-1) tuning beyond the shared `agent` budget.
  discovery: z.object({
    /** Hard cap on search queries issued per broad-discovery run. */
    maxQueries: z.coerce.number().int().positive(),
    /** Extra deny-list domains (comma/space-separated) on top of the defaults. */
    denyDomains: z.string().optional(),
  }),
  evidence: z.object({
    kind: z.enum(['local', 's3']),
    localDir: z.string().min(1),
    s3: z
      .object({
        // Required when S3 is configured at all, so a partial S3 setup fails
        // loudly at config load rather than at first write (loud-failure policy).
        bucket: z.string().min(1),
        region: z.string().min(1),
        endpoint: z.string().optional(),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        // Optional public CDN/base URL the public read API uses to build a deal's
        // screenshot URL: `${cdnBaseUrl}/<evidence_id>/screenshot.png`. Unset ⇒ no
        // public evidence URL is exposed (admin-only access via get()).
        // DEPLOYMENT CONTRACT: an evidence bundle stores screenshot.png + page.html
        // + terms.txt + evidence.json under the SAME `<id>/` prefix. Only
        // `*/screenshot.png` may be publicly reachable — the HTML snapshot and the
        // verbatim (copyrighted) terms text must NOT be. Scope the CDN/bucket policy
        // to `screenshot.png` objects (or serve screenshots from a separate public
        // prefix). See ARCHITECTURE.md "Public read surface" + docs/KNOWN_ISSUES.md.
        cdnBaseUrl: z.string().url().optional(),
      })
      .optional(),
  }),
  // DB/queue URLs are optional at parse time: the offline path (dry-run, tests,
  // stub) uses in-memory adapters and needs no Postgres (README: "Dry-run and
  // tests need neither"). The composition root enforces their presence loudly
  // only when it actually constructs the Postgres / pg-boss adapters.
  database: z.object({
    url: z.string(),
    // Pool + per-statement resilience (Pre-C-2). Bounds connections so an
    // unattended run can't exhaust Postgres, and caps any single query so a wedged
    // statement can't hold a connection forever.
    pool: z.object({
      max: z.coerce.number().int().positive(),
      idleTimeoutMillis: z.coerce.number().int().nonnegative(),
      connectionTimeoutMillis: z.coerce.number().int().positive(),
      statementTimeoutMillis: z.coerce.number().int().positive(),
    }),
    // Retry bounds for transient DB errors (connection reset, serialization
    // failure, deadlock). Writes stay idempotent (see PostgresDb).
    retry: z.object({
      retries: z.coerce.number().int().nonnegative(),
      baseDelayMs: z.coerce.number().int().nonnegative(),
    }),
  }),
  queue: z.object({
    databaseUrl: z.string(),
  }),
  crawl: z.object({
    defaultRecrawlDays: z.coerce.number().int().positive(),
    perDomainRateLimitMs: z.coerce.number().int().nonnegative(),
    respectRobotsTxt: boolish,
  }),
  agent: z.object({
    // The BrowserAgent (Tier-4 broad discovery). `noop` is the DEFAULT off-switch
    // (nothing runs Tier-4); `search` is the C-1 search-API-first agent. A future
    // real-browser agent (C-2) is another value behind the same port.
    kind: z.enum(['noop', 'search']),
    maxSteps: z.coerce.number().int().positive(),
    maxSeconds: z.coerce.number().int().positive(),
    maxCostEur: z.coerce.number().nonnegative(),
    /** Estimated € cost of a single search-API call (the search agent's own spend). */
    searchCostEur: z.coerce.number().nonnegative(),
    // Aggregate €/UTC-day ceiling across ALL agentic/discovery runs (Pre-C-3),
    // distinct from the per-run `maxCostEur`. A batch checks spend-so-far-today
    // before each run and stops once this is reached, so a runaway day can't blow
    // cost. `0` disables the guard (explicit off-switch).
    dailyBudgetEur: z.coerce.number().nonnegative(),
  }),
  reviewApi: z.object({
    port: z.coerce.number().int().positive(),
    /** Bearer token gating approve/reject. Unset ⇒ open (bind to a trusted network). */
    authToken: z.string().min(1).optional(),
  }),
  publicApi: z.object({
    /**
     * `Access-Control-Allow-Origin` for the public `/v1/` read API. The feed is
     * fully public + unauthenticated (no cookies/credentials), so `*` is the safe
     * default; set `PUBLIC_CORS_ORIGIN` to the landing-page origin to tighten it.
     */
    corsAllowOrigin: z.string().min(1),
  }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  country: z.string().min(1),
  currency: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build a typed Config from a raw env record. Fails loudly with the offending
 * variables if anything required is missing or malformed — better a clear startup
 * error than a hidden misconfiguration in production.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    llm: {
      provider: env.LLM_PROVIDER ?? 'anthropic',
      extractionModel: env.LLM_EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001',
      discoveryModel: env.LLM_DISCOVERY_MODEL ?? 'claude-opus-4-8',
      // Headroom for multi-deal pages: a page with several plans + verbose
      // German terms can exceed 4k output tokens and truncate mid-JSON.
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS ?? '8192',
      timeoutMs: env.LLM_TIMEOUT_MS ?? '60000',
      anthropicApiKey: emptyToUndefined(env.ANTHROPIC_API_KEY),
      openaiApiKey: emptyToUndefined(env.OPENAI_API_KEY),
    },
    fetcher: {
      kind: env.FETCHER ?? 'playwright',
      timeoutMs: env.FETCH_TIMEOUT_MS ?? '30000',
      userAgent: env.FETCH_USER_AGENT ?? 'DealRouteBot/0.1',
      firecrawlApiKey: emptyToUndefined(env.FIRECRAWL_API_KEY),
      browserApiKey: emptyToUndefined(env.BROWSER_API_KEY),
    },
    search: {
      // Default to the real API when a key is configured, else the offline stub —
      // so Tier-4 never reaches the open web until a key is explicitly provided.
      provider: env.SEARCH_PROVIDER ?? (emptyToUndefined(env.SEARCH_API_KEY) ? 'api' : 'stub'),
      apiKey: emptyToUndefined(env.SEARCH_API_KEY),
      resultsPerQuery: env.SEARCH_RESULTS_PER_QUERY ?? '10',
    },
    discovery: {
      maxQueries: env.DISCOVERY_MAX_QUERIES ?? '20',
      denyDomains: emptyToUndefined(env.DISCOVERY_DENY_DOMAINS),
    },
    evidence: {
      kind: env.EVIDENCE_STORE ?? 'local',
      localDir: env.EVIDENCE_LOCAL_DIR ?? './.evidence',
      s3: env.S3_BUCKET
        ? {
            bucket: env.S3_BUCKET,
            region: env.S3_REGION ?? '',
            endpoint: emptyToUndefined(env.S3_ENDPOINT),
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
            cdnBaseUrl: emptyToUndefined(env.S3_CDN_BASE_URL),
          }
        : undefined,
    },
    database: {
      url: env.DATABASE_URL ?? '',
      pool: {
        max: env.DB_POOL_MAX ?? '10',
        idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS ?? '30000',
        connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS ?? '10000',
        statementTimeoutMillis: env.DB_STATEMENT_TIMEOUT_MS ?? '30000',
      },
      retry: {
        retries: env.DB_RETRIES ?? '3',
        baseDelayMs: env.DB_RETRY_BASE_DELAY_MS ?? '100',
      },
    },
    queue: { databaseUrl: emptyToUndefined(env.QUEUE_DATABASE_URL) ?? env.DATABASE_URL ?? '' },
    crawl: {
      defaultRecrawlDays: env.DEFAULT_RECRAWL_DAYS ?? '3',
      perDomainRateLimitMs: env.PER_DOMAIN_RATE_LIMIT_MS ?? '2000',
      respectRobotsTxt: env.RESPECT_ROBOTS_TXT ?? 'true',
    },
    agent: {
      // Default off: Tier-4 stays dark until AGENT=search is explicitly set.
      kind: env.AGENT ?? 'noop',
      maxSteps: env.AGENT_MAX_STEPS ?? '25',
      maxSeconds: env.AGENT_MAX_SECONDS ?? '300',
      maxCostEur: env.AGENT_MAX_COST_EUR ?? '1.00',
      searchCostEur: env.SEARCH_COST_EUR ?? '0.005',
      // €10/day: comfortable v1 headroom for the agentic lane while still a hard
      // stop well short of real money. Raise as Phase C proves out; 0 disables.
      dailyBudgetEur: env.DAILY_BUDGET_EUR ?? '10.00',
    },
    reviewApi: {
      port: env.REVIEW_API_PORT ?? '3000',
      authToken: emptyToUndefined(env.REVIEW_API_TOKEN),
    },
    publicApi: {
      corsAllowOrigin: env.PUBLIC_CORS_ORIGIN ?? '*',
    },
    logLevel: env.LOG_LEVEL ?? 'info',
    country: env.COUNTRY ?? 'DE',
    currency: env.CURRENCY ?? 'EUR',
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
