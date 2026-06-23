# Admin-Panel handoff — evidence artifacts now come from a gated AUTHED endpoint

**For:** the Admin-Panel project (separate repo). **From:** the DealRoute pipeline.
**Date:** 2026-06-23.

> **TL;DR:** the evidence screenshot / HTML / terms now load from a **Bearer-gated**
> endpoint, NOT the public CDN. The `GET /api/candidates` evidence URLs changed:
> `evidence_*_url` are now **relative authed paths** (`/api/evidence/:id/:kind`), there's
> a new `evidence_terms_url`, and they are **always present** (no longer null / no longer
> CDN-resolved). To render them in `<img>`/`<iframe>` you must **fetch with the bearer
> header and use a blob URL** — a bare `<img src>` will 401.

## Why this changed

The public landing-page CDN is **screenshot-only by design**: it serves `…/screenshot.png`
(200) and **403s** `…/page.html` / `…/terms.txt` (the raw HTML snapshot + verbatim,
copyrighted terms must never be public). So the old admin DTO — which resolved
`evidence_html_url` against that same public CDN — produced a link that 403s. Reviewers
*should* see the full bundle, so the pipeline now streams it from an authenticated
endpoint instead. The public `/v1/` feed is unchanged (still the CDN screenshot URL).

## The new endpoint

```
GET /api/evidence/:id/:artifact          artifact ∈ screenshot | html | terms
Authorization: Bearer <REVIEW_API_TOKEN>     ← REQUIRED (unlike the other GETs)
```

- **200** → the raw bytes with the stored content-type (`image/png` /
  `text/html; charset=utf-8` / `text/plain; charset=utf-8`) +
  `Cache-Control: private, no-store`.
- **401** → no / wrong bearer.
- **404** → unknown id, an absent bundle, or an unknown artifact kind (`evidence.json` /
  metadata is deliberately NOT served — it duplicates the candidate record).

## What changed in `GET /api/candidates` → `evidence`

| field | before | now |
|---|---|---|
| `evidence_screenshot_url` | CDN URL or `null` | **relative** `/api/evidence/:id/screenshot`, always present |
| `evidence_html_url` | CDN URL or `null` (and 403'd!) | **relative** `/api/evidence/:id/html`, always present |
| `evidence_terms_url` | — (didn't exist) | **NEW** `/api/evidence/:id/terms` |

The raw `screenshot_ref`/`html_ref`/`terms_ref` are still present (reviewer console, not
an allow-list). The URLs are **relative** — prefix them with your configured API base URL.

## How to render (the one gotcha)

An `<img src>` / `<iframe src>` **cannot send an `Authorization` header**, so pointing
them straight at the URL returns 401. Fetch the bytes, then use a blob object-URL:

```ts
async function loadEvidence(url: string, token: string): Promise<string> {
  const res = await fetch(apiBase + url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`evidence ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);        // set as <img src> / <iframe src>
}
// …and revoke it when the element unmounts:
//   URL.revokeObjectURL(objectUrl)
```

(This is why we chose the Bearer model over signed URLs: no token in the URL — which
leaks via logs/referrer/history — and no new auth primitive. The cost is this small
fetch-to-blob step.)

## Checklist

- [ ] Update the candidate-evidence schema: `evidence_screenshot_url` / `evidence_html_url`
      are now non-null **strings** (relative paths), and add `evidence_terms_url`.
- [ ] Render the screenshot via fetch-with-bearer → `URL.createObjectURL` (not a bare `src`).
- [ ] Wire the "view archived HTML" + "view terms" links to `evidence_html_url` /
      `evidence_terms_url` the same way (blob URL in an `<iframe>` / download).
- [ ] Revoke object URLs on unmount to avoid leaks.
- [ ] No CDN handling needed in the panel anymore — the authed path works regardless of
      whether `S3_CDN_BASE_URL` is set on the API.

Source of truth: `docs/api/openapi.yaml` (path `/api/evidence/{id}/{artifact}`, schema
`Evidence`).
