import { readFile } from 'node:fs/promises';
import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { parseSeeds } from '../../seeds/seed-parser.js';

/**
 * `seed-import [path]` — parse the German seed-list markdown and upsert Source
 * rows into the registry. Idempotent (upsert by id is fresh each run; URLs are
 * de-duplicated within a run). Defaults to docs/DealRoute_Seed_List_DE.md.
 */
export async function seedImport(config: Config, path: string, dryRun: boolean): Promise<void> {
  const markdown = await readFile(path, 'utf8');
  const { catalog, sources } = parseSeeds(markdown, config.crawl.defaultRecrawlDays);

  console.log(
    `Parsed ${catalog.length} catalog services and ${sources.length} sources from ${path}.`,
  );
  const byTier = countBy(sources, (s) => `tier ${s.tier}`);
  for (const [tier, n] of Object.entries(byTier)) console.log(`  ${tier}: ${n} sources`);

  if (dryRun) {
    console.log('\n[dry-run] No rows written. Sample:');
    for (const s of sources.slice(0, 8)) console.log(`  - [T${s.tier} ${s.type}] ${s.url}`);
    return;
  }

  const container = new Container(config, { usePersistence: true });
  try {
    for (const s of sources) {
      await container.db.sources.upsert(s);
    }
    console.log(`\nImported ${sources.length} sources into the registry.`);
  } finally {
    await container.shutdown();
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
