# P1-07 — Supported structured-data validation

**M04 content-schema; both runtimes.** Feature implementation in a stacked PR, not production deployed. Depends on P1-06 PR #467, then P1-05 #466, P1-04 #465, P1-03 #464, P1-02 #461 and P1-01 #459.

## Interfaces and compatibility

- Local Node stdio MCP: **`schema.supported`**, accepts `{ "htmlContent": "..." }`.
- Hosted Cloudflare Worker MCP: **`validate_supported_schema`**, accepts `{ "html": "..." }`.
- Both operate **offline on one supplied HTML document**. Neither fetches schema URLs, Schema.org contexts, Google Rich Results Test, the page itself, linked images, scripts, product prices, or any remote data.
- Existing `schema.markup` (local) and `validate_schema_markup` (hosted) **retain their original syntax-only behavior and response contracts**. The new tools are additive and provide review signals instead of silently changing the meaning of older results.
- The pure M04 structural-review engine is in `src/modules/content-schema/structured-data-validation.ts`. Separate tiny Cheerio HTML adapters exist for local and hosted package isolation; they call the **same comparison engine** without separate feature logic.

## Explicitly supported review profiles

These are **selected structural checks**, not complete Schema.org or Google feature validators.

| Type | Checked evidence | Interpretation |
|---|---|---|
| Article, NewsArticle, BlogPosting | `headline` text, optional `author` object, ISO `datePublished`/`dateModified` when supplied | Google has no required Article fields; missing headline/author is a **review recommendation**, not a hard invalid markup verdict |
| Product | `name`, presence of `offers`, `review`, or `aggregateRating`; nested Offer or AggregateOffer price and explicit currency shape | The properties are part of a **Product snippet review profile**, not full merchant listing or pricing verification; a price of zero is valid |
| BreadcrumbList | At least two `itemListElement` entries; ListItem positive one-based positions, duplicates, contiguous position sequence, name and nonfinal item target | Last item target may be omitted; a visible breadcrumb trail or Google display is not verified |
| FAQPage | Question name and acceptedAnswer.text when inline, bounded arrays | Structural only; no promise of FAQ rich-result availability or eligibility |
| Organization, WebSite | Optional `name` text and provided URL shape | No identity, ownership, Knowledge Panel or Google result determination |

Schema.org namespace recognition is limited to explicit `http(s)://schema.org` context, `@vocab`, recognized prefix mappings and full Schema.org type IRIs. Inherited `@graph` contexts and bounded `@type` arrays are inspected. Unknown contexts, remote context mappings, aliases beyond the explicit supported subset, and unsupported types stay **unverified**. No external context expansion or arbitrary JSON-LD semantic inference is performed. The existing syntax tool remains available for its independent diagnostic behavior.

### Minimal example

```json
{
  "htmlContent": "<html><head><script type=\"application/ld+json\">{\"@context\":\"https://schema.org\",\"@type\":\"Product\",\"name\":\"Example\",\"offers\":{\"@type\":\"Offer\",\"price\":0,\"priceCurrency\":\"EUR\"}}</script></head><body><main>Example product</main></body></html>"
}
```

The hosted variant uses the key `"html"` instead.

### Resource and privacy limits

- One supplied static HTML document, at most **250,000 UTF-8 bytes**.
- Scan up to **12 JSON-LD scripts** with per-script cap **64,000 bytes** and up to **64 examined graph nodes**.
- Bound array/graph traversals and nested profile checks; any excluded input is reported by `blocks_skipped` and `coverage_limited`.
- Return at most **12 prioritized findings**, with exact total counts and truncation. Findings contain only fixed codes, severity, block/node number, recognized type, approved property name and controlled message.
- Raw HTML, user data, JSON parser exception text, arbitrary unknown type strings, product names, prices, links, secrets and referenced URLs **are not echoed**. No persistence or new permissions.
- `coverage_limited` is always true because this checker is a **small partial semantic subset**; a clean result means no issue in the observed subset, **not** overall validity or Google feature eligibility.

## Grounding and limitations

Google Search Central distinguishes **required and recommended fields by feature**. Article properties are recommended rather than universally required; the Product snippet documentation describes a specific name and offer/review/rating profile, and BreadcrumbList expects at least two ListItems with positions. Structured-data validity never guarantees display in Google Search. See:

- [Google Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article)
- [Google Product snippet structured data](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
- [Google Breadcrumb structured data](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)
- [Google general structured-data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)

Profiles are intentionally narrow and should be updated when source guidelines change. They **must not** be described as a substitute for Google's Rich Results Test, Search Console, actual HTML rendering, Schema.org ontology validation or human review of whether the markup truthfully describes visible page content.

## Acceptance and deployment gates

- Unit tests cover supported valid types, inherited `@graph`, explicit aliases, malformed JSON, wrong document/graph shape, missing recommended fields, malformed dates, prices and currencies, invalid breadcrumbs, FAQ questions, context/type unknowns, template exclusion, BOM, UTF-8 limits, capped script/graph samples, deterministic priority and privacy redaction.
- Real local stdio MCP `tools/list` and `schema.supported` calls; hosted Worker HTTP MCP `tools/list` and `validate_supported_schema` calls; preserve older syntax-only tools.
- Full local `npm run check`, manifests `sync:manifests`/`check:manifests`, package tarball smoke and production dependency audit. Full hosted `npm run check`, `npm test`, `npm run deploy:dry-run`.
- GitHub PR gate: Local stdio, Windows installed-package smoke, Ubuntu screenshot sandbox, Hosted Worker plus both security checks must pass before acceptance. No merge, deploy, plugin publication, tool rescan or billing changes are authorized here.

**Next ordered roadmap feature:** P1-08, internal-link quality and anchor relevance (M02, both).
