#!/usr/bin/env node
/**
 * CI drift gate for the generated Postman collection (docs/api/dealroute.postman_collection.json).
 *
 * `openapi-to-postmanv2` generates example bodies + param values with random fakes
 * (enum picks, synthetic numbers), so a byte-for-byte `git diff` flaps even when the
 * spec is unchanged. This script instead compares the STRUCTURAL fingerprint —
 * folders, request names, methods, URL paths, and auth types — between the committed
 * collection and a fresh regeneration from the spec. That catches what actually
 * matters (an endpoint added/removed/renamed/re-pathed, or an auth change) while
 * ignoring example noise.
 *
 * Usage: `node scripts/postman-check.mjs` — exits non-zero (and prints the diff) when
 * the committed collection is structurally out of sync with docs/api/openapi.yaml.
 * Fix by running `npm run api:postman` and committing the result.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SPEC = 'docs/api/openapi.yaml';
const COMMITTED = 'docs/api/dealroute.postman_collection.json';

/** Regenerate the collection from the spec into a temp file; return its path. */
function regenerate() {
  const out = join(mkdtempSync(join(tmpdir(), 'postman-check-')), 'fresh.json');
  execFileSync(
    'npx',
    ['openapi2postmanv2', '-s', SPEC, '-o', out, '-p', '-O', 'folderStrategy=Tags'],
    { stdio: 'pipe' },
  );
  return out;
}

/**
 * The structural fingerprint: a sorted list of `FOLDER ▸ NAME [METHOD path]` lines,
 * recursing folders. Drops every example body/value (the generator's random fakes)
 * AND the finalize-derived `auth` (a deterministic function of folder+method, so it
 * can't drift independently of those), so the fresh RAW regen and the committed
 * FINALIZED collection fingerprint identically when the spec is unchanged.
 */
function fingerprint(collection) {
  const lines = [];
  const walk = (items, prefix) => {
    for (const it of items ?? []) {
      if (it.item) {
        walk(it.item, `${prefix}${it.name} ▸ `);
        continue;
      }
      const method = it.request?.method ?? 'GET';
      const url = it.request?.url;
      const path = typeof url === 'string' ? url : (url?.path ?? []).join('/');
      lines.push(`${prefix}${it.name} [${method} ${path}]`);
    }
  };
  walk(collection.item, '');
  return lines.sort();
}

const committed = fingerprint(JSON.parse(readFileSync(COMMITTED, 'utf8')));
const fresh = fingerprint(JSON.parse(readFileSync(regenerate(), 'utf8')));

const committedSet = new Set(committed);
const freshSet = new Set(fresh);
const missing = fresh.filter((l) => !committedSet.has(l)); // in spec, not in committed
const extra = committed.filter((l) => !freshSet.has(l)); // in committed, not in spec

if (missing.length === 0 && extra.length === 0) {
  console.log(`postman-check: OK — collection is structurally in sync with ${SPEC}.`);
  process.exit(0);
}

console.error(`postman-check: DRIFT — the committed Postman collection is out of sync with ${SPEC}.`);
if (missing.length) {
  console.error('\n  In the spec but MISSING from the collection (regenerate to add):');
  for (const l of missing) console.error(`    + ${l}`);
}
if (extra.length) {
  console.error('\n  In the collection but NOT in the spec (stale — regenerate to drop):');
  for (const l of extra) console.error(`    - ${l}`);
}
console.error('\n  Fix: run `npm run api:postman` and commit docs/api/dealroute.postman_collection.json.');
process.exit(1);
