# P1-08 - Contextual internal-link and anchor-label quality

**Scope:** M02 site-architecture, both local and hosted MCP runtimes. **Branch-only implementation**, stacked on verified P1-07 PR #468. No merge or production deployment is authorized by this feature task.

## Tools and deterministic evidence

- Local Node stdio: `site.links`.
- Hosted Cloudflare Worker: `review_internal_links`.
- Both use the same input `{ "pages": [{ "url": "...", "htmlContent": "..." }] }`, accepting 1-8 caller-supplied static HTML pages with distinct, absolute, safe HTTP(S) URLs on the **same exact origin**. Relative internal links are interpreted relative to the caller-supplied document URL, **without fetching anything**. HTTPS vs HTTP, subdomains and nonstandard ports are not treated as the same origin.
- A shared pure comparison engine is implemented in `src/modules/site-architecture/internal-link-quality.ts`. Thin Cheerio-only HTML adapters live in `src/modules/site-architecture/extract-internal-links.ts` and `chatgpt-plugin/src/modules/site-architecture/internal-link-quality.ts`. The adapter is necessarily duplicated for separate runtime packaging, but the comparison logic is shared.
- Existing local `links.broken` and hosted `check_broken_links` retain their current behavior, HTTP checking limits, tool names and API contracts. This additional tool does **not** send HTTP requests, crawl links or claim that unseen links are broken.

## What the bounded review actually checks

1. Extracts up to 160 `<a href>` elements inside the first main/role=main or article; if neither exists, inspects the body as an explicitly limited fallback. Excludes `nav`, `header`, `footer`, `aside`, `template`, scripts, styles, `noscript` and explicitly hidden/aria-hidden content.
2. Counts same-origin contextual links, off-origin contextual links, fragment-only links and self-links separately. Unsafe non-HTTP link protocols, oversized href and empty href are skipped. A query-variant URL is counted as an internal link but its destination is **unverified**, not mapped to the bare path or erroneously declared broken.
3. Checks observed accessible anchor labels, considering explicit `aria-label` / `aria-labelledby`, visible anchor text, image `alt` and anchor `title` as limited static fallbacks. This is **not a rendered accessibility-tree audit** or a proof of accessibility compliance. Generic English labels such as "read more" are separate informational review leads, not conclusive SEO problems.
4. Identifies identical normalized labels pointing to multiple distinct supplied destinations, only as an ambiguity review lead.
5. Checks **exact lexical overlap** of descriptive anchor-label tokens with title/H1 tokens only if the linked destination page was also supplied; skips generic/empty/one-word labels and unknown title/H1. Zero overlap is **not semantic irrelevance**, since synonyms, multilingual terms and surrounding context are not evaluated.
6. Flags internal contextual `rel=nofollow` for review but does not speculate why the attribute exists or its indexing/ranking effects.
7. Pages with no contextual internal links and pages linking only to unsupplied targets are marked as *sample-limited observations*, not site-wide orphan pages, PageRank problems or Google's crawl behavior.

Every outcome returns counts and capped findings located by **page index** (1-8), never raw page HTML, anchor text, URL paths, secret-bearing query strings, destinations, source-title text or arbitrary external error messages. The only URL string returned is the common safe **origin**.

### Example (synthetic, no fetching)

```json
{
  "pages": [
    {
      "url": "https://example.test/guides/chair-care",
      "htmlContent": "<html><head><title>Chair care</title></head><main><h1>Chair care guide</h1><a href=\"/products/chairs\">Ergonomic office chairs</a></main></html>"
    },
    {
      "url": "https://example.test/products/chairs",
      "htmlContent": "<html><head><title>Ergonomic office chairs</title></head><main><h1>Office chairs</h1></main></html>"
    }
  ]
}
```

## Limits, privacy, uncertainty

- Per-document HTML ≤160,000 UTF-8 bytes; combined HTML ≤900,000 UTF-8 bytes per tool call.
- 1-8 supplied same-origin URLs; max length 512 characters, no URL query, fragment, credential or explicit nonstandard port. Each URL label must be unique.
- Up to 160 main-content anchors per page; up to 12 structured findings returned, with `total_findings` and `findings_truncated` retaining the bounded evidence count.
- Findings messages are fixed text and grouped counters, with no arbitrary HTML, link URLs, titles or page text. No persistent history, cookies, auth grants, live browser, extra web request, third-party service or cost.
- `coverage_limited=true` **always**: the sample cannot establish a complete site's architecture, internal PageRank, indexability or ranking changes. No broken-link checks occur; use the separately existing bounded link-status tools for approved public HTTP checks.
- A limited lexical checker cannot judge true topic/intent fit, language variants, accessibility compliance or link usefulness. Review results with human context and additional authorized supplied HTML.

## Acceptance

- Local + hosted unit tests for same-origin/relative/off-origin resolution; accessible image/link text, labelledby and hidden elements; generic/repeated/ambiguous anchors; lexical heading overlap vs unknown target; query variants; same-origin duplication, nofollow, self/fragment links and body fallback; 8x160 caps, redaction and deterministic truncation.
- Real local MCP stdio handshake and `tools/call`; hosted Worker HTTP `tools/list`/`tools/call` and no-fetch assertions; confirm unchanged existing link-status tool presence.
- Local `npm run check`, manifest sync/check, production dependency audit, npm tarball smoke; hosted `npm run check`, `npm test` and Wrangler `deploy:dry-run`.
- Independent GitHub CI must pass Local stdio, Windows installed-package, Ubuntu sandboxed screenshot and Hosted Worker jobs plus two Socket Security checks before the new PR is accepted. Leave it **open and unmerged**, no production deployment or plugin rescan.

**Next roadmap item:** P1-09 - duplicate, conflicting or mismatched metadata (M04, both).
