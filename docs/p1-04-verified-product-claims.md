# P1-04 — product promise-to-tool-registry consistency

**Owner:** M04 content-schema; **status:** implemented in source pending separate stacked PR and CI. Depends on P1-03 PR #464 (which depends on P1-02 #461 and P1-01 #459). No merge or production deployment in this task.

## Interfaces

- Local `product.claims`: caller supplies either `htmlContent` or one authorized query-free public HTML `url`. The supplied HTML path is fully offline; URL mode reuses the local SSRF-protected HTTP fetch, restricting response media type and byte count.
- Hosted `verify_product_claims`: accepts either bounded `html` or one public `public_url`, reuses the hosted Worker safe HTML fetch; no site crawl, validator.nu call, JavaScript execution or storage. Hosted `tools/list` gains precisely one read-only tool.
- A single pure TypeScript comparison engine in `src/modules/content-schema/product-claims.ts` is shared across both runtimes. Local and Worker use separate Cheerio adapters because each is a separately installed Node/Worker package.

## Evidence model and strict limitations

The analyzer examines **explicit visible claims in static main-content HTML**, not arbitrary marketing prose. Specifically, it detects:

1. A hosted list headed **Public ChatGPT capabilities** (or an explicit hosted tools heading), or an explicitly headed local MCP tools list. It reads individual inline `<code>` tool names and ignores hidden elements, navigation, scripts, templates, footers and sample code blocks.
2. The specific bounded statement **Site batch Up to N pages** (hosted only) and the registered `audit_public_site.max_pages` schema maximum. Larger advertised limits are contradicted. Missing numeric schema evidence is **unverifiable**, never falsely supported or unsupported.
3. Local screenshot availability versus registered `screenshot.capture`; hosted no-screenshot claims versus the hosted catalog; hosted read-only claims versus actual registered tool `annotations.readOnlyHint`.

The registry is obtained from the **actual running SDK tool-registration map**, not manually maintained data. The user-facing result explicitly distinguishes:

- `consistent_claims`: matching registered tool or schema information;
- `contradicted_claims`: tool absent, advertised batch exceeds registered maximum, or contradictory annotation/screenshot scope;
- `unverified_claims`: absent/incomplete registration metadata or unsupported/ambiguous evidence.

**Critical:** a registered tool is not proof that calling it succeeds, that live external services are healthy, or that search engines will index or rank a page. Semantic claim adjudication, competitor comparison and crawler-based evidence are not claimed here. When no explicit tools listing is found for the requested surface, `coverage_limited=true` even if an isolated promise is consistent.

## Safety, caps and testing

- HTML is limited to 250,000 UTF-8 bytes. At most 20 distinct inline tool labels, 10 returned findings, two independent runtime catalogs, 64 registered catalog tools and bounded visible prose scanning. Input HTML, raw claims, secret-bearing URLs and scripts are not returned. The tool rejects providing both/neither HTML and URL.
- No new storage, API keys, auth scopes, subscription costs, service workers or direct access to the other runtime's secret metadata. Hosted comparisons are checked only against the hosted server; local checks against the local server. No silent state changes, publishing or deployment.
- Local verification: `npm run check`, `npm test`, `npm run build`, `npm run check:manifests`, installed npm package smoke, and genuine stdio MCP calls on synthetic input and the existing public DigestSEO product page.
- Hosted verification: `npm run check`, `npm test`, `npm run deploy:dry-run`, Worker MCP HTTP initialize/tools-list and actual `verify_product_claims` calls on supplied and mocked safe fetched HTML.
- Adversarial cases: fabricated tool, inflated page cap, incomplete catalog, mismatched read-only annotation, hosted/local screenshot distinction, inert/nav/footer/pre code tags, secret strings, UTF-8 size cap, absent tool listing, and failure behavior.
- Do not merge, deploy or claim production behavior until CI and independent review complete. The live product page can differ from the current source registry while these stacked branches remain unmerged.

P1-04 completes the fourth item in the requested ordered P1 roadmap; later items have not been implemented by this branch.
