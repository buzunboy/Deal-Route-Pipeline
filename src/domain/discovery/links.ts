/**
 * Pure link rules for site discovery (Lane B) — domain logic, no I/O and no
 * vendor/framework imports. Given a page's HTML and its URL, return the absolute,
 * http(s), de-fragmented links; classify "same registrable domain" so the
 * discovery use-case can decide what to follow vs propose for human approval.
 */

/** Absolute http(s) links found on a page, de-duplicated and fragment-stripped. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const base = safeUrl(baseUrl);
  if (base === null) return [];
  const seen = new Set<string>();
  // Only follow NAVIGATION links: <a href="…">. Matching bare `href` would also
  // pull <link rel=stylesheet/icon> and other asset refs, wasting the page budget
  // on CSS/JS/favicons. The agentic lane (Phase C) handles JS-only nav.
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1]!.trim();
    if (raw === '' || raw.startsWith('#') || isNonHttpScheme(raw)) continue;
    const resolved = safeUrl(raw, base);
    if (resolved === null) continue;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (isAssetPath(resolved.pathname)) continue; // skip .css/.js/images/etc.
    resolved.hash = '';
    seen.add(resolved.toString());
  }
  return [...seen];
}

/**
 * Heuristic "is this likely a deal/offer page?" score (higher = visit sooner).
 * Domain-agnostic — based on URL shape, not a hardcoded site path — so the
 * frontier prioritises content pages over navigation chrome and the limited page
 * budget isn't spent on `/login`, `/feed`, category indexes, etc.
 */
export function scoreCandidateUrl(url: string): number {
  const u = safeUrl(url);
  if (u === null) return 0;
  const path = u.pathname.toLowerCase().replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return 0; // the site root / landing page

  let score = 0;
  const last = segments[segments.length - 1]!;

  // Long, hyphenated, often id-bearing slugs read as individual offer/article pages.
  if (last.length >= 20) score += 3;
  if ((last.match(/-/g)?.length ?? 0) >= 3) score += 2;
  if (/\d{3,}/.test(last)) score += 2; // a numeric id in the slug
  score += Math.min(segments.length, 3); // deeper paths over shallow nav

  // Obvious navigation / utility / non-offer sections.
  if (NAV_SEGMENT.test(path)) score -= 5;
  return score;
}

const NAV_SEGMENT =
  /(^|\/)(login|signin|signup|register|account|profile|feed|rss|search|tag|tags|category|categories|kategorie|gruppe|gutscheine|alerts?|hilfe|help|faq|impressum|datenschutz|agb|privacy|terms|about|ueber|kontakt|contact|jobs?|careers?|presse|press|sitemap|cart|warenkorb|wishlist|settings|cookie)(\/|$)/;

/** Static-asset paths we never treat as crawlable pages. */
const ASSET_EXT =
  /\.(css|js|mjs|json|xml|rss|txt|map|png|jpe?g|gif|svg|webp|ico|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|zip|gz)$/i;

function isAssetPath(pathname: string): boolean {
  return ASSET_EXT.test(pathname);
}

/**
 * True when two URLs share a registrable domain (eTLD+1 approximation): we
 * compare the last two labels of the host (e.g. `www.mydealz.de` ~ `mydealz.de`).
 * This intentionally treats subdomains of the same site as "same site" so a
 * discovery run started at a deal page can follow the site's own listing pages.
 * Not a full Public Suffix List — adequate for the .de single-country v1; a PSL
 * adapter can replace this behind the same function if multi-country needs it.
 */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return ra !== null && ra === rb;
}

export function registrableDomain(url: string): string | null {
  const u = safeUrl(url);
  if (u === null) return null;
  const labels = u.hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

export function hostOf(url: string): string | null {
  const u = safeUrl(url);
  return u === null ? null : u.host;
}

/**
 * Canonical visited-key form for a URL: parsed + re-serialised (lowercased host,
 * default ports dropped) with the fragment removed — so the seed URL and a page's
 * own self-links collapse to one key and aren't fetched twice. Returns the input
 * unchanged if it can't be parsed.
 */
export function normalizeUrl(url: string): string {
  const u = safeUrl(url);
  if (u === null) return url;
  u.hash = '';
  return u.toString();
}

function safeUrl(url: string, base?: URL): URL | null {
  try {
    return base ? new URL(url, base) : new URL(url);
  } catch {
    return null;
  }
}

function isNonHttpScheme(href: string): boolean {
  return /^(mailto:|tel:|javascript:|data:)/i.test(href);
}
