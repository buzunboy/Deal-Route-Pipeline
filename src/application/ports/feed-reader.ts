/**
 * FeedReader port — reads a community/deal feed (RSS/Atom today; a Reddit-API or
 * other adapter can implement the same port later) into normalised lead items.
 * A feed item is a LEAD, not a deal: it points at a candidate offer page that the
 * ingestion use-case triages and then extracts (Lane B, Tier 3).
 *
 * Concrete adapters live behind this port and are injected from the composition
 * root, exactly like `Fetcher`/`Llm`. Timeout-bounded; resolves to an empty list
 * (never throws) on a reachable failure so one bad feed never crashes a batch.
 */
export interface FeedItem {
  /** Item title / headline as published in the feed. */
  title: string;
  /** The link the item points to (the candidate offer/deal page). */
  link: string;
  /** Optional summary/description text from the feed (used for cheap triage). */
  summary: string;
  /** ISO-8601 publish timestamp if the feed provided one, else null. */
  publishedAt: string | null;
}

export interface FeedReadOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export interface FeedReader {
  /** Fetch + parse a feed URL into lead items (newest-first if the feed orders them). */
  read(url: string, options?: FeedReadOptions): Promise<FeedItem[]>;
}
