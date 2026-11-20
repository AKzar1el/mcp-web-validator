# V07 - HTTP source HTML versus browser-rendered DOM

V07 compares source markup with a **rendered DOM snapshot**, focusing on SEO diagnostics whose meaning may change when scripts modify the page.

Google documents separate crawling, rendering and indexing phases. Its Web Rendering Service (WRS) runs JavaScript, but this local tool **does not impersonate Googlebot, emulate Google's resource-fetch policy, determine Google's selected canonical or establish the indexing state**.

## Local MCP tool: browser.dom_diff

There is no hosted Worker implementation because isolated Chromium is a local-only M03 browser diagnostic.

Three explicit mutually exclusive modes are available:

1. **compare_snapshots:** provide page_url, raw_html and rendered_html already obtained from your own authorized sources. The tool compares them purely offline and launches no browser. This is the most accurate input when the caller has captured a complete browser DOM including external scripts/assets or a Google URL Inspection rendered snapshot.
2. **inline_sandbox:** provide page_url and raw_html. A fresh local sandboxed Chromium executes the supplied inline scripts, while external scripts, iframes and every network request are blocked. A script can update the in-memory DOM and the tool compares the resulting snapshot against the supplied raw source. The external framework hydration of a typical Next.js site will **not** run in this mode.
3. **live_inline_sandbox:** provide an authorized public query-free url. The local Node HTTP transport checks robots.txt permissions, fetches one complete HTTP 200 HTML document using pinned public DNS/network safeguards, and runs the same bounded isolated inline-script render. This is a point-in-time public HTML sample, not a real full-resource browser render.

Example offline comparison:

    {
      "mode": "compare_snapshots",
      "page_url": "https://example.com/",
      "raw_html": "<html><head><title>Raw</title></head><body><main><div id=\"app\"></div></main></body></html>",
      "rendered_html": "<html><head><title>Rendered</title></head><body><main><h1>Loaded</h1></main></body></html>"
    }

Example isolated inline render:

    {
      "mode": "inline_sandbox",
      "page_url": "https://example.com/",
      "raw_html": "<html><body><main id=\"app\">Loading</main><script>document.getElementById('app').innerHTML = '<h1>Ready</h1>'</script></body></html>"
    }

Example public live HTML sample:

    { "mode": "live_inline_sandbox", "url": "https://example.com/" }

## Signals and output

The report compares source and rendered document title, meta description, first H1/count, main-content word counts and distinct-word overlap, same-origin query-free anchor destinations, canonical hints, Googlebot-applicable robots meta noindex and JSON-LD block counts. It also includes bounded counts of inline/external script tags, blocked subresource attempts and JS runtime errors.

A source title or H1 disappearing, content substantially shrinking, a rendered noindex being added, or a canonical declaration changing are actionable *investigation leads*. Content that appears only in the browser can be normal for a JavaScript app; the existence of a delta is **not an SEO defect by itself**.

No raw HTML, page text, titles, paths, canonical targets, JavaScript stack traces, query strings, credentials or console messages appear in MCP output. All findings use fixed, bounded wording.

## Resource and safety limits

- Each source/rendered snapshot is limited to **512 KiB UTF-8**; combined HTML remains under 1 MiB. Only up to 200 anchor hrefs per snapshot and 10,000 text tokens are examined. Exceeding sample caps is reported.
- Chromium is a fresh pinned local sandboxed headless browser, with an offline network profile, denied proxy and request interception that aborts all external/first-party resource requests. External script tags, embedded frames and meta refresh directives are removed before rendering. Inline JavaScript is untrusted: use only HTML you are authorized to test. No links are clicked or forms submitted, and no screenshots are stored.
- A short fixed browser deadline limits hanging scripts; startup failures or oversized dynamically generated markup return an explicit failed diagnostic without claiming a clean render.
- The live fetch is allowed only when independently observed robots.txt rules permit the service User-Agent; unknown/blocked policies fail closed. HTTP redirects and non-HTML/non-200/challenge bodies are not treated as successful source pages.
- A genuine whole-site browser render with fetched scripts, CSS and API data requires a separate authorized workflow. This tool does not supply all of those dependencies.

References: [Google JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics), [Fix search-related JavaScript problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript), [Puppeteer page/request interception](https://pptr.dev/api/puppeteer.page.setrequestinterception).

## Release gates

Source analyzer and browser-runtime tests, live read-only canary when feasible, actual local stdio MCP list/call tests, local complete regression, hosted complete regression (to guard against inadvertent changes), fresh installed npm tarball smoke, manifest sync/check, Wrangler Worker dry-run and final code review. Source merge does not deploy the hosted Worker.
