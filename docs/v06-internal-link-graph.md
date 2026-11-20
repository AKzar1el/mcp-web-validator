# V06 - Internal-link graph, sampled depth and possible orphan leads

V06 complements V05 sitemap inventory and P1-08 anchor-quality checks. It inspects static HTML anchors with href attributes, including navigation, header, footer and contextual content. It never claims to perform a complete website crawl, actual Googlebot traversal, Google indexing, ranking or PageRank analysis.

## MCP tools

| Runtime | Tool | Modes |
| --- | --- | --- |
| Local Node/stdio | site.link_graph | Offline page evidence or bounded live public sample |
| Hosted Cloudflare Worker | review_internal_link_graph | Same modes; every attempted GET charges existing site-audit limiter |

### Offline example

    {
      "site_url": "https://example.com/",
      "entry_urls": ["https://example.com/"],
      "pages": [
        {
          "url": "https://example.com/",
          "status_code": 200,
          "html": "<html><body><nav><a href=\"/guide\">Guide</a></nav></body></html>"
        },
        {
          "url": "https://example.com/guide",
          "status_code": 200,
          "html": "<html><body><h1>Guide</h1></body></html>",
          "noindex": false,
          "robots_allowed": true
        },
        {
          "url": "https://example.com/rare-page",
          "html": "<html><body><h1>Rare page</h1></body></html>"
        }
      ],
      "sitemap_urls": [
        "https://example.com/",
        "https://example.com/guide",
        "https://example.com/rare-page"
      ]
    }

The shortest observed static anchor path is computed by breadth-first search from supplied entry roots. With no roots, the site's homepage is the only default, and only when included in the supplied page set. A route is never synthesized when its entry HTML is unavailable or its supplied status/robots evidence blocks the sample traversal.

A possible orphan is a supplied page with no incoming anchor links **from other supplied pages**. Unobserved pages, outside links or JavaScript may still connect to it. A page visible only in an independently supplied V05 sitemap catalog is *unobserved*, not proven broken or orphaned.

### Bounds and safety

- One to eight distinct same-origin caller-supplied page records with optional HTML, status, crawler-access, noindex and canonical declarations. HTML is limited to 1 MiB per page and 1.5 MB in aggregate.
- Up to 240 observed anchors per page, eight entry roots, 256 independent sitemap labels, and 24 returned fixed-message findings. Truncation is reported.
- Only ordinary HTML anchors with href attributes form graph edges. Relative links resolve against the document or a verified same-origin HTML base. Untrusted external base values cause relative links to be omitted.
- Query-bearing variants, fragment-only navigation, unsupported URI schemes and credential URLs are excluded from graph traversal; excluded evidence is counted. Off-origin links are counted but never fetched.
- Internal nofollow links are measured but excluded from conservative sample-depth routes; Google treats this as a hint rather than an absolute block.
- The output never echoes raw URLs, query tokens, HTML, headers, secret values or canonical targets. It uses fixed messages, bounded counts and page ordinals.

### Live sample

    { "url": "https://example.com/" }

Live mode reads at most one same-origin robots.txt and three safe same-origin page responses using the validator's service User-Agent, **not** Googlebot. No page request is issued if robots permission cannot be verified. Redirects, query-bearing links, cross-origin links and JavaScript-generated links are never followed. If allowed, up to two safe same-origin child targets are sampled from the entry HTML.

Local HTTP uses DNS-pinned public-address safeguards. Hosted HTTP uses its existing public fetch restrictions and charges one rate-limit token before each attempted GET. Live mode has no persistent history, scheduler, GSC/GA4 access, storage or write actions. Three pages cannot prove sitewide architecture.

### Interpretation

- Depth is the shortest *observed* path inside the supplied static page graph. A null depth means no sampled path, not actual whole-site inaccessibility.
- A potential orphan has no observed incoming links from sampled pages, not a confirmed sitewide orphan.
- HTTP, robots, noindex and non-self-canonical conflicts are only reported when actually observed or supplied, without claiming Google indexed or rejected a page.
- Unknown linked destinations and sitemap-only URLs remain unverified, never presumed broken.

References: [Google crawlable-link guidance](https://developers.google.com/search/docs/crawling-indexing/links-crawlable), [Google sitemap overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview), [nofollow link qualifications](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links).

## Release acceptance

Focused pure-module and guarded-fetch tests, actual local stdio and hosted MCP calls, complete local/Worker regressions, manifest consistency, packaged npm installation smoke, live read-only URL canary and Wrangler deploy dry-run are required. GitHub PR merge does not deploy the hosted Worker.
