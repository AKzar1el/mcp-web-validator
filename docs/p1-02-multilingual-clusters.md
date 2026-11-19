# P1-02 — sixteen-locale hreflang and canonical clusters

**Status:** implemented in source, pending independent PR and CI. **Owner:** M02 site-architecture; depends on P1-01. Next roadmap gate: P1-03 (empty/boilerplate page families) only after P1-02 passes integration tests, review, and CI.

## Real interfaces

- Local stdio tool **site.hreflang** (offline): supply 1–16 page observations, each with an absolute HTTP(S) URL label and already obtained HTML. Max 125 kB/page, max 1.5 MB total. It does not crawl URLs, read local paths, store snapshots, run JS, inspect the browser, or contact a third-party service.
- Hosted Worker **audit_public_site**: multilingual_clusters adds data from *only the pages already fetched* by the existing maximum-eight-page sitemap-first audit. Original robots, same-origin, request caps, redirect limits, rate limits, schemas, and network destinations are unchanged. It cannot confirm reciprocal links across unvisited pages, even if it reads 16 alternate declarations on each sampled page.
- Single shared engine: src/modules/site-architecture/multilingual-clusters.ts. Hosted chatgpt-plugin/src/modules/site-architecture/multilingual-clusters.ts re-exports the same engine; no duplicate matching algorithm.
- Existing indexability_graph remains in place for backward compatibility; it supplies limited legacy observations. compare_site_audits accepts historical snapshots without this new optional field but does not pretend to compare multilingual changes over time.

## What the algorithm checks

1. HTML head alternate hreflang declarations. **x-default** is a separate fallback and does not consume any of the **16 locale** slots.
2. Code normalization and checks for ISO 639-1 language, optional ISO 15924 script, and optional ISO 3166-1 alpha-2 region; reject unknown/unsupported and explicitly reserved regional codes. No invented language from the URL. HTML lang is a *potential* corroborating signal, not Google's detected language.
3. A fully-qualified HTTP(S) target is required: reject relative, query-bearing, credentialed, fragment-bearing or nonstandard-port URLs. Keep sensitive raw values out of structured and narrative results; refused declarations count as incomplete evidence, not rewritten target URLs.
4. Self-reference per page, reciprocal return links **only when the target is also sampled**, repeated/conflicting locale mappings, inconsistent mappings within linked page clusters, and conflicting, ambiguous, non-self, cycling or chained canonicals *only when enough sampled evidence exists*.
5. The result includes observed page counts, distinct locales, unobserved targets, invalid-declaration counts, total finding count, at most twelve prioritized findings with no more than two sanitized URLs each, truncation and a coverage flag.
6. Scope is sampled_pages_only. An unobserved target is **unverified, never proven missing or broken**. Separate translation quality, sitemap XHTML link annotations, HTTP Link headers and dynamic/JS-rendered hreflang checks are not claimed here.

Google Search Central reference: https://developers.google.com/search/docs/specialty/international/localized-versions. This implementation applies conservative source-backed checks but cannot assert Google's chosen canonical, language classification, indexing decisions or rankings.

## Hard bounds, caution and deployment

- At most **16** supplied pages in local offline analysis; at most **8** already fetched pages on hosted audit; scan up to **64** head declarations per page, accept at most **16 distinct** locale references plus x-default.
- Output at most **12** diagnostic records and two URLs each, with the complete finding count retained. No raw HTML or HTML excerpts are returned or persisted.
- Static page caps can cause skipped pages; explicit coverage limitations flag evidence loss.
- No new hosted MCP tool, permissions, browser functionality, API key, Cloudflare resource, connector, or deployment.
- Safe sequencing: this PR targets the P1-01 branch until PR #459 lands; it must not be merged before its prerequisite.
- Test the real local stdio MCP, hosted Worker handler, malformed locale codes, many targets, cross-domain targets, canonical loops, secret-bearing URLs, full sixteen-page reciprocal cases and partial eight-page hosted cases. Run both repository suites, manifests, dry-run packaging/Worker and GitHub CI.

**Do not start P1-03 before these gates finish.**
