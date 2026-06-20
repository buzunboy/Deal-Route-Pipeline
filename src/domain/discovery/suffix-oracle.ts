/**
 * The Public Suffix List oracle (Step 6 — multi-country).
 *
 * A PURE, SYNCHRONOUS function from a URL to its registrable domain (eTLD+1), or
 * `null` when the host has no registrable domain (an IP, `localhost`, an
 * unparseable URL). This is a DOMAIN-layer TYPE with ZERO imports — no vendor, no
 * data — so trust-critical domain rules can depend on the signature without the
 * domain layer ever importing the Public Suffix List itself. The composition root
 * builds a concrete oracle (the `tldts` adapter) and threads it in.
 *
 * Why a registrable domain, and why a real PSL: dedupe, the reliability join, and
 * the monitor-expiry join all key "the same website" off the registrable domain.
 * The naive "last two labels" rule is correct for single-label suffixes (`.de`)
 * but WRONG for multi-label ones — `www.bbc.co.uk` is `bbc.co.uk`, not `co.uk`.
 * A real PSL is the only correct way to know `co.uk` is a public suffix.
 *
 * Why SYNC matters: the registrable domain feeds `Array.sort` comparators (the
 * published-feed ranking) and pure dedupe rules, which cannot `await`. The oracle
 * is invoked at write/index-build boundaries (O(n) once), never inside a comparator
 * — and keeping it sync makes that structurally enforced.
 */
export type SuffixOracle = (url: string) => string | null;
