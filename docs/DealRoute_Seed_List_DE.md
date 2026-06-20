# DealRoute — Seed List (Germany v1)

> **📍 Reference data (EVERGREEN / LIVING).** The DE seed sources the deterministic lane
> crawls; the discovery lane proposes additions a human approves. Update as sources are
> added/pruned. (Imported via `seed-import` / the `add-source` skill.)

*Starter sources for the crawl pipeline. **Draft to verify** — the deterministic lane crawls these; the agentic discovery lane expands & maintains the list over time. Default re-crawl cadence: **every 3 days + on-demand**. Public pages only in v1 (login-gated perks → manual capture). Verify exact pricing-page paths at build time; respect each site's robots.txt/ToS.*

---

## A. Target subscriptions (catalog) + provider pages — Tier 1
The 25 services to find routes for. Provider URLs give the **standard/reference price** (standalone, annual, student, with-ads). Start at the German site; the crawler should locate the pricing/plans page.

| # | Service | Category | Provider (DE) |
|---|---|---|---|
| 1 | Netflix | Video | netflix.com/de |
| 2 | Disney+ | Video | disneyplus.com/de-de |
| 3 | Amazon Prime Video | Video | amazon.de/prime |
| 4 | WOW (Sky) | Video | wow.de |
| 5 | DAZN | Sport | dazn.com/de-DE |
| 6 | Paramount+ | Video | paramountplus.com/de |
| 7 | Apple TV+ | Video | tv.apple.com |
| 8 | RTL+ | Video | plus.rtl.de |
| 9 | Crunchyroll | Anime | crunchyroll.com/de |
| 10 | Spotify | Music | spotify.com/de |
| 11 | Apple Music | Music | music.apple.com |
| 12 | YouTube Premium | Music/Video | youtube.com/premium |
| 13 | Amazon Music Unlimited | Music | amazon.de/music |
| 14 | Deezer | Music | deezer.com/de |
| 15 | NordVPN | VPN | nordvpn.com/de |
| 16 | Surfshark | VPN | surfshark.com/de |
| 17 | CyberGhost | VPN | cyberghostvpn.com/de |
| 18 | Proton (VPN/Unlimited) | VPN/Privacy | proton.me |
| 19 | ChatGPT Plus | AI | openai.com/chatgpt/pricing |
| 20 | Microsoft 365 | Productivity | microsoft.com/de-de/microsoft-365 |
| 21 | Adobe Creative Cloud | Creative | adobe.com/de |
| 22 | Google One | Storage | one.google.com |
| 23 | Audible | Audiobooks | audible.de |
| 24 | Xbox Game Pass | Gaming | xbox.com/de-DE/xbox-game-pass |
| 25 | PlayStation Plus | Gaming | playstation.com/de-de/ps-plus |

*(Refine this set with your real waitlist demand once signups arrive — the "which subscription" field in the form is exactly for this.)*

---

## B. Bundler sources — Tier 2 (the differentiator: where hidden routes live)

**Telco** — streaming bundled with mobile/home:
| Source | URL | What to look for |
|---|---|---|
| Telekom MagentaTV / MagentaEINS | telekom.de/magenta-tv · telekom.de/magenta-eins | Netflix, Disney+, Apple TV+, RTL+ included in SmartStream/MegaStream; promos (e.g. 6 mo free, cashback) |
| Vodafone GigaKombi / GigaTV | vodafone.de | Streaming add-ons, OneNumber, combi discounts |
| O2 (Telefónica) | o2online.de | Netflix/Disney+ at discount; O2 Priority perks |
| 1&1 | 1und1.de | TV/streaming add-ons |
| congstar | congstar.de | Promo bundles |
| waipu.tv / Freenet | waipu.tv | TV-streaming bundles + perks |

**Fintech / bank** — perks inside paid account tiers:
| Source | URL | What to look for |
|---|---|---|
| Revolut | revolut.com/de-de | Plus/Premium/Metal/Ultra perks; NordVPN via Revolut Mobile; lounge/insurance |
| N26 | n26.com/de-de | You/Metal partner offers |
| Trade Republic | traderepublic.com | Cashback / card perks |
| American Express DE | americanexpress.com/de | Amex Offers, Membership Rewards |
| PayPal DE | paypal.com/de | Offers / cashback |
| *Explore:* C24 Bank, DKB, Comdirect, bunq, Vivid, Bitpanda | — | Tier perks & partner offers |

**Retail / loyalty** — subscriptions bundled into memberships/promos:
| Source | URL | What to look for |
|---|---|---|
| Amazon Prime | amazon.de/prime | Bundled Music/Photos; Prime-exclusive offers |
| Payback | payback.de | Partner subscription promos |
| DeutschlandCard | deutschlandcard.de | Partner offers |
| Lidl Plus | lidl.de/c/lidl-plus | App-only promos |
| MediaMarkt / Saturn | mediamarkt.de · saturn.de | Club perks, hardware+sub bundles |
| NeoTaste · Lieferando Plus | neotaste.com · lieferando.de | Cross-promo free months |

---

## C. Comparison / aggregator sources — great for discovering routes & reference prices
| Source | URL | Why |
|---|---|---|
| CHECK24 | check24.de | Compares DSL/TV/mobile **bundles** + banking — surfaces bundle routes |
| Verivox | verivox.de | Telco/streaming tariff comparison |
| JustWatch | justwatch.com | Streaming availability + offers (German company) — good for video routes/prices |

---

## D. Deal communities — Tier 3 (time-limited / undocumented offers → treat as leads)
| Source | URL | How to ingest |
|---|---|---|
| mydealz | mydealz.de | Keyword search/RSS for your 25 services × "Bundle / inklusive / gratis / Aktion"; agent triages |
| DealDoktor | dealdoktor.de | Curated, high signal — newsletter/RSS |
| Schnäppchenfuchs | schnaeppchenfuchs.com | Categories + search |
| Mein-Deal.com | mein-deal.com | Search/RSS |
| dealbunny | dealbunny.de | Search/RSS |
| Reddit | r/Finanzen · r/de · r/germany | Keyword search via API |
| *Explore:* Telegram/WhatsApp deal channels | — | Manual/assisted at first |

---

## E. Broad discovery — Tier 4 (no fixed list)
Handled by the **agentic lane**, not a seed list: scheduled searches like *"[service] im Bundle / inklusive / gratis / Aktion / perk"*, *"[provider] Vorteil/Partner"*. Novel offers → candidates; **novel domains → proposed sources for your approval** before they join the deterministic crawl.

---

### Notes
- **Cadence:** default re-crawl every 3 days; promos/community more sensitive — allow on-demand and near-expiry rechecks.
- **Maintenance:** this is a v1 starting point; expect to prune dead links and let discovery add sources. Reliability score per source decides cadence and trust.
- **Legal/политeness:** public pages only; respect robots.txt/ToS; store our own screenshot + source link rather than republishing full T&C; affiliate disclosure (Omnibus) at publish.

*Sources for bundler/community research: telekom.de, o2online.de, vodafone.de, revolut.com, n26.com; mydealz.de, dealdoktor.de, schnaeppchenfuchs.com, mein-deal.com; check24.de, verivox.de, justwatch.com (2026).*
