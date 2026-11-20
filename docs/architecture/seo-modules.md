# SEO diagnostics: module ownership and implementation map

> Source of truth for future SEO and website-diagnostics work. Originally scaffolded in PR #456; this map now records implementation status as individual features are merged. A planned path is never evidence that code exists.

Historical architecture baseline: `AKzar1el/mcp-web-validator` `47b3a78743c1a04d9a22c366b0819cf71c853d9e` (2026-11-18). P1 status reconciliation: 2026-11-19 after merge of P1-01 through P1-09. Revalidate against the current main SHA before future work.

## Status and runtime vocabulary

- `existing`: the named feature already functions to its documented scope; `partial`: related working pieces exist but the roadmap feature is incomplete; `planned`: no implementation of the named feature; `unavailable`: blocked by an absent authorized data source or capability. A directory or README **never** changes feature status.
- `local`: Node/stdio only; `hosted`: Cloudflare Worker only; `both`: independent local and Worker-safe implementations; `external integration`: opt-in, authorized external data or delivery is required. For `external integration`, no live connection, credentials, scheduler or persistence is included here.
- `P1-01` through `P1-14` and `P2-01` through `P2-02` are stable **architecture-map identifiers** assigned here to the previously agreed priority feature names; they are not MCP tool names or previously published API identifiers.
- `V11` is intentionally two separately owned deliverables (`V11-LAB`, `V11-FIELD`). `V02` remains one M01 feature for availability **observations**; M05, not M01, owns retention and historical comparisons.

## Six modules

| ID | Module | Local module root | Hosted module root | Ownership |
| --- | --- | --- | --- | --- |
| M01 | `http-crawl` | `src/modules/http-crawl/` | `chatgpt-plugin/src/modules/http-crawl/` | HTTP delivery, URL variants, crawl directives, availability observations, redirect chains and sitemap discovery |
| M02 | `site-architecture` | `src/modules/site-architecture/` | `chatgpt-plugin/src/modules/site-architecture/` | Internal-link topology, depth, orphan hypotheses, and multilingual hreflang/canonical clusters |
| M03 | `browser-ux` | `src/modules/browser-ux/` | Not permitted | Local-only rendered-DOM, resources, viewports, Lighthouse lab, media and interactive accessibility checks |
| M04 | `content-schema` | `src/modules/content-schema/` | `chatgpt-plugin/src/modules/content-schema/` | Content evidence, metadata, duplicates, schema, citations, freshness and search intent |
| M05 | `change-regression` | `src/modules/change-regression/` | `chatgpt-plugin/src/modules/change-regression/` | Comparisons, versioned observation history, log correlation and optional regression alerts |
| M06 | `external-metrics` | `src/modules/external-metrics/` | `chatgpt-plugin/src/modules/external-metrics/` | Optional authorized CrUX, GSC, GA4 and other external field/analytics metrics |

All module roots contain README documentation only. No new TypeScript contract is created until a real consumer determines the minimal shape, avoiding unused exports and premature cross-runtime abstraction.

## V01-V12: P0 roadmap inventory

