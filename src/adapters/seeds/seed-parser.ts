import { newId } from '../../application/shared/id.js';
import type { Source, SourceType, SourceTier } from '../../domain/index.js';

/** A parsed catalog entry (Tier-1 target subscription + its provider page). */
export interface CatalogEntry {
  service: string;
  category: string;
  providerUrl: string;
}

export interface ParsedSeeds {
  catalog: CatalogEntry[];
  sources: Source[];
}

/**
 * Parse the German seed-list markdown (`docs/DealRoute_Seed_List_DE.md`) into
 * catalog entries + Source rows. Pure (no I/O) so it is unit-testable against the
 * real doc. Only well-formed table rows with a URL are imported; commentary rows
 * ("Explore: …") are skipped. Tiers/types follow the doc's sections.
 */
export function parseSeeds(markdown: string, cadenceDays: number): ParsedSeeds {
  const lines = markdown.split('\n');
  const catalog: CatalogEntry[] = [];
  const sources: Source[] = [];
  const seenUrls = new Set<string>();

  let section: 'catalog' | 'bundler' | 'aggregator' | 'community' | null = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+([A-E])\.\s/);
    if (heading) {
      section = sectionFor(heading[1]!);
      continue;
    }
    if (section === null || !line.trim().startsWith('|')) continue;

    const cells = splitRow(line);
    if (cells.length < 2 || isHeaderOrDivider(cells)) continue;

    if (section === 'catalog') {
      const entry = parseCatalogRow(cells);
      if (entry) {
        // Normalize the catalog's provider URL up front (the doc lists bare hosts
        // like `netflix.com/de`). The CatalogEntry feeds `subscription.provider_url`
        // (`z.string().url()`), so it MUST carry a scheme — store the normalized form,
        // not the raw cell, and drop a row whose cell isn't a usable URL.
        const url = ensureUrl(entry.providerUrl);
        if (!url) continue;
        catalog.push({ ...entry, providerUrl: url });
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          sources.push(makeSource(url, 'provider', 1, entry.service, cadenceDays));
        }
      }
      continue;
    }

    // Bundler / aggregator / community sections: first cell = name, find a URL cell.
    const url = ensureUrl(findUrlCell(cells));
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const { type, tier } = sourceMetaFor(section);
    sources.push(makeSource(url, type, tier, null, cadenceForSection(section, cadenceDays)));
  }

  return { catalog, sources };
}

function sectionFor(letter: string): 'catalog' | 'bundler' | 'aggregator' | 'community' | null {
  switch (letter) {
    case 'A':
      return 'catalog';
    case 'B':
      return 'bundler';
    case 'C':
      return 'aggregator';
    case 'D':
      return 'community';
    default:
      return null; // E = broad discovery, no fixed list
  }
}

function sourceMetaFor(section: 'bundler' | 'aggregator' | 'community'): {
  type: SourceType;
  tier: SourceTier;
} {
  switch (section) {
    case 'bundler':
      return { type: 'bundler', tier: 2 };
    case 'aggregator':
      return { type: 'aggregator', tier: 2 };
    case 'community':
      return { type: 'community', tier: 3 };
  }
}

/** Community (Tier 3) is more time-sensitive → shorter cadence. */
function cadenceForSection(section: string, defaultDays: number): number {
  return section === 'community' ? Math.min(defaultDays, 1) : defaultDays;
}

function parseCatalogRow(cells: string[]): CatalogEntry | null {
  // Columns: # | Service | Category | Provider (DE)
  if (cells.length < 4) return null;
  const service = cells[1]!.trim();
  const category = cells[2]!.trim();
  const providerUrl = cells[3]!.trim();
  if (!service || service === 'Service' || !providerUrl) return null;
  return { service, category, providerUrl };
}

function makeSource(
  url: string,
  type: SourceType,
  tier: SourceTier,
  service: string | null,
  cadenceDays: number,
): Source {
  return {
    id: newId(),
    url,
    type,
    tier,
    country: 'DE',
    subscription_service: service,
    cadence_days: cadenceDays,
    reliability_score: 0.5,
    status: 'active',
    last_seen: null,
    next_due: null,
    resolved_url: null, // set on the first successful crawl (= the post-redirect finalUrl)
    // The parser is pure (no PSL); seed-import pins registrable_domain via the
    // container's oracle right before upsert (it must — else seeds join to neutral
    // reliability). See seed-import.ts. Null here is just the pre-pin placeholder.
    registrable_domain: null,
    // Seed sources are curated by hand, not surfaced through the discovery proposal
    // loop, so they carry no "why proposed" rationale (ACR-15).
    proposal_reason: null,
  };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isHeaderOrDivider(cells: string[]): boolean {
  const joined = cells.join('');
  if (/^[-:\s]+$/.test(joined)) return true; // divider row
  return cells.some((c) => c === 'Service' || c === 'Source' || c === 'URL');
}

function findUrlCell(cells: string[]): string {
  for (const cell of cells) {
    const url = extractFirstUrlToken(cell);
    if (url) return url;
  }
  return '';
}

/** Cells may contain "telekom.de/x · telekom.de/y" — take the first token. */
function extractFirstUrlToken(cell: string): string {
  const token = cell.split(/[·,\s]+/).find((t) => /\.[a-z]{2,}/i.test(t) && !t.includes('—'));
  return token ?? '';
}

function ensureUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '—' || !/\.[a-z]{2,}/i.test(trimmed)) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
