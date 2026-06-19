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
    kind: z.enum(['playwright', 'firecrawl']),
    timeoutMs: z.coerce.number().int().positive(),
    userAgent: z.string().min(1),
    firecrawlApiKey: z.string().optional(),
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
      })
      .optional(),
  }),
  // DB/queue URLs are optional at parse time: the offline path (dry-run, tests,
  // stub) uses in-memory adapters and needs no Postgres (README: "Dry-run and
  // tests need neither"). The composition root enforces their presence loudly
  // only when it actually constructs the Postgres / pg-boss adapters.
  database: z.object({
    url: z.string(),
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
    maxSteps: z.coerce.number().int().positive(),
    maxSeconds: z.coerce.number().int().positive(),
    maxCostEur: z.coerce.number().nonnegative(),
  }),
  reviewApi: z.object({
    port: z.coerce.number().int().positive(),
    /** Bearer token gating approve/reject. Unset ⇒ open (bind to a trusted network). */
    authToken: z.string().min(1).optional(),
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
          }
        : undefined,
    },
    database: { url: env.DATABASE_URL ?? '' },
    queue: { databaseUrl: emptyToUndefined(env.QUEUE_DATABASE_URL) ?? env.DATABASE_URL ?? '' },
    crawl: {
      defaultRecrawlDays: env.DEFAULT_RECRAWL_DAYS ?? '3',
      perDomainRateLimitMs: env.PER_DOMAIN_RATE_LIMIT_MS ?? '2000',
      respectRobotsTxt: env.RESPECT_ROBOTS_TXT ?? 'true',
    },
    agent: {
      maxSteps: env.AGENT_MAX_STEPS ?? '25',
      maxSeconds: env.AGENT_MAX_SECONDS ?? '300',
      maxCostEur: env.AGENT_MAX_COST_EUR ?? '1.00',
    },
    reviewApi: {
      port: env.REVIEW_API_PORT ?? '3000',
      authToken: emptyToUndefined(env.REVIEW_API_TOKEN),
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
