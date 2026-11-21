# V12 — historical crawler-log correlation for supplied access logs

**Owner:** M05 `change-regression`. **Runtime:** local Node/stdio **`crawler.logs`** only. **Scope:** completely offline and read-only. The tool does not connect to Cloudflare, nginx, hosting providers, access-log files, Google Search Console or the target site. Only logs that the caller intentionally supplies are parsed.

The primary use case is evaluating whether **explicitly listed important page paths** received more HTTP 401/403, 429, 404/410 or 5xx responses after an incident cutover. A user-agent containing `Googlebot` is **unverified**, not evidence of actual Googlebot IP ownership. Google recommends reverse-DNS + forward verification or published crawler-IP ranges to verify real Google crawler traffic; V12 never performs that verification.

## Inputs

Choose one of the following formats, not both:

1. `structured`: 1–500 caller-supplied observations, each with `timestamp` (offset-aware ISO), `method` (GET/HEAD), `path` (with optional query), `status` (HTTP 100–599), optional `user_agent`.
2. `combined_access`: 1–500 **Apache/Nginx combined-format access lines**, maximum **256,000 UTF-8 bytes**. Example format: `IP - - [12/Nov/2026:06:00:00 +0000] "GET /path HTTP/1.1" 403 123 "-" "Googlebot/2.1"`. Only the timestamp, HTTP method, request path, response status and claimed User-Agent are retained ephemerally during computation. IP, referrer, raw User-Agent, request URL and query are **never returned**. Unsupported custom/proxy/Cloudflare formats are counted as unparsed evidence rather than guessed.

Supply `site_origin` (public HTTPS origin), **1–16 same-origin important URLs** in a fixed order, and one explicit `cutover_at` timestamp. Example:

```json
{
  "site_origin": "https://example.com",
  "important_urls": [
    "https://example.com/",
    "https://example.com/important"
  ],
  "cutover_at": "2026-11-12T00:00:00Z",
  "format": "structured",
  "observations": [
    {
      "timestamp": "2026-11-11T23:00:00Z",
      "method": "GET",
      "path": "/important",
      "status": 200,
      "user_agent": "Googlebot/2.1"
    },
    {
      "timestamp": "2026-11-12T06:00:00Z",
      "method": "GET",
      "path": "/important?example=1",
      "status": 403,
      "user_agent": "Googlebot/2.1"
    }
  ]
}
```

These are **synthetic fixtures, not actual DigestSEO access logs**. Before sharing real logs, redact IPs, session identifiers, private query values, referers and anything unnecessary for the comparison. The tool reports important paths only as **`url_index` 1–16** according to the supplied ordering.

## Measurement and caveats

The report contains counts and per-supplied-request 4xx/5xx fractions in the before/after observed samples, plus the difference in percentage points when both periods contain matched requests.

- HTTP 2xx success, 3xx redirect, HTTP 401/403 access denied/challenge, 429 rate limit, 404/410 gone, other 4xx and 5xx server errors are tracked **separately**. Redirects are not failures. HTTP 404 may reflect a legitimate removal, not necessarily a defect.
- Each important URL is matched by **exact safe path**; permitted query variants match the same route and their query values are dropped. No redirects, canonicals or alternate hosts are followed. Suspicious encoded separators and dot traversal are excluded, with invalid-record counts included in the report.
- Requests not matching the listed important paths are counted but not used to invent a website-wide crawl statistic. POST/DELETE and other methods are ignored as crawler GET/HEAD evidence.
- Source `User-Agent` is a self-claim: groups are `claimed_googlebot`, `claimed_bingbot`, `claimed_gptbot`, `claimed_other_bot` and `other`; `crawler_identities_verified` is always **false**.
- Missing before/after observations yield `partial`, null baseline rates and null deltas. No matching important URLs yields `not_comparable`. Malformed log lines explicitly downgrade comparability. Counts are **not time-normalized requests/hour** because supplied windows may have different lengths and coverage.
- The sample contains at most **500 records**, **16 important paths** and **16 redacted findings**; total finding counts and truncation flags preserve omitted evidence. Raw source logs, URLs, query strings, timestamps, IP addresses, user agents, credentials and headers are never output. There is no storage or subscription.

**Critical limitation:** Access-log correlations do not establish Google Search traffic changes, an indexing verdict, verified Googlebot behavior, a 28-day CrUX metric, or a causal production-change event. Treat 403/429/5xx after a cutover as review leads to corroborate with the existing V01/V02 delivery checks, deployment history and authorized crawler verification. A sample without failures does not prove there were no failures elsewhere.

## Files and release gate

- Pure offline parser/aggregator: `src/modules/change-regression/crawler-log-correlation.ts`
- Local MCP registration and redacted report: `src/index.ts`, `src/presentation.ts`
- Tests: `test/change-regression-crawler-log-correlation.test.js`, actual stdio `test/mcp.integration.test.js`, installed npm tarball MCP smoke.
- Require full local regressions, manifest 39-tool consistency, hosted Worker unaffected, independent GitHub Linux/Windows/sandbox/security CI and a clean feature merge. No npm publish, production deploy, Codexify restart, agent overlap or external log provider access.

References: <https://httpd.apache.org/docs/current/en/logs.html> and <https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests>.
