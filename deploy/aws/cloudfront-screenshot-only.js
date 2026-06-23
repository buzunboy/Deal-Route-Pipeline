// CloudFront Function (viewer-request) — the screenshot-only public-read gate.
//
// THE TRUST RULE (see ARCHITECTURE.md "Public read surface" + the KNOWN_ISSUES
// "Public CDN must expose ONLY screenshot.png" finding): an evidence bundle stores
//   <id>/screenshot.png   the full-page screenshot   ← the ONLY public artifact
//   <id>/page.html        the raw HTML snapshot       ← MUST stay private
//   <id>/terms.txt        verbatim (copyrighted) terms ← MUST stay private
//   <id>/evidence.json    bundle metadata             ← MUST stay private
// all under ONE `<id>/` prefix. The public DTO emits only the screenshot URL, but a
// CDN fronting the whole prefix would let anyone edit `…/<id>/screenshot.png` to
// `…/<id>/terms.txt` and fetch the data the public DTO deliberately drops. This
// function runs on EVERY viewer request at the edge and 403s any path that does not
// end in `/screenshot.png`, so the bundle's HTML/terms/metadata are unreachable over
// the CDN by construction — the file names are the domain constants in
// `src/domain/evidence/evidence-layout.ts` (keep this regex in sync if those change).
//
// This is the LOAD-BEARING control. The bucket stays fully access-blocked (only
// CloudFront's OAC can read it), so the ONLY public door is this distribution, and
// this function is the lock on that door. It is deliberately allow-LIST (deny by
// default): any URI shape we didn't explicitly permit — directory listings, the
// other bundle files, a probe like `/`, `/foo`, `/<id>/`, `/<id>/screenshot.png/x` —
// gets 403, the safe failure mode for a trust boundary.
//
// CloudFront Functions run a constrained ES5-ish JS runtime (no ES modules, no
// async, must be synchronous and fast). Keep this dependency-free and pure.

function handler(event) {
  var request = event.request;
  var uri = request.uri; // always starts with "/", never null, decoded by CloudFront

  // Allow ONLY a well-formed bundle screenshot path: /<bundle-id>/screenshot.png
  // - exactly two path segments (the id prefix + the file)
  // - the id segment is non-empty and contains no further "/" (no nested prefixes)
  // - the file is EXACTLY screenshot.png (not "x-screenshot.png", not
  //   "screenshot.png/extra", not "screenshot.png?..."; the query string is a
  //   separate field CloudFront does not fold into uri)
  // The anchored regex enforces all of the above in one shot.
  var SCREENSHOT_ONLY = /^\/[^/]+\/screenshot\.png$/;

  if (SCREENSHOT_ONLY.test(uri)) {
    return request; // pass through to the S3 origin
  }

  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: {
      // No body/redirect; a bare 403 leaks nothing about what else exists.
      'content-type': { value: 'text/plain' },
      'cache-control': { value: 'no-store' },
    },
    body: 'Forbidden',
  };
}
