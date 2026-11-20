# V03 - Crawler access matrix (robots.txt and indexing directives)

**Purpose:** Compare robots.txt crawl permission with separately observed page-level indexing directives across crawler product tokens. This is a declared-evidence review, **not** an authenticated crawler request, Search Console/index verdict, browser render or historical crawl-log analysis.

## MCP entry points

| Runtime | Tool | Supported modes |
| --- | --- | --- |
| Local Node/stdio | \`crawler.access\` | Offline supplied evidence; bounded live page and robots.txt probe |
| Hosted Cloudflare Worker | \`review_crawler_access\` | Same modes, with existing site-audit rate limit charged per HTTP attempt |

Profiles: \`googlebot-smartphone\`, \`googlebot-desktop\`, \`googlebot-news\`, \`googlebot-image\`, \`bingbot\`, \`gptbot\`. Googlebot smartphone and desktop have the same \`googlebot\` robots product token; separate labels do **not** imply different robots.txt policy. Values are used for standards-oriented token comparisons only. Tokens outside those profiles are not simulated.

### Offline example

\`\`\`json
{
  "site_url": "https://example.com/",
  "robots_txt": "User-agent: *\nDisallow: /draft/\nUser-agent: Googlebot\nAllow: /draft/visible",
  "robots_status_code": 200,
  "pages": [
    {
      "url": "https://example.com/draft/visible",
      "status_code": 200,
      "html": "<html><head><meta name=\"robots\" content=\"noindex\"></head></html>",
      "x_robots_tag": []
    }
  ],
  "profiles": ["googlebot-smartphone", "bingbot"]
}
\`\`\`

\`x_robots_tag: []\` explicitly means the headers were inspected and no X-Robots-Tag was observed. If the field is absent, unobserved header directives remain unknown unless another supplied directive already establishes noindex. A robots.txt body with a non-2xx HTTP status is rejected as contradictory. Missing or failed robots fetches are **unknown**, not assumed allowed.

Rules include longest matching product token, merging equal-specificity groups, longest matching Allow/Disallow URL path patterns with \`*\`/\`$\` support, and Allow winning equal-length ties. Robots content is bounded to 64,000 bytes and 2,000 rules; overflow causes unknown decisions, not partial false allowances. Profiles/pages are capped at 6 × 8 = 48 rows; output findings at 24. HTML input has 150 KB/page and 300 KB cumulative byte limits. No source text, raw URLs, response headers or selected robots paths are returned.

### Live example

\`\`\`json
{ "url": "https://example.com/page/" }
\`\`\`

The service fetches \`/robots.txt\`, then **at most one** authorized public HTML page only if its *own service User-Agent* is permitted by supplied robots evidence (or the robots file gives 404/410). The local runtime validates/pins public DNS addresses; the hosted Worker uses its established public URL/redirect guard and per-GET rate limiter. No request is made with a forged Googlebot, Bingbot or GPTBot identity, no credentials/cookies are sent, no JavaScript is executed, and no external analytics authorization is requested. If robots is unavailable, the page request is skipped and indexing evidence stays unknown.

### Reading results

- **\`robots_access\`** describes the selected crawler product token's declared path rule only.
- **\`indexing_state = explicit_noindex\`** identifies a supplied \`noindex\` or \`none\` directive on applicable static meta or X-Robots-Tag evidence. \`no_noindex_observed\` requires both static HTML and response headers to have been supplied/checked. This does **not** guarantee a search engine indexes a page.
- **\`blocked_with_noindex\`** warns that a robots-disallowed page may never expose its noindex directive to that crawler.
- **\`x_robots_scope_ambiguous\`** indicates that comma-folded header values may have lost separate header boundaries. The tool never infers a global noindex from an ambiguous different-agent scope.
- HTTP 403/429/5xx and absent HTML are surfaced as limited evidence. Use V01/V02 for HTTP delivery/history and V12 for supplied historical crawler log correlation.

Reference: [Google's robots.txt parsing](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec), [robots meta and X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag), [verifying Googlebot](https://developers.google.com/search/docs/crawling-indexing/googlebot). This implementation makes no verified Googlebot or Google indexing claims.

## Release gates

Local and hosted pure analyzer unit tests, hostile input/privacy/edge tests, real stdio and Worker MCP discovery/call, installed npm tarball smoke, repository full regression, manifest consistency, hosted TypeScript and Wrangler deployment dry-run, and an authorized live probe before landing the PR. Source commits/merges are not proof that the production Worker has been deployed.
