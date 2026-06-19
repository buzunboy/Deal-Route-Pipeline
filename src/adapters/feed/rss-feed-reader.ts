import type { FeedReader, FeedItem, FeedReadOptions } from '../../application/ports/index.js';
import { withAbortableTimeout, TimeoutError } from '../shared/retry.js';

/**
 * No-dependency RSS/Atom feed reader (the `FeedReader` port's default adapter).
 *
 * Tier-3 community sources (mydealz, DealDoktor, Schnäppchenfuchs, Mein-Deal,
 * dealbunny) publish RSS/Atom; we parse the common subset (`<item>`/`<entry>`
 * title + link + description/summary + date) rather than pull a vendor XML lib.
 * A Reddit-API or fuller parser can replace this behind the same port.
 *
 * Resolves to `[]` (never throws) on a reachable failure so one bad feed never
 * crashes an ingestion batch (resilience invariant).
 */
export class RssFeedReader implements FeedReader {
  constructor(private readonly defaultTimeoutMs: number) {}

  async read(url: string, options: FeedReadOptions = {}): Promise<FeedItem[]> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const res = await withAbortableTimeout(
        (signal) =>
          fetch(url, {
            headers: {
              'user-agent': options.userAgent ?? 'DealRouteBot/0.1',
              accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
            },
            signal,
          }),
        timeoutMs,
      );
      if (!res.ok) return [];
      const xml = await res.text();
      return parseFeed(xml);
    } catch (err) {
      if (err instanceof TimeoutError) return [];
      // Unreachable/parse failure: empty feed, not a crash.
      return [];
    }
  }
}

/** Parse RSS `<item>`s or Atom `<entry>`s into normalised feed items. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = matchAllBlocks(xml, 'item');
  const isAtom = blocks.length === 0;
  const entries = isAtom ? matchAllBlocks(xml, 'entry') : blocks;

  const items: FeedItem[] = [];
  for (const block of entries) {
    const title = decode(stripTags(tagText(block, 'title')));
    const link = isAtom ? atomLink(block) : decode(stripTags(tagText(block, 'link')));
    if (link.trim() === '') continue; // a lead with no link is useless
    const summary = decode(
      stripTags(tagText(block, isAtom ? 'summary' : 'description') || tagText(block, 'content')),
    );
    const publishedAt = normalizeDate(
      tagText(block, 'pubDate') || tagText(block, 'updated') || tagText(block, 'published'),
    );
    items.push({ title, link: link.trim(), summary, publishedAt });
  }
  return items;
}

/** All `<tag …>…</tag>` inner blocks (non-greedy, case-insensitive). */
function matchAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

/** Inner text of the first `<tag>…</tag>` in a block, unwrapping CDATA. */
function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Atom `<link href="…">` (prefer rel="alternate"); falls back to any href. */
function atomLink(block: string): string {
  const alt = /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(block);
  if (alt) return decode(alt[1]!);
  const any = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
  return any ? decode(any[1]!) : '';
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

/** Decode the handful of XML entities that appear in feed text. */
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Best-effort RFC-822 / ISO date → ISO-8601, or null if unparseable. */
function normalizeDate(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
