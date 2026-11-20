# V05 - Bounded sitemap inventory and discovery/indexability checks

V05 reviews sitemap URL inventories, child-index completeness, independently discovered pages, `lastmod` consistency and independently observed indexability conflicts. It does **not** infer search-engine crawl/indexing status or certify full-site coverage from a small network sample.

Compressed `.xml.gz` sitemap documents are supported in bounded live fetches; both compressed and inflated bodies are size-limited to prevent decompression bombs.

## MCP entry points

For an unspecified sitemap URL, the live probe first checks bounded public `/robots.txt` and selects the first safe, same-origin `Sitemap:` declaration; otherwise it falls back to `/sitemap.xml`. An explicit `sitemap_url` skips that discovery request. The live request budget is at most four GETs including robots.txt, and at most three sitemap documents are read.

| Runtime | Tool | Modes |
| --- | --- | --- |
| Local Node/stdio | `site.sitemaps` | Offline supplied inventory or bounded public sitemap fetch |
| Hosted Cloudflare Worker | `review_sitemap_inventory` | Same modes; existing site-audit limiter charges each attempted HTTP GET |

### Offline input

```json
{
  "site_url": "https://example.com/",
  "observed_at": "2026-11-20T12:00:00Z",
  "documents_complete": true,
  "discovered_complete": true,
  "documents": [
    {
      "sitemap_url": "https://example.com/sitemap.xml",
      "content_type": "application/xml",
      "status_code": 200,
      "content": "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"><url><loc>https://example.com/a</loc><lastmod>2026-11-19</lastmod></url></urlset>"
    }
  ],
  "discovered_urls": ["https://example.com/a"],
  "page_observations": [
    {
      "url": "https://example.com/a",
      "status_code": 200,
      "canonical_url": "https://example.com/a",
      "noindex": false,
      "robots_allowed": true,
      "modified_at": "2026-11-19"
    }
  ]
}
```

Supply **one to eight** same-origin XML urlset/index or plain-text sitemap bodies, with at most 512 KB per document, 1.5 MB cumulative bytes and 2,000 URL entries. Up to 500 independent discovered URLs and 250 distinct page observations can be provided. The tool reports only counts, bounded codes and document/entry ordinals: no URL paths, raw XML, query parameters, headers or page bodies are returned. XML is checked for malformed nesting, attributes, entities, extra roots and DTD/external entity declarations. RSS/Atom and unknown formats remain unsupported rather than being declared clean.

Optional `documents_complete` and `discovered_complete` are caller assertions. The tool also checks that every referenced child sitemap was included and that parsing was not truncated; absent/unsupported documents cannot establish a complete inventory. It does not crawl the complete site. The reported URL overlap compares **only** documents and independent URLs supplied to this call.

`lastmod` must be a genuine W3C date/datetime. Future dates, invalid calendar dates, conflicting dates for the same URL, and differences from an independently supplied significant modification date are separate signals. Equal dates are not necessarily wrong. Search engines may ignore unreliable dates; these findings are **diagnostics**, not validation of Google's use of lastmod.

Page observations may independently report HTTP 3xx/4xx/5xx, noindex, robots disallow and non-self canonical preferences. Missing observations remain unknown. Sitemap inclusion is a discovery hint, not proof of selection as canonical or indexing.

### Bounded live input

```json
{ "url": "https://example.com/", "sitemap_url": "https://example.com/sitemap.xml" }
```

The live mode fetches one safe query-free public sitemap and **at most two** safe same-origin child sitemap documents from its sitemap index. No linked page URLs are crawled or verified. No crawler impersonation, credentials, cookies, GSC, GA4, browser execution, scheduler, paid storage or production writes are used. The local runtime uses DNS-pinned public-address HTTP; the Worker uses the established public fetch/redirect protections and a rate-limit charge per attempted GET. Missing/error child responses do not establish a full inventory. This live sample always reports `documents_complete=false` and `discovered_complete=false`.

## References

- [Google: Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: Manage large sitemaps and indexes](https://developers.google.com/search/docs/crawling-indexing/sitemaps/large-sitemaps)
- [Sitemaps.org protocol](https://www.sitemaps.org/protocol.html)

## Verification and release

Required gates: pure local and hosted analyzer tests, input/security/capped-fetch tests, real local stdio and hosted MCP calls, npm package installation smoke, manifest sync/check, complete local and Worker regression, controlled live sitemap sample and Wrangler deploy dry-run. Source PR merge is **not** a production Worker deployment.
