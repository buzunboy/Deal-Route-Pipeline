# HTTP API & OpenAPI spec (always applies)

The HTTP surface (`/api/*` gated admin, `/v1/*` public read, the `/` test page) is a
**contract** the admin panel and landing page (separate repos) depend on. The contract
lives in **`docs/api/openapi.yaml`** — the single source of truth — with a generated
Postman collection at `docs/api/dealroute.postman_collection.json`.

## The rule: spec changes WITH the code (same commit)

When you add, remove, or change **any** of the following, update `docs/api/openapi.yaml`
in the **same change** — never a follow-up:

- a route (new path, new method on an existing path, a removed/renamed route);
- a request shape (body fields, query params, path params, required-ness, enums, bounds);
- a response shape (fields, status codes, the public DTO's allow-list);
- auth behaviour (what's gated, the bearer header), CORS, or error/status mapping.

These map to `src/adapters/http/` (`review-api.ts`, `public-api.ts`, `public-dto.ts`),
the request zod schemas in `review-api.ts`, and the query/enum types in
`src/domain/deal-record/` (`published-query.ts`, `candidate-query.ts`, `enums.ts`). If you
touched one of those, assume the spec needs touching too.

## After editing the spec

```sh
npm run api:lint       # redocly lint — must stay valid (warnings ok; errors not)
npm run api:postman    # regenerate the Postman collection from the spec (don't hand-edit it)
```

Commit BOTH `openapi.yaml` and the regenerated `dealroute.postman_collection.json`. The
collection is generated output — edit the spec, never the JSON.

**CI enforces this.** The `check` job runs `npm run api:check` (= `api:lint` +
`api:postman:check`). `api:postman:check` regenerates the collection and compares its
STRUCTURE (folders, request names, methods, URL paths) to the committed file — so an
endpoint added/renamed/removed in the spec but not regenerated **fails CI**. (It compares
structure, not bytes, because the generator fakes random example values; `postman-finalize`
strips the random ids so the committed file is otherwise stable.) If CI flags drift, run
`npm run api:postman` and commit the result.

The drift gate is **structure-only** — it catches an endpoint added/renamed/removed/re-pathed,
NOT a changed request-body field, query param, response shape, or status code. Those are
guarded by the endpoint's own HTTP unit + integration tests (this section's accuracy bar +
`testing.md`), not by `api:check`.

## Accuracy bar

- The spec must describe what the code **actually does**, not the intent. Mirror the real
  zod bounds (e.g. `limit` max 100 public / 200 candidates), the real enums (`DealStatus`,
  `RouteType`, `PublishedSort`, market-driven `Country`/`Currency`), and the real status
  codes (401 unauth, 409 not-reviewable, 413 too-large, 400 validation, 404 not-found).
- The **public DTO is a trust boundary**: `PublicDeal` in the spec must stay an allow-list
  that matches `public-dto.ts` — it must NOT gain an internal field (status, confidence,
  grounding, attributes, raw_conditions_text, evidence_id, verified_by, condition
  source_quote). If you add a field to the DTO, add it to the spec; if you add an internal
  field to the deal record, it must NOT appear in `PublicDeal`.
- New write endpoints are Bearer-gated and documented with `security: [bearerAuth: []]`;
  read endpoints stay open (`security: []`).

## New external edge

A new endpoint is also a new external edge — it still needs the tests `testing.md`
requires (HTTP-level unit tests in the adapter, an integration test through the real
Container, boundary/adversarial tests for any parsed body). The spec is documentation of
the contract, not a substitute for those tests.
