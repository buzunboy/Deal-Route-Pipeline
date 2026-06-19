import { readFile } from 'node:fs/promises';
import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { formatCandidate } from '../format.js';

/**
 * `dry-run-extract <url|file>` — fetch + extract one source with NO writes.
 *
 * Accepts a public URL (fetched via the configured fetcher) or a local
 * `.html`/`.txt`/`.md` fixture path (read directly, skipping the fetcher so it
 * works offline). Prints the candidate deal record(s) with fields, conditions,
 * grounding, confidence, rule failures, and proposals. The acceptance-criteria
 * demo and the `dry-run-extract` skill both use this path.
 */
export async function dryRunExtract(config: Config, target: string): Promise<void> {
  // No persistence: in-memory DB + queue, real fetcher + LLM + evidence store.
  const container = new Container(config, { usePersistence: false });
  try {
    const { pageText, sourceUrl } = await loadPageText(container, target);
    if (pageText.trim() === '') {
      console.log('No page text obtained (page may be login-gated, blocked, or empty).');
      return;
    }

    const result = await container.extract.execute({
      pageText,
      sourceUrl,
      targetService: null,
      vocabulary: container.vocabulary,
    });

    console.log(`\nExtracted ${result.candidates.length} candidate(s) from ${sourceUrl}`);
    console.log(`Estimated LLM cost: €${result.costEur.toFixed(6)}`);
    for (let i = 0; i < result.candidates.length; i++) {
      console.log(formatCandidate(result.candidates[i]!, i));
    }
    if (result.candidates.length === 0) {
      console.log('\n(No offers found on this page — a valid outcome.)');
    }
    console.log('\nDry-run complete. Nothing was written to the database or evidence store.');
  } finally {
    await container.shutdown();
  }
}

async function loadPageText(
  container: Container,
  target: string,
): Promise<{ pageText: string; sourceUrl: string }> {
  if (isLocalFile(target)) {
    const raw = await readFile(target, 'utf8');
    return { pageText: raw, sourceUrl: `file://${target}` };
  }
  const fetched = await container.fetcher.fetch(target);
  if (fetched.outcome !== 'ok') {
    console.log(`Fetch outcome: ${fetched.outcome}${fetched.error ? ` (${fetched.error})` : ''}`);
    if (
      fetched.outcome === 'login_required' ||
      fetched.outcome === 'blocked' ||
      fetched.outcome === 'captcha'
    ) {
      console.log('→ In a real crawl this would be routed to the manual-capture queue.');
    }
  }
  return { pageText: fetched.text, sourceUrl: fetched.finalUrl };
}

function isLocalFile(target: string): boolean {
  return /\.(html?|txt|md)$/i.test(target) && !/^https?:\/\//i.test(target);
}
