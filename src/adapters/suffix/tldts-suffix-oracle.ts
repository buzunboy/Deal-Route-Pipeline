import { getDomain } from 'tldts';
import type { SuffixOracle } from '../../domain/discovery/suffix-oracle.js';

/**
 * The real Public Suffix List {@link SuffixOracle}, backed by `tldts` (the PSL is
 * bundled in the package — no network, no runtime file read; the version is pinned
 * exactly in package.json so the suffix snapshot can't shift under us without a
 * reviewed bump). The ONE place the pipeline depends on a PSL vendor; the domain
 * layer sees only the `SuffixOracle` function type, so this is swappable here alone.
 *
 * Options:
 *  - `allowPrivateDomains: false` — use the ICANN section only, so a host on a
 *    *private* suffix (e.g. `foo.github.io`) folds to the registrable domain
 *    `github.io` rather than treating each subdomain as its own site. That matches
 *    "the same website" for our dedupe/reliability joins.
 *  - `validateHostname: true` — a malformed host yields `null` (folded to the
 *    UNKNOWN/neutral path downstream) rather than a bogus string.
 *
 * Returns `null` for a host with no registrable domain (IP literal, `localhost`,
 * unparseable URL) — callers treat that as "unknown source" / neutral reliability.
 */
export const tldtsSuffixOracle: SuffixOracle = (url) =>
  getDomain(url, { allowPrivateDomains: false, validateHostname: true });
