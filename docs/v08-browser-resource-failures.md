# V08 - Browser resource loading failures

V08 is a **local-only** browser diagnostics tool. It builds on the existing pinned Chromium screenshot runtime and public-address-pinned screenshot proxy. It distinguishes actual HTTP errors, request transport failures, requests intentionally blocked by the validator and requests still pending at the end of a short sample.

Google Search Central advises investigating missing resources and JavaScript errors, but **this bounded run is not Googlebot, Google Web Rendering Service, actual indexing evidence, or proof that any specific failure caused a ranking change**.

## MCP tool: browser.resource_failures

Two explicit modes:

**Offline evidence**, no browser or network:

    {
      "mode": "analyze_observations",
      "navigation_completed": true,
      "observations": [
        { "resource_type": "script", "origin": "same_origin", "outcome": "http", "status_code": 404 },
        { "resource_type": "fetch", "origin": "same_origin", "outcome": "transport_failed", "failure_reason": "timeout" },
        { "resource_type": "stylesheet", "origin": "third_party", "outcome": "tool_blocked" },
        { "resource_type": "image", "origin": "same_origin", "outcome": "pending" }
      ]
    }

**Guarded live browser** on one authorized public entry URL:

    { "mode": "live_browser", "url": "https://example.com/" }

By default, the live browser permits only safe same-origin resources, subject to its request and time caps. Third-party requests are **blocked by the validator's policy** and must not be reported as failures of the website. To explicitly inspect public CDN or API resources as well, use:

    {
      "mode": "live_browser",
      "url": "https://example.com/",
      "include_third_party": true
    }

That option permits at most three additional public origins; no credentials, private addresses or file URLs are accepted. Use it only where the external resource requests are authorized.

## Evidence and interpretation

- An HTTP 404, 429 or 503 is a **completed HTTP response**, not a Puppeteer requestfailed event. The tool counts HTTP 4xx and 5xx separately.
- A transport failure indicates that the browser request failed without a complete usable HTTP response. Only a fixed reason category is returned: DNS, timeout, TLS, connection, cancellation or other.
- An explicit tool-policy block is not a website failure. If a site depends on third-party scripts but third-party access is disabled, the report makes that policy limitation visible.
- A pending request at sample end is **unverified**, not a timeout or broken resource.
- Document, script and stylesheet errors are flagged as potentially critical; failed fetch/XHR, image and font requests are counted separately. A resource with no observed errors is not guaranteed healthy outside this short sample.
- A completed resource response taking more than three seconds is advisory rather than a performance benchmark.

The report uses only fixed code/message strings and counts by type. It does not return original URL paths, query strings, request/response headers, body bytes, cookies, network error text, scripts or credentials.

## Limits, network and privacy

- At most **64 observed network requests** in one live sample; extra requests are blocked and counted in the separate over-cap category. At most **20 fixed findings** are returned.
- Robots.txt for the service's own User-Agent is checked before page navigation. Disallowed/unknown permission fails closed. The browser process has a 24-second deadline; page navigation has a 12-second deadline and a brief observation window. No background jobs or persistent data.
- Uses the existing fresh sandboxed headless Chromium binary, safe public-IP DNS-pinned proxy, per-request public URL checks and request interception. Main-document redirects, media downloads, unsupported URL schemes and private-network resources are not followed.
- The browser interception permits only GET and HEAD requests. POST, PUT, PATCH, DELETE, preflight OPTIONS and other methods are blocked by the validator so that an on-load script cannot send a mutation request through this diagnostic.
- Third-party resources are blocked unless explicitly opted in. Even with opt-in, origin and request-count caps apply.
- This is a small observable network event sample; it is **not** a full HAR export, exhaustive waterfall, Google Crawl Stats history, CrUX, Lighthouse score or verification of rendering completeness. The tool does not write screenshots or files.

References: [Google troubleshooting JavaScript rendering](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript), [Google crawling errors](https://developers.google.com/search/docs/crawling-indexing/troubleshoot-crawling-errors), [Puppeteer request event semantics](https://pptr.dev/api/puppeteer.httprequest).

## Release gates

Pure input/edge/security tests, actual stdio MCP list/call, guarded live browser canary, complete local/hosted regression, manifest sync/check, fresh packaged npm-tarball smoke and Worker dry-run (no deployment) before merging.