| ID | Feature | Primary owner | Runtime | Status | Intended implementation file(s) | Required test file(s) | Related working code (not moved) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `V01` | HTTP delivery and response behavior | M01 | `both` | `partial` | L `src/modules/http-crawl/http-delivery.ts`; H `chatgpt-plugin/src/modules/http-crawl/http-delivery.ts` | L `test/http-crawl-http-delivery.test.js`; H `chatgpt-plugin/src/modules/http-crawl/http-delivery.test.ts` | src/network.ts; chatgpt-plugin/src/network.ts; chatgpt-plugin/src/site-audit.ts |
| `V02` | Availability observations (not storage or longitudinal analysis) | M01 | `both` | `partial` | L `src/modules/http-crawl/availability-observations.ts`; H `chatgpt-plugin/src/modules/http-crawl/availability-observations.ts` | L `test/http-crawl-availability-observations.test.js`; H `chatgpt-plugin/src/modules/http-crawl/availability-observations.test.ts` | src/seo-auditor.ts; chatgpt-plugin/src/audits.ts; src/audit-history.ts (storage is M05) |
| `V03` | Crawler-access matrix: robots.txt, bot policies, meta and X-Robots-Tag | M01 | `both` | `partial` | L `src/modules/http-crawl/crawler-access.ts`; H `chatgpt-plugin/src/modules/http-crawl/crawler-access.ts` | L `test/http-crawl-crawler-access.test.js`; H `chatgpt-plugin/src/modules/http-crawl/crawler-access.test.ts` | chatgpt-plugin/src/site-audit.ts; src/seo-auditor.ts; chatgpt-plugin/src/audits.ts |
| `V04` | HTTP redirect and canonical chain validation | M01 | `both` | `partial` | L `src/modules/http-crawl/redirect-canonical-chains.ts`; H `chatgpt-plugin/src/modules/http-crawl/redirect-canonical-chains.ts` | L `test/http-crawl-redirect-canonical-chains.test.js`; H `chatgpt-plugin/src/modules/http-crawl/redirect-canonical-chains.test.ts` | src/network.ts; chatgpt-plugin/src/network.ts; chatgpt-plugin/src/indexability-graph.ts |
| `V05` | Sitemap inventory and discovery coverage | M01 | `both` | `partial` | L `src/modules/http-crawl/sitemap-inventory.ts`; H `chatgpt-plugin/src/modules/http-crawl/sitemap-inventory.ts` | L `test/http-crawl-sitemap-inventory.test.js`; H `chatgpt-plugin/src/modules/http-crawl/sitemap-inventory.test.ts` | chatgpt-plugin/src/site-audit.ts; chatgpt-plugin/src/constants.ts |
| `V06` | Internal-link graph, crawl depth and orphan detection | M02 | `both` | `planned` | L `src/modules/site-architecture/internal-link-graph.ts`; H `chatgpt-plugin/src/modules/site-architecture/internal-link-graph.ts` | L `test/site-architecture-internal-link-graph.test.js`; H `chatgpt-plugin/src/modules/site-architecture/internal-link-graph.test.ts` | src/seo-auditor.ts (bounded link checks); chatgpt-plugin/src/site-audit.ts (sitemap sample only) |
| `V07` | Raw source HTML versus browser-rendered DOM | M03 | `local` | `planned` | `src/modules/browser-ux/raw-rendered-diff.ts` | `test/browser-ux-raw-rendered-diff.test.js` | src/screenshot.ts (browser rendering, not DOM comparison) |
| `V08` | Browser resource loading failures | M03 | `local` | `partial` | `src/modules/browser-ux/resource-failures.ts` | `test/browser-ux-resource-failures.test.js` | src/screenshot.ts (incomplete asset signals; no full resource audit) |
| `V09` | Mobile versus desktop render and interaction parity | M03 | `local` | `partial` | `src/modules/browser-ux/viewport-parity.ts` | `test/browser-ux-viewport-parity.test.js` | src/screenshot.ts (multiple viewports; no parity evaluation) |
| `V10` | Production change and audit-baseline comparison | M05 | `both` | `partial` | L `src/modules/change-regression/production-change-comparison.ts`; H `chatgpt-plugin/src/modules/change-regression/production-change-comparison.ts` | L `test/change-regression-production-change-comparison.test.js`; H `chatgpt-plugin/src/modules/change-regression/production-change-comparison.test.ts` | src/audit-history.ts; chatgpt-plugin/src/site-comparison.ts (not deployment causality) |
| `V11-LAB` | Lighthouse laboratory performance measurements | M03 | `local` | `planned` | `src/modules/browser-ux/lighthouse-lab.ts` | `test/browser-ux-lighthouse-lab.test.js` | src/screenshot.ts (not Lighthouse) |
| `V11-FIELD` | CrUX real-user field performance measurements | M06 | `external integration` | `planned` | L `src/modules/external-metrics/crux-field.ts`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/crux-field.ts` | L `test/external-metrics-crux-field.test.js`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/crux-field.test.ts` | none; external CrUX data not currently fetched |
| `V12` | Crawler-log correlation with observed crawl/index signals | M05 | `external integration` | `unavailable` | L `src/modules/change-regression/crawler-log-correlation.ts`; hosted only after privacy review: `chatgpt-plugin/src/modules/change-regression/crawler-log-correlation.ts` | L `test/change-regression-crawler-log-correlation.test.js`; hosted if approved: `chatgpt-plugin/src/modules/change-regression/crawler-log-correlation.test.ts` | none; authorized redacted log source not configured |

