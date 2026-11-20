# P1-09 — Duplicate, conflicting and mismatched metadata

**Owner:** M04 content-schema. **Runtimes:** local Node stdio and hosted Worker. Implemented on a separate feature branch stacked on P1-08 [PR #469](https://github.com/AKzar1el/mcp-web-validator/pull/469). **No merge or deployment in this task.**

## Purpose, scope and compatibility

P1-09 introduces one **offline, sampled metadata consistency** tool to each runtime:

- Local: `content.metadata`
- Hosted: `review_metadata_consistency`

Identical input to both tools:

```json
{
  "pages": [
    {
      "url": "https://example.test/article",
      "htmlContent": "<html><head><title>Article about chairs</title><meta name=\"description\" content=\"How ergonomic office chairs work\"><link rel=\"canonical\" href=\"/article\"><meta property=\"og:title\" content=\"Article about chairs\"></head><body></body></html>"
    },
    {
      "url": "https://example.test/product",
      "htmlContent": "<html><head><title>Office chairs</title><link rel=\"canonical\" href=\"/product\"></head><body></body></html>"
    }
  ]
}
```

The URLs are safe **labels**, not addresses to request. All supplied pages must be distinct and have the **same exact origin** (scheme, host and port). No page, canonical, Open Graph image or destination is fetched. The tools do not run JavaScript, inspect live response headers, call Google APIs, store inputs, or access private data.

This tool is **additive**. Existing SEO audits already flag basic multiple title/description/canonical declarations, and the hosted indexability graph already inspects canonical chains, cycles and duplicate titles for its own fetched sample. Those existing contracts remain unchanged. P1-09 supplies an independent, bounded **caller-provided multi-page view** and does not reimplement the existing canonical graph.

## Findings and interpretation

| Signal | Evidence and caveat |
|---|---|
| Duplicate declaration | Two or more equivalent values for the same field (title, meta description, canonical, og:title/description/url, twitter:title/description, robots/googlebot). This is *redundancy*, not necessarily a problem |
| Conflicting declaration | Different explicit values for a single field on one page. These are directly observed and worth checking |
| Canonical reference unverified | A canonical URL with invalid protocol, credentials, unsupported fragment or unresolved base. Relative canonicals respect a usable `<base href>`; no inference of Google's selected canonical |
| Search/social metadata mismatch | A single title or meta description differs from an explicitly supplied Open Graph/Twitter counterpart. **Informational only:** social headlines and previews may intentionally differ |
| Canonical and og:url mismatch | URLs differ after safe resolution. **Informational only:** Open Graph URL is not a Google canonicalization signal |
| Potential robots directive conflict | Explicit index/noindex or follow/nofollow disagreement among observed robots/googlebot declarations. Semantically equivalent `all`/`none` aliases and complementary declarations are not called contradictory; differing values of the same named directive are review leads. Agent-specific and most-restrictive handling need manual review; HTTP `X-Robots-Tag` not inspected |
| Cross-page repeated title/description | Normalized text is repeated on different sampled URLs with **distinct** explicit canonical preferences or distinct supplied URL labels. **Informational only:** localization and page variants may intentionally reuse metadata |

For canonical resolution, query-bearing **canonical targets** are allowed and compared transiently (a query in the **supplied page URL label** is not accepted). Social URL, title and description values are never returned. Canonical targets with unsupported annotations (`hreflang`, `lang`, `media` or `type`) are excluded from usable canonical comparisons and counted. If any remaining canonical declaration cannot be resolved, a lone valid companion is **not** promoted into a verified unique preference for cross-field or cross-page comparison.

The response contains only summary/per-page numeric counts, page indices, a safe common origin, fixed finding codes and fixed explanatory text; no raw metadata values, page URL paths, social links, page content, query strings, secrets, or JSON parsing exceptions. Every output has `coverage_limited: true`: a clean sample is **not** proof that the rest of a site is healthy or that Google has indexed or chosen any particular canonical.

## Bounds and privacy

- **1–8** supplied HTML pages, **180,000 UTF-8 bytes per page**, **900,000 UTF-8 bytes combined**.
- Safe page labels: HTTP(S), max 512 characters, no credentials, query, fragment or nonstandard port. Each label unique; one exact origin.
- Up to **12 metadata values per field per page**, max 320 characters for text fields, max 1,024 for canonical/social URLs; oversize declarations are excluded rather than truncated into a possibly misleading URL.
- At most **12 prioritized findings**, retaining `total_findings` and `findings_truncated`. Capped or excluded declarations are explicitly reported.
- No new permissions, credentials, storage, worker routes, external requests, costs or deployment.

## Evidence and testing

Google documents title-link generation as multi-source and automated, including the page's title and `og:title`; canonical links are **preferences**, not guaranteed Google-selected canonicals. Google also advises avoiding contradictory canonical signals. See the [title-link documentation](https://developers.google.com/search/docs/appearance/title-link), [canonical preferences](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), and [canonicalization overview](https://developers.google.com/search/docs/crawling-indexing/canonicalization). This tool deliberately does **not** simulate Google's result selection.

Acceptance: focused unit/adversarial tests (duplicate vs conflict, social mismatch, robots, relative and base-aware canonical, shared canonical vs duplicate title, invalid/secret URLs, 8-page bounds, disclosure), real local stdio and hosted Worker HTTP MCP tool calls, complete local/hosted suites and manifests, packaged npm smoke, Worker dry-run, GitHub local/Windows/Ubuntu/hosted CI and security checks.

**Next ordered roadmap item:** P1-10 — media diagnostics (images/video/loading/alt evidence), local-only M03.
