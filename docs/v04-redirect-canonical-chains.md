# V04 - HTTP redirect and canonical chain diagnostics

**Goal:** Detect observed redirect loops, incomplete/mismatched Location chains, target errors, declared noindex and canonical contradictions without treating a canonical hint as Google's selected canonical URL.

## MCP tools

| Surface | Tool | Inputs |
| --- | --- | --- |
| Local Node/stdio | \`http.redirect_chain\` | Up to eight offline supplied HTTP response hops, or one bounded public live URL |
| Hosted Cloudflare Worker | \`review_redirect_canonical_chains\` | Same offline mode; limited same-origin live HTTP chain and static final HTML fetch |

### Offline example

\`\`\`json
{
  "source_url": "https://example.com/",
  "expected_destination": "https://example.com/articles/",
  "observations": [
    { "url": "https://example.com/", "status_code": 301, "location": "/articles/" },
    {
      "url": "https://example.com/articles/",
      "status_code": 200,
      "canonicals": ["/articles/"],
      "html": "<html><head><link rel=\"canonical\" href=\"/articles/\"></head></html>",
      "x_robots_tag": []
    }
  ]
}
\`\`\`

- Every observation is a *previously observed* HTTP response. Only the first URL is required to match the explicit source. Subsequent URLs must match the preceding HTTP Location or are flagged as mismatched.
- Optional \`canonicals\` contains up to four already observed canonical href strings, including from a supplied HTTP \`Link: <...>; rel=\"canonical\"\` response header. Static HTML canonicals are extracted separately from \`head > link[rel~=canonical]\`; JavaScript is not executed.
- Optional \`x_robots_tag\` accepts up to eight small HTTP header values; \`[]\` means checked and absent. Optional \`robots_allowed\` is independent caller-supplied access evidence. Missing HTML and unobserved headers remain **unknown**.
- Optional \`expected_destination\` is the only basis for claiming that a complete chain resolves to a different destination than expected. Without it, the tool does not claim a wrong target.
- At most eight response hops, 1 MiB UTF-8 HTML bytes per hop, 1.5 MB cumulative HTML bytes, 24 findings and bounded canonical/header/URL evidence. Raw URLs, query tokens, HTML, headers and expected targets are never returned.
- For HTML larger than V03's independent 150 KB crawler-matrix limit, V04 extracts at most 64 relevant robots-meta elements into a bounded temporary document for shared indexing-directive analysis. Excessive or incomplete metadata stays **unknown**, never incorrectly certified clean.

### Live example

\`\`\`json
{ "url": "https://example.com/", "expected_destination": "https://example.com/articles/" }
\`\`\`

The live mode starts at a safe query-free authorized HTTP(S) URL. It follows **only same-origin, query-free, no-HTTPS-downgrade** redirect destinations. Off-origin or query-bearing redirects remain evidence in the report but are never automatically fetched. Local Node probes use the existing DNS-resolved, public-address-pinned HTTP transport with up to five followed redirects and a 12-second deadline. The hosted Worker uses the existing V01 guarded HTTP probe (up to four observed responses), then makes one **independent, limited** GET for static HTML if the final sampled status was 2xx. This second fetch may observe a change in the site; mismatch or failure is surfaced as incomplete HTML evidence. Every hosted outgoing GET is rate-limited using the existing site-audit limiter. No cookies, browser, GSC/GA4 authorization, crawler impersonation, login, scheduler, storage or production write is performed.

Local live mode also inspects a small set of HTTP \`Link\` canonical header declarations; hosted live mode interprets canonical links present in final static HTML. The offline comparison supports supplied HTTP canonical headers for both runtimes.

### Report interpretation

- **Redirect class:** 301/308 permanent versus 302/303/307 temporary. Google treats server-side permanent redirects as strong canonicalization signals; temporary redirects communicate a different intention.
- **Chain incomplete:** last redirect target not sampled, loops, or mismatched observations. Unknown/unfetched destinations are not declared broken or non-indexable.
- **Destination HTTP error / declared noindex / explicit caller-provided robots disallow:** separately indicated; these are diagnostic signals, not Google indexing outcomes.
- **Canonical conflicts:** multiple distinct declarations on one sampled response; canonical-to-redirect; canonical-to-HTTP-error; canonical-to-declared-noindex; observed canonical chain or cycle. Unknown canonical targets are reported as unobserved, not assumed invalid.
- **Noindex declaration:** static HTML and HTTP X-Robots-Tag evaluated for the Googlebot product token through the V03 shared analyzer. A noindex declaration does not prove the real Googlebot fetched or processed it.
- **No Google canonical verdict:** Google may choose a different canonical. The report does not assert indexing, ranking, duplicate equivalence, browser-rendered DOM, or deployment causality.

References: [Google Search redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects), [Google canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [robots meta directives](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag).

## Acceptance / release gates

Focused pure analyzer tests, hosted mocked-HTTP tests, actual local stdio and hosted MCP list/call, installed npm tarball smoke, manifest sync/check, full local and hosted regression, Worker Wrangler dry-run, and a live authorized URL smoke probe. A merged source change is **not** evidence that the hosted Worker was redeployed.
