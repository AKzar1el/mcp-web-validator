# P1-11 — Non-HTML HTTP indexability and directive evidence

**Owner:** M01 `http-crawl`. **Runtimes:** local Node/stdio `http.directives` and hosted Worker `review_http_directives`. **Current scope:** bounded, offline analysis of caller-observed response headers; live request/probing is a separately scoped continuation. This is a real working **partial** P1-11 implementation, not proof of search-engine indexing.

## Input

Both tools accept `{ "resources": [...] }` with **1–8** HTTP response observations from the **same exact origin**, each with:

| Field | Meaning |
| --- | --- |
| `url` | Absolute, query-free HTTP(S) resource label without credentials, fragments or nonstandard ports. Never requested or included in output. |
| `status_code` | Actual HTTP response status (100–599) supplied by the caller. |
| `method` | Optional `"GET"` or `"HEAD"`; a HEAD result may differ from GET. |
| `content_type` | Optional `Content-Type` header (e.g. `application/pdf`). |
| `content_disposition` | Optional `Content-Disposition` header (e.g. `attachment`). |
| `x_robots_tag` | Optional array of up to 8 observed `X-Robots-Tag` header values. |
| `link` | Optional array of up to 8 observed HTTP `Link` header values. |

Example:

```json
{
  "resources": [
    {
      "url": "https://example.com/reports/example.pdf",
      "status_code": 200,
      "method": "HEAD",
      "content_type": "application/pdf",
      "x_robots_tag": ["noindex", "googlebot: nofollow"],
      "link": ["<https://example.com/reports/>; rel=\"canonical\""],
      "content_disposition": "inline"
    }
  ]
}
```

No HTML markup, PDF bytes, resource download, JavaScript, Google Search Console connection or crawler fetch is necessary. Acquire headers from an independently authorized and appropriately protected HTTP client; a HEAD-only response is not equivalent to full successful GET. The tool performs **zero network requests** and stores no sample.

## Evidence and boundaries

The parser categorizes supplied MIME types (HTML, PDF, image, video, audio, text, data, other binary or unknown) and counts non-2xx, partial 206, missing/unknown media types and explicit attachment disposition. It recognizes unscoped and agent-scoped `X-Robots-Tag` directives, including `noimageindex`, `none`/`all` aliases, `googlebot`, `googlebot-news` and unrelated bot names. Image-specific `noimageindex` is **not** treated as a generic page `noindex`. It flags contradictory `index`/`noindex` or `follow`/`nofollow` declarations for human review without asserting how Google will resolve them.

It parses bounded RFC 8288-style `Link` header items without splitting inside quoted strings or URL angle brackets. It distinguishes one canonical target, repeated equivalent targets, incompatible targets and invalid/non-absolute/credential-bearing targets. The canonical is **a declaration, not Google's selected canonical**. It does not follow links.

**Never infer indexability from an absent `X-Robots-Tag`**. A declared noindex only matters if an appropriate crawler receives and applies that header; robots.txt may prevent crawlers from retrieving the header. HTTP 206 is a 2xx **partial** response, not a generic non-success. HTTP 3xx/4xx/5xx is not proof of what another user agent or request method receives. Header observations are not server-wide policy tests, nor a replacement for the URL Inspection tool.

## Privacy, output caps and performance

- Up to **8 same-origin resources** and **8 values per repeated header**; maximum **2,048 UTF-8 bytes per header value** and **30,000 UTF-8 bytes combined**.
- Parse at most **32 Link items per resource**, with `header_coverage_limited` on truncation.
- Return at most **12 prioritized fixed-text findings** with `total_findings` and `findings_truncated`, plus resource *indices* and numeric/enum counts.
- No raw URL/path/query, canonical target, header values, filenames, body text, passwords or other caller-supplied content is returned, logged by the tool, fetched or retained. Reject unsafe resource labels, duplicate labels, cross-origin samples, CR/LF/NUL header injection and malformed bounds before analysis.
- Every response advertises `coverage_limited: true`, even when no errors are observed.

Do not submit real credentials, secrets, private document URLs or personal data in the input; upstream MCP clients may log request content outside this tool's control.

## Verification

- Root: `npm run check`, `test/http-crawl-non-html-directives.test.js`, real local stdio MCP `tools/list` and `tools/call`, manifest synchronization and installed npm tarball smoke.
- Worker: `npm run check`, `npm test`, real hosted MCP RPC tests, `npm run deploy:dry-run`. No Worker deployment.
- Both: production dependency audits and independent GitHub CI including Windows/Ubuntu screenshot and security jobs. No change to existing link/HTML/public-fetch security or resource limits.

## References

- [Google Search Central: robots meta tags and X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Google Search Central: canonical methods and non-HTML HTTP Link headers](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [RFC 8288: Web Linking](https://www.rfc-editor.org/rfc/rfc8288.html)

**Roadmap remainder:** an opt-in live, authorized non-HTML header probe (with explicit robots, redirect, DNS, request and response-size protections) and crawler-specific validation were **not** implemented by this offline phase.
