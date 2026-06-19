import { describe, it, expect } from 'vitest';
import { parseFeed } from './rss-feed-reader.js';

describe('parseFeed — RSS 2.0', () => {
  const rss = `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <title>Feed</title>
    <item>
      <title><![CDATA[Disney+ 3 Monate gratis]]></title>
      <link>https://www.mydealz.de/deals/disney-123</link>
      <description>Bei Telekom: Disney+ inklusive im Tarif &amp; gratis.</description>
      <pubDate>Wed, 18 Jun 2026 10:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Phone deal</title>
      <link>https://www.mydealz.de/deals/phone-456</link>
      <description>Cheap phone</description>
    </item>
  </channel></rss>`;

  it('parses items: title (CDATA), link, description, date', () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Disney+ 3 Monate gratis');
    expect(items[0]!.link).toBe('https://www.mydealz.de/deals/disney-123');
    expect(items[0]!.summary).toContain('Disney+ inklusive');
    expect(items[0]!.summary).toContain('&'); // entity decoded
    expect(items[0]!.publishedAt).toBe('2026-06-18T10:00:00.000Z');
    expect(items[1]!.publishedAt).toBeNull();
  });
});

describe('parseFeed — Atom', () => {
  const atom = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>Spotify Aktion</title>
      <link rel="alternate" href="https://dealdoktor.de/spotify-deal"/>
      <link rel="self" href="https://dealdoktor.de/feed"/>
      <summary>Spotify Premium gratis testen</summary>
      <updated>2026-06-17T08:00:00Z</updated>
    </entry>
  </feed>`;

  it('parses entries and prefers rel="alternate" links', () => {
    const items = parseFeed(atom);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Spotify Aktion');
    expect(items[0]!.link).toBe('https://dealdoktor.de/spotify-deal');
    expect(items[0]!.summary).toBe('Spotify Premium gratis testen');
  });
});

describe('parseFeed — robustness', () => {
  it('returns [] for non-feed input', () => {
    expect(parseFeed('<html><body>not a feed</body></html>')).toEqual([]);
  });

  it('skips items with no link', () => {
    const rss = `<rss><channel><item><title>No link</title></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual([]);
  });
});