## Remaining P1 roadmap inventory

| ID | Feature | Primary owner | Runtime | Status | Intended implementation file(s) | Required test file(s) | Related working code (not moved) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `P1-01` | Same-language duplicate content | M04 | `both` | `existing` | L `src/modules/content-schema/same-language-duplicates.ts`; H `chatgpt-plugin/src/modules/content-schema/same-language-duplicates.ts` | L `test/content-schema-same-language-duplicates.test.js`; H `chatgpt-plugin/src/modules/content-schema/same-language-duplicates.test.ts` | chatgpt-plugin/src/indexability-graph.ts (duplicate titles only) |
| `P1-02` | Complete 16-locale hreflang and canonical clusters | M02 | `both` | `partial` | L `src/modules/site-architecture/multilingual-clusters.ts`; H `chatgpt-plugin/src/modules/site-architecture/multilingual-clusters.ts` | L `test/site-architecture-multilingual-clusters.test.js`; H `chatgpt-plugin/src/modules/site-architecture/multilingual-clusters.test.ts` | chatgpt-plugin/src/indexability-graph.ts; chatgpt-plugin/src/site-audit.ts |
| `P1-03` | Empty, thin or boilerplate pages | M04 | `both` | `existing` | L `src/modules/content-schema/empty-boilerplate-content.ts`; H `chatgpt-plugin/src/modules/content-schema/empty-boilerplate-content.ts` | L `test/content-schema-empty-boilerplate-content.test.js`; H `chatgpt-plugin/src/modules/content-schema/empty-boilerplate-content.test.ts` | src/seo-auditor.ts; chatgpt-plugin/src/audits.ts (general static audit only) |
| `P1-04` | Landing-page promises versus supported capabilities | M04 | `both` | `existing` | L `src/modules/content-schema/product-claims.ts`; H `chatgpt-plugin/src/modules/content-schema/product-claims.ts` | L `test/product-claims.test.js`; H `chatgpt-plugin/src/modules/content-schema/product-claims.test.ts` | none; requires supplied authoritative product evidence |
| `P1-05` | Citation, dataset, freshness and methodology consistency | M04 | `both` | `existing` | L `src/modules/content-schema/citation-methodology-consistency.ts`; H `chatgpt-plugin/src/modules/content-schema/citation-methodology-consistency.ts` | L `test/content-schema-citation-methodology-consistency.test.js`; H `chatgpt-plugin/src/modules/content-schema/citation-methodology-consistency.test.ts` | none; requires verifiable supplied evidence |
| `P1-06` | Competitor search-intent comparison | M04 | `both` | `existing` | L `src/modules/content-schema/competitor-intent-comparison.ts`; H `chatgpt-plugin/src/modules/content-schema/competitor-intent-comparison.ts` | L `test/content-schema-competitor-intent-comparison.test.js`; H `chatgpt-plugin/src/modules/content-schema/competitor-intent-comparison.test.ts` | none; optional M06 sourced signals, with authorization |
| `P1-07` | Supported structured-data validation | M04 | `both` | `partial` | L `src/modules/content-schema/structured-data-validation.ts`; H `chatgpt-plugin/src/modules/content-schema/structured-data-validation.ts` | L `test/content-schema-structured-data-validation.test.js`; H `chatgpt-plugin/src/modules/content-schema/structured-data-validation.test.ts` | src/seo-auditor.ts; chatgpt-plugin/src/audits.ts (JSON-LD syntax checks exist) |
| `P1-08` | Internal-link quality and anchor relevance | M02 | `both` | `partial` | L `src/modules/site-architecture/internal-link-quality.ts`; H `chatgpt-plugin/src/modules/site-architecture/internal-link-quality.ts` | L `test/site-architecture-internal-link-quality.test.js`; H `chatgpt-plugin/src/modules/site-architecture/internal-link-quality.test.ts` | src/seo-auditor.ts; chatgpt-plugin/src/audits.ts (bounded link status checks) |
| `P1-09` | Duplicate, conflicting or mismatched metadata | M04 | `both` | `existing` | L `src/modules/content-schema/metadata-consistency.ts`; H `chatgpt-plugin/src/modules/content-schema/metadata-consistency.ts` | L `test/content-schema-metadata-consistency.test.js`; H `chatgpt-plugin/src/modules/content-schema/metadata-consistency.test.ts` | src/seo-auditor.ts; chatgpt-plugin/src/audits.ts; chatgpt-plugin/src/indexability-graph.ts |
| `P1-10` | Media diagnostics (images, video, loading and alt evidence) | M03 | `local` | `partial` | `src/modules/browser-ux/media-diagnostics.ts` (static implementation) | `test/browser-ux-media-diagnostics.test.js` | Local `media.diagnostics` offline static evidence exists; browser asset loading and layout verification remain separate V08/V09 work |
| `P1-11` | Non-HTML indexability and HTTP directives | M01 | `both` | `partial` | L `src/modules/http-crawl/non-html-directives.ts`; H `chatgpt-plugin/src/modules/http-crawl/non-html-directives.ts` (pure shared analysis adapter) | L `test/http-crawl-non-html-directives.test.js`; H `chatgpt-plugin/src/modules/http-crawl/non-html-directives.test.ts` | Offline supplied HTTP response evidence in both MCPs; authorized live non-HTML HTTP probing and crawler observations remain unimplemented |
| `P1-12` | Browser WCAG and interactive behavior checks | M03 | `local` | `partial` | `src/modules/browser-ux/wcag-interactions.ts` | `test/browser-ux-wcag-interactions.test.js` | Local `browser.wcag` runs inert sandboxed Chromium control+Tab+native-summary observations; dynamic JS behavior, assistive technology and WCAG conformance remain untested |
| `P1-13` | HTTPS, mixed content and HTTP security signals | M01 | `both` | `partial` | L `src/modules/http-crawl/https-security.ts`; H `chatgpt-plugin/src/modules/http-crawl/https-security.ts` (shared pure adapter) | L `test/http-crawl-https-security.test.js`; H `chatgpt-plugin/src/modules/http-crawl/https-security.test.ts` | Offline `http.security` / `review_https_security` inspect supplied same-host HTTP/HTTPS response headers and static HTML declarations; live TLS, redirects, browser mixed-content enforcement and dynamic resources remain unverified |
| `P1-14` | URL variants (scheme, www, slash, case, query) | M01 | `both` | `partial` | L `src/modules/http-crawl/url-variants.ts`; H `chatgpt-plugin/src/modules/http-crawl/url-variants.ts` (pure shared analyzer adapter) | L `test/http-crawl-url-variants.test.js`; H `chatgpt-plugin/src/modules/http-crawl/url-variants.test.ts` | Local `http.variants` and hosted `review_url_variants` compare bounded offline caller-observed status, redirects, canonical declarations and optionally provided HTTP 200 SHA-256 fingerprints; no HTTP requests, dynamic body comparisons, real redirect chains or selected Google canonical |

