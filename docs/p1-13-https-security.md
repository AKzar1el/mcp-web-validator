# P1-13 — HTTPS, mixed content and HTTP security signals

**Owner:** M01 `http-crawl`. **Runtimes:** local Node/stdio `http.security` and hosted Worker `review_https_security`. **Status:** working **partial** feature, not a full security audit. The Worker imports the *same* pure analyzer through a thin re-export; browser, network and filesystem permissions are **not** extended.

**Runtime isolation:** The pure shared analyzer has no external parser import.
Each MCP entrypoint supplies its own already-declared Cheerio HTML loader from
its own installed package dependencies. This is important for independent
hosted-only `npm ci` CI and deployment environments, which do not install
the root package's dependencies.

## What is observed

Accepts 1–8 **caller-supplied HTTP/HTTPS response observations for the same hostname**. Accepting both schemes is intentional: HTTP-to-HTTPS redirect declarations can be compared. Input URL labels must be HTTP(S), absolute and query/fragment/credential/custom-port free; no URL is ever fetched or returned.

Each record contains an actual `status_code` and optionally its `Location`, repeated `Strict-Transport-Security`, enforcing `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `Referrer-Policy`, `X-Content-Type-Options`, `X-Frame-Options` headers, and optional static HTML.

The shared analyzer distinguishes:

- HTTP success vs **declared** 3xx Location redirect to HTTPS vs insecure/unresolved redirect. It does not follow chains or verify that an HTTPS destination works.
- HSTS observed on HTTPS (valid positive `max-age`, `max-age=0` disabled, invalid/conflicting or missing), HSTS ignored over HTTP, and **declared** `includeSubDomains`/`preload` flags. It cannot establish whether a host is actually in a preload list or previously cached in the browser.
- Enforcing CSP vs report-only CSP; recognized `upgrade-insecure-requests` on an enforcing header or HTML head meta CSP; enforcing `frame-ancestors` vs optional supported X-Frame-Options; observed `nosniff`; and weak explicit referrer policies.
- Static HTTPS HTML resource declarations targeting HTTP: potentially **blockable** script, stylesheet, frame, manifest, preload, `img/srcset`, picture-source `srcset`, track, embedding and conservatively classified inline CSS; potential **upgradable** ordinary `img/src`, video/audio `src` and media poster candidates; IPv4/IPv6 resource host exceptions (HTTP image with literal IP is blockable); insecure form `action` and control `formaction`; and HTTP `<base href>` affecting relative resources.
- Protocol-relative references resolved from an HTTPS page are **not** incorrectly treated as `http:`. Ordinary `<a href>` navigation is not classified as mixed-content subresource loading. Inline JS literals and templates are **not** assumed to execute or load resources.

These are **static review leads**; browser upgrade/block decisions depend on its security algorithms, policies, actual document state and resource availability. Mixed content may be auto-upgraded, blocked, or affected by effective CSP. No dynamic scripts, imported external CSS, CSSOM, service workers, certificate chains, HSTS preload membership, browser state, redirect chains, request/response measurements, cookies or user-specific permissions are checked.

## MCP example

```json
{
  "pages": [
    {
      "url": "http://example.com/",
      "status_code": 301,
      "location": "https://example.com/"
    },
    {
      "url": "https://example.com/",
      "status_code": 200,
      "strict_transport_security": ["max-age=31536000; includeSubDomains"],
      "content_security_policy": ["default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests"],
      "referrer_policy": "strict-origin-when-cross-origin",
      "x_content_type_options": "nosniff",
      "htmlContent": "<html><body><script src=\"http://cdn.example.com/app.js\"></script><img src=\"http://cdn.example.com/photo.jpg\"></body></html>"
    }
  ]
}
```

No external URI is fetched. All string values are parsed in memory and **never echoed**, including URL paths, Location, CSP/report URIs, form targets, source filenames, query tokens, HTML text, IDs and attributes. Returned page identifiers are **1-based numbers**; findings have controlled rule IDs, fixed messages and bounded counts.

## Bounds and fail-closed behavior

- **1–8 observations**, single hostname. Scheme may differ; duplicate page URLs and mixed hostname values reject the whole request. No custom ports, query strings, fragments or credentials in labels.
- Every supplied header value <= **2,048 UTF-8 bytes**, CRLF/NUL disallowed, <= **4 values per repeated header**, <= **24,000 UTF-8 bytes combined**.
- Optional HTML <= **120,000 UTF-8 bytes per page** and **300,000 bytes combined**, parsed by Cheerio, never executed; <= **400 DOM elements** and **160 static resource candidates** sampled per page. HTML sample exhaustion is marked explicitly and does not imply remaining resource absence.
- At most **12 prioritised fixed messages** returned; totals and truncation flags preserve partial evidence. No source text in messages. Validation errors are generic and exclude untrusted input.
- All tools have `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false`. No new network endpoint, browser capability, scheduled task, storage or deployed Worker is created by this feature.

## Security-relevant interpretation

HSTS is **ignored over HTTP**, `max-age=0` **disables an observed HTTPS HSTS policy**, and absence of a header *in the supplied evidence* does not prove that a browser has no HSTS state. `CSP-Report-Only` does **not** enforce blocking or the `upgrade-insecure-requests` directive. A CSP `upgrade-insecure-requests` directive does not replace HSTS or prove that HTTPS resources exist. An HTML meta CSP's `frame-ancestors` directive is not counted as effective framing protection.

Current MDN references:
- [Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
- [Strict-Transport-Security](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security)
- [CSP: upgrade-insecure-requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/upgrade-insecure-requests)
- [Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)
- [Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
- [X-Content-Type-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options)

## Verification and future scope

Run root `npm run check`, hosted `npm run check && npm test`, `npm run deploy:dry-run` (dry-run only), local installed tarball smoke and CI Windows/Ubuntu screenshot jobs. The local test file is `test/http-crawl-https-security.test.js`; hosted Worker test is `chatgpt-plugin/src/modules/http-crawl/https-security.test.ts`; both MCP protocol-level tests exercise real registered tools.

A future *separately authorized* live diagnostic would need safe redirect sampling, public-IP DNS pinning, robots/site budgets, measured TLS/certificate tests and browser runtime checks; none is added here. **Do not interpret this result as proof a site is secure or compliant.**
