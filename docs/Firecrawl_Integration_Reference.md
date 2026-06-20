# Firecrawl — integration reference (official guideline, saved 2026-06-20)

_Official Firecrawl onboarding guideline, saved for review/reuse. DealRoute uses
Firecrawl in two narrow places (see "How DealRoute uses it" below) — NOT the full
CLI/skills/workflows surface. This doc is the source-of-truth reference; the API
key lives only in the gitignored `.env` (env `FIRECRAWL_API_KEY`), never committed._

> Human-readable source: https://docs.firecrawl.dev · AI onboarding:
> https://docs.firecrawl.dev/ai-onboarding · Skills repo: https://github.com/firecrawl/skills

---

## How DealRoute uses Firecrawl (what's actually wired)

DealRoute is **Path E** (use the REST API directly, no CLI/skills install). It calls
Firecrawl from code, behind ports, in exactly two adapters:

1. **`FirecrawlFetcher`** (`src/adapters/fetcher/firecrawl-fetcher.ts`) — a `Fetcher`
   adapter (vendor scrape). Selected by `FETCHER=firecrawl`. Wrapped by `PoliteFetcher`
   like every other fetcher (robots + rate-limit + size caps still apply).
2. **`FirecrawlSearchProvider`** (`src/adapters/search/firecrawl-search-provider.ts`) —
   a `SearchProvider` adapter using Firecrawl `/v2/search` (+ optional inline scrape).
   Selected by `SEARCH_PROVIDER=firecrawl`. Backs the Tier-4 broad-discovery lane
   (`discover --broad`, `AGENT=search`).

Both are injected from the single composition root and are swappable. The agentic lane
stays dark by default (`AGENT=noop`, `SEARCH_PROVIDER=stub`).

**Base URL:** `https://api.firecrawl.dev/v2` — both adapters are on **v2** (refactored
2026-06-20). Search returns `data.web[]` (`{url,title,description,position}`); scrape returns
`data.{markdown,html,screenshot,metadata}`; both zod-validated at the boundary.
**Inline search-scrape (v2 value-add):** `/v2/search` with `scrapeOptions:{formats:[...]}` returns
page content per result. We expose it on `SearchResult.content` and the Tier-4 agent reuses it
(saving a fetch) ONLY behind our own robots/rate-limit gate (`PoliteFetcher.checkAccess`) — opt-in
via `AGENT_INLINE_SCRAPE=true` (default off). **Auth header:** `Authorization: Bearer fc-YOUR_API_KEY`.

### Tier-4 enablement (Path E, from `.env`)
```
AGENT=search                 # turns ON Tier-4 (default noop = off)
SEARCH_PROVIDER=firecrawl     # use Firecrawl search as the backend
FIRECRAWL_API_KEY=fc-...      # the key (gitignored .env only)
```
Guardrails (defaults safe; tighten as needed): `AGENT_MAX_STEPS`, `DISCOVERY_MAX_QUERIES`,
`AGENT_MAX_COST_EUR`, `DAILY_BUDGET_EUR`. Nothing auto-publishes; no discovered domain is
auto-crawled (novel domains → proposed sources for human approval).

---

## The three skill segments (full Firecrawl surface — for reference, not all installed)

One install command sets up everything: `npx -y firecrawl-cli@latest init --all --browser`

| Segment | Question it answers | Where it runs |
| ------- | ------------------- | ------------- |
| **CLI skills** (`firecrawl/cli`) | "Which Firecrawl command should I run right now?" | the agent's own terminal session |
| **Build skills** (`firecrawl/skills`) | "How do I add a Firecrawl API call to this codebase?" | inside the user's product code |
| **Workflow skills** (`firecrawl/firecrawl-workflows`) | "What's the finished deliverable and how do I produce it?" | the agent's session, producing an artifact |

### Choosing a path
- **Need web data during this session** → Path A (live CLI tools: `firecrawl search`/`scrape`/`interact`/`crawl`/`map`/`ask`/`docs-search`)
- **Add Firecrawl to app code** → Path B (build skills; `firecrawl-build*`)
- **Finished deliverable from web data** → Path C (workflow skills; `firecrawl-workflows`)
- **Need an account/API key** → Path D (browser/CLI auth) or WorkOS ID-JAG on supported platforms
- **No install** → **Path E (REST API directly)** ← this is DealRoute's path

### Path A default flow (live web work)
1. search when you need discovery → 2. scrape when you have a URL → 3. interact only when the page needs clicks/forms/login → 4. if a step fails, run `firecrawl ask` with the failing `jobId` instead of guessing.

### Path E — REST endpoints (v2)
- `POST /search` — discover pages by query (+ optional full-page content)
- `POST /scrape` — clean markdown from a single URL
- `POST /interact` — browser actions (clicks, forms, navigation)
- `POST /parse` — parse local/non-public document files (PDF/DOCX/XLSX…)
- `POST /crawl` — bulk extraction · `POST /map` — URL discovery
- `POST /support/ask` — diagnose a failing call (`{ question, jobId? }` → prose `answer` + machine `fixParameters`)
- `POST /support/docs-search` — answer "how do I…" from official docs (`{ question }` → answer + citations)

### Path D — get an API key (browser/CLI auth, summary)
PKCE flow: generate `SESSION_ID` + `CODE_VERIFIER`/`CODE_CHALLENGE`; have the human open
`https://www.firecrawl.dev/cli-auth?code_challenge=$CODE_CHALLENGE&source=coding-agent#session_id=$SESSION_ID`;
poll `POST https://www.firecrawl.dev/api/auth/cli/status` with `{session_id, code_verifier}`
every 3s until `{"status":"complete","apiKey":"fc-..."}`. Save to `.env` (gitignored).
Sign-up (human): https://www.firecrawl.dev/signin?view=signup

### Install verification (if the CLI is ever installed)
```
mkdir -p .firecrawl
firecrawl --status
firecrawl scrape "https://firecrawl.dev" -o .firecrawl/install-check.md
```

---

## Notes for DealRoute
- We do **not** install the CLI/skills — we call the REST API behind our own ports
  (Path E). Keep it that way: vendor stays behind `Fetcher`/`SearchProvider`, injected
  from the composition root (architecture invariant: no `new VendorClient()` in business logic).
- The Firecrawl key is a secret → `.env` only (env `FIRECRAWL_API_KEY`), never committed,
  same handling as the LLM keys.
- `firecrawl ask`/`docs-search` (the support endpoints) are a good escalation path if a
  Firecrawl call fails in production — pass the failing `jobId`.