## Remaining P2 roadmap inventory

| ID | Feature | Primary owner | Runtime | Status | Intended implementation file(s) | Required test file(s) | Related working code (not moved) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `P2-01` | Historical comparisons across saved audit versions | M05 | `both` | `partial` | L `src/modules/change-regression/historical-comparisons.ts`; H `chatgpt-plugin/src/modules/change-regression/historical-comparisons.ts` (pure shared adapter) | L `test/change-regression-historical-comparisons.test.js`; H `chatgpt-plugin/src/modules/change-regression/historical-comparisons.test.ts` | Local read-only `audit.trends` batch-reads 2–10 exact saved IDs; hosted `compare_historical_audits` compares supplied snapshots without storage. Both expose only redacted sampled-page cohort metrics, separate missing checks, and conservatively gate issue-group change. No scheduler/automatic capture or site-wide historical measurements |
| `P2-02` | Configurable regression monitoring and optional alerts | M05 | `external integration` | `planned` | L `src/modules/change-regression/regression-alerts.ts`; H if authorized: `chatgpt-plugin/src/modules/change-regression/regression-alerts.ts` | L `test/change-regression-regression-alerts.test.js`; H if authorized: `chatgpt-plugin/src/modules/change-regression/regression-alerts.test.ts` | src/audit-history.ts; chatgpt-plugin/src/site-comparison.ts (no scheduler/alerts) |

