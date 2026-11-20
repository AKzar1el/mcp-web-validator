# P1-06 - Competitor search-intent evidence comparison

**Owner:** M04 content-schema; both local and hosted MCP. **Release status:** feature branch only, pending CI and review. Depends on P1-05 PR #466 and earlier stacked P1 feature PRs. No merge or production deployment in this task.

## Goal and limits

Compare **already supplied** primary and competitor HTML samples using transparent on-page evidence instead of assuming Google's search intent or scraping competitors. The local `content.competitors` tool and hosted `compare_competitor_intent` tool accept an identical input:

- `primary: {url, htmlContent}`: one authorized primary document.
- `competitors: [{url, htmlContent}, ...]`: one to six authorized competitor page documents with distinct origins, which must also differ from the primary origin.
- Optional `expected_intent`: `informational`, `commercial`, `transactional`, or `navigational`. It must be **selected by the user**; never inferred from search engine results or query text.
- Optional `query`: strict lexical token overlap against each supplied page's visible `<title>` and main `<h1>` only. No LLM, synonym expansion or semantic ranking.

Example supplied *illustrative* observation:

```json
{
  "primary": {
    "url": "https://publisher.test/article",
    "htmlContent": "<html><head><title>Seating posture</title></head><main><h1>Posture for desk work</h1></main></html>"
  },
  "competitors": [
    {
      "url": "https://chairs-store.test/product",
      "htmlContent": "<html><head><title>Ergonomic chair</title><script type=\"application/ld+json\">{\"@type\":\"Product\",\"offers\":{\"@type\":\"Offer\",\"price\":99}}</script></head><main><h1>Best ergonomic chair</h1><a href=\"/checkout\">Buy now</a></main></html>"
    }
  ],
  "expected_intent": "commercial",
  "query": "best ergonomic chair"
}
```

## Evidence inspected

- **Informational:** explicit Article/NewsArticle/BlogPosting/ScholarlyArticle, FAQPage or HowTo JSON-LD, or a substantive sectioned `<article>` sample.
- **Commercial:** Product and Review JSON-LD, comparison/review headings, pricing headings.
- **Transactional:** Offer/Offer-like structured data, main checkout/cart/booking links, purchase/book buttons and purchase forms.
- **Navigational:** explicit contact/location headings, main contact link labels and main `<address>`.

All markers are fixed signal codes, not copied marketing text. Signals in ordinary nav/header/footer/hidden markup are excluded. Titles and H1 text are tokenized transiently and **never returned**.

The comparator reports per-page signal inventories, signal counts for the caller-selected intent, query-title/H1 lexical overlap percentages, and limited review findings. A primary page missing a marker that appears on supplied competitors is an evidence **review lead**, never a claim the page is objectively worse or off-intent. Query-heading mismatches require at least two supplied competitors to show 50%+ literal query token overlap and the primary to show 0% literal overlap; synonym/translation limitations remain explicit. A one-page competitor sample is never implied to represent a SERP.

## Security and privacy

- Static HTML only, **no fetch, crawl, GSC/GA4 access, search engine query, credentials, storage, browser or third-party validator**. Supplying content must be authorized by the user.
- Up to six competitors and one primary; **150,000 UTF-8 bytes per HTML page**, **800,000 bytes combined**. Query max **160 UTF-8 bytes**; at most 12 deduped content tokens used transiently.
- Each safe `url` label must be absolute HTTP(S), max 512 chars, no query string, fragment, credentials or nonstandard port. Outputs include only **origin** for each page, not full paths, title, H1 or query.
- Parse at most four JSON-LD scripts up to 24 KB each, 160 main headings/links/buttons per category, and ten findings. Parsing/extraction limits are exposed; raw markup not returned.
- `coverage_limited` is always true: none of the supplied observations establish a real competitor set, indexing status, search demand, semantic intent, market share or Google rankings. Query/intent omissions remain explicit.

## Testing and acceptance

- Unit tests: commercial vs informational samples, information intent match, markup flags, query lexical overlap, unknown query/intent, same-origin and invalid URL rejection, hidden navigation/CTA exclusion, truncated JSON-LD, six-competitor limit, deterministic redacted result.
- Real MCP calls through local stdio and hosted Worker HTTP handler, including structured output, safe origin labels, and no competitor network access.
- Full local `npm run check` including manifest sync/check; installed npm tarball offline smoke; full hosted `npm run check`, `npm test`, `npm run deploy:dry-run`.
- Independent GitHub local, Windows, Ubuntu sandbox screenshot and hosted CI, plus security checks. No merge or deploy until separately authorized.

**Next roadmap:** P1-07 supported structured-data validation, once P1-06 is accepted.