## Optional authorized metric adapters (not new roadmap checks)

| ID | Feature | Primary owner | Runtime | Status | Intended implementation file(s) | Required test file(s) | Related working code (not moved) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `INT-GSC` | Optional authorized GSC signals (not a P1/P2 check) | M06 | `external integration` | `planned` | L `src/modules/external-metrics/gsc-adapter.ts`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/gsc-adapter.ts` | L `test/external-metrics-gsc-adapter.test.js`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/gsc-adapter.test.ts` | none; requires user-scoped OAuth/property authorization |
| `INT-GA4` | Optional authorized GA4 signals (not a P1/P2 check) | M06 | `external integration` | `planned` | L `src/modules/external-metrics/ga4-adapter.ts`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/ga4-adapter.ts` | L `test/external-metrics-ga4-adapter.test.js`; H if authorized: `chatgpt-plugin/src/modules/external-metrics/ga4-adapter.test.ts` | none; requires user-scoped OAuth/property authorization |

### Exact path and test conventions

- Each table row names the current implemented or proposed `.ts` feature path and a dedicated test location. A `planned` path may not exist; a `partial` path may cover only a bounded subset. `L` and `H` mean local and hosted runtimes, not a guarantee of independent engine duplication.
- Local tests live directly under `test/` as `test/<module>-<feature>.test.js`, because the current local script runs `node --test test/*.test.js` (it does **not** include nested `test/**`). Tests import built outputs from `dist/modules/...` after `npm run build`.
- Hosted Vitest discovers `chatgpt-plugin/src/modules/<module>/<feature>.test.ts` with the existing `vitest run`. Hosted TypeScript uses `moduleResolution: Bundler`; local uses `NodeNext`. Verify both separately before any shared contract, rather than importing local modules into the Worker.
- These are destinations for **new feature logic**, not instructions to move legacy code. Existing registration files remain integration boundaries. A change to an MCP tool is a separate, explicitly authorized task.

## Existing implementations and their future logical owners

| Working file | Logical future ownership | Existing tests / important limitation |
| --- | --- | --- |
| `src/seo-auditor.ts` | M04 metadata and JSON-LD, M01 bounded link observations, static a11y signals relevant to M03 | `test/seo-auditor.test.js`; no browser DOM parity |
| `src/network.ts` | M01 local URL/HTTP transport, public-host and redirect protections | `test/network.test.js`; do not weaken SSRF defenses |
| `src/index.ts` | Existing MCP registration and wiring (not an SEO module) | `test/mcp.integration.test.js`, `test/audit-history.mcp.test.js`; leave tool schemas untouched |
| `src/audit-history.ts` | M05 local bounded snapshot retention and retrieval | `test/audit-history.test.js`; at most 10 snapshots, oldest evicted on the 11th |
| `src/screenshot.ts`, `src/screenshot-proxy.ts` | M03 local isolated Chromium screenshots and asset-observation support | `test/optional-screenshot-runtime.test.js`; not full WCAG, Lighthouse or DOM diff |
| `chatgpt-plugin/src/audits.ts` | M04 static SEO/schema, M01 link observations, static a11y signals related to M03 | `chatgpt-plugin/src/validators.test.ts`, `chatgpt-plugin/src/site-audit.test.ts`; **no hosted browser** |
| `chatgpt-plugin/src/network.ts` | M01 Worker-safe bounded public fetch and redirect protections | `chatgpt-plugin/src/network.test.ts`; public URLs only |
| `chatgpt-plugin/src/site-audit.ts` | M01 robots/sitemap/page observations; M02 sampled cross-page inputs | `chatgpt-plugin/src/site-audit.test.ts`; max 8 pages/call, no recursive HTML crawl |
| `chatgpt-plugin/src/indexability-graph.ts` | M02 sampled canonical/noindex/hreflang graph | `chatgpt-plugin/src/indexability-graph.test.ts`; only observed sample, not Google index status |
| `chatgpt-plugin/src/site-comparison.ts` | M05 pure comparison of provided audit snapshots | `chatgpt-plugin/src/site-comparison.test.ts`; no Worker persistence, no proof of deployment causation |
| `chatgpt-plugin/src/worker.ts` | Existing hosted MCP registration, constraints, responses and rate limits (not an SEO module) | `chatgpt-plugin/src/worker.test.ts`; leave endpoints, schemas and privacy policy unchanged |

## Cross-module dependencies (not shared ownership)

1. **V02**: M01 emits bounded HTTP/availability observations; **M05** owns storage, retention and time comparisons. Existing local history retention is **10 versions maximum**. Do not write browser snapshots, raw HTML, request tokens or query-bearing URLs to history.
2. **V04 / P1-02**: M01 owns HTTP redirects and canonical-chain fetch observations. M02 owns cross-page canonical/hreflang cluster reasoning; it consumes sanitized observations rather than creating a second crawler. Existing indexability graph stays in place.
3. **V05 / V06**: M01 owns crawl discovery/sitemaps and robots gating; M02 owns graph edges, depth and potential orphans. Missing URLs, unavailable targets and incomplete page samples must not be misreported as passing or orphaned.
4. **V07-V09 / V11**: M03 only does live browser/lab work. V11-LAB stays local in M03; V11-FIELD is independently sourced by M06 through an authorized CrUX API. No Lighthouse or browser package may be imported into a hosted Worker.
5. **V10 / V12 / P2-02**: M05 owns comparison/regression rules; M01 provides recorded observations, M06 may provide authorized external metrics, and release metadata/logs may be correlated **only when actually supplied**. Correlation is not causal proof.
6. **P1-06**: M04 owns evidence-based search-intent comparison. M06 may provide approved search/analytics metrics, but permission to evaluate one site never authorizes scraping unrelated competitors or accessing a private GSC property.

## Runtime, security, privacy and resource boundaries

- **Local**: `src/` is the Node/stdio MCP service. Browser capture and workspace-file access exist already but are only permitted under the existing user authorization, sandbox, path, size and network controls. Do not add browser behaviors to the hosted side.
- **Hosted**: `chatgpt-plugin/src/` is a separately deployed Cloudflare Worker. It has no browser, screenshot, arbitrary local filesystem or crawler-log access; its existing site audit is capped (8 pages/call, 2 concurrent fetches, 4 sitemaps, 250 sitemap URLs). Do not introduce background scheduling, global crawling or storage by scaffolding.
- **External integrations**: CrUX, GSC, GA4, crawler logs and alert transports require their own explicit data-scope, consent, privacy, rate/cost and credential design before implementation. GSC/GA4 must be property-scoped. A hosted log adapter can be considered only for bounded, redacted, authorized evidence; no direct file access.
- **HTTP safety**: preserve public-IP/SSRF checks, redirect boundaries, rate and byte limits, robots policies and redaction. Do not log/store raw markup, cookies, private URL parameters, personal data or credential-bearing URLs. Treat upstream availability, Lighthouse lab results, CrUX field data and GSC metrics as distinct signals.
- **No integration in this PR**: Do not alter MCP registrations (`src/index.ts`, `chatgpt-plugin/src/worker.ts`), JSON schemas, endpoints, permissions, manifests, dependency lists, build config, persistence, network behavior or deployed resources.

## Agent workflow for implementing a roadmap item

1. Find its exact feature ID in this file; verify **one primary owner**, support boundary, current status and related existing code.
2. Read the owning module's local or hosted README and relevant existing implementation and tests; check the current main revision before editing.
3. Create **only** the intended implementation file(s) in the row; reuse or call legacy logic where safe. Keep local and hosted runtimes isolated; no cross-runtime imports without both compiler/Worker verification.
4. Add the listed dedicated tests, including negative cases, inaccessible/missing data, timeouts, coverage limits and SSRF/privacy invariants as applicable. Do not fabricate passing findings or use a directory as feature evidence.
5. Run local `npm run check`, `npm test`, `npm run build`; for hosted code also run `cd chatgpt-plugin`, `npm run check`, `npm test`, `npm run deploy:dry-run`. Follow `CONTRIBUTING.md` and CI.
6. Wire into **existing** MCP tools **only when separately requested**, with schema/response/permission review. Do not deploy or publish automatically.
7. Update this map's status and source/test locations based on verified behavior, stating incomplete coverage and authorization limits clearly.
