# Web Validator: evidence-quality and productivity audit (2026-11-21)

**Scope:** local MCP Web Validator on top of merged V13, plus regression checks for the separately hosted Worker. This is a targeted, source-backed quality audit, not a claim that every real-world situation or every MCP tool has been exhaustively exercised.

## Confirmed failures and repairs

| Priority | Finding before patch | Reproduction | Repair | Evidence after patch |
| --- | --- | --- | --- | --- |
| High | V10 `audit.production_change` accepted `2026-02-30T09:00:00Z` and labeled two invented observations `comparable_snapshot`. | The Node `Date.parse` normalizes February 30 to March 2. A direct analyzer call demonstrated the false verdict. | A shared dependency-free, calendar-valid `strictObservationTime` rejects impossible dates and invalid clock/timezone fields before parsing. | Red-green regression in `test/change-regression-production-change-comparison.test.js`; leap years and offset-preserving positive cases |
| High | Historical site-audit comparisons accepted the same impossible observation timestamp. | New history comparison test failed before implementation, confirming acceptance of invalid chronology. | The same strict observation-time parser now validates stored/supplied historical `saved_at`. | Red-green regression in `test/change-regression-historical-comparisons.test.js`; 2,520 calendar boundary candidates across leap/century years in focused parser test |
| Medium | Six frequently used tools returned code/count summaries without user-oriented next steps. | Real MCP incident workflow initially stopped at `http.delivery` and then `browser.resource_failures` because their narratives lacked `**Next step:**`; other four handler implementations showed the same pattern. | Shared `toolContent`-based, bounded, escaped priority findings and evidence-specific next steps for `http.delivery`, `http.availability`, `http.redirect_chain`, `crawler.access`, `site.sitemaps`, `browser.resource_failures`. | A complete 10-tool real-stdio workflow now passes; reporting unit tests cover information-only cases, Markdown/HTML injection, prioritization and redacted output |

## End-to-end functional and usability check

`test/seo-incident-productivity.integration.test.js` creates an actual MCP stdio client, discovers all **39 tool contracts**, and exercises ten read-only synthetic incident workflows:

1. `audit.production_change`: identify a newly declared `noindex`
2. `http.delivery`: distinguish HTTP 403 from Cloudflare challenge evidence
3. `http.availability`: identify intermittent HTTP 503 from three historical samples, not claim uptime
4. `crawler.logs`: distinguish observed 403 and 429 around a cutover; remain offline and avoid claiming verified Googlebot
5. `browser.resource_failures`: separate script HTTP 404, API transport timeout, and intentional tool-policy block
6. `crawler.access`: separate robots disallow from a noindex declaration for two crawler profiles
7. `http.redirect_chain`: identify a complete redirect leading to a noindex destination
8. `site.sitemaps`: correlate a submitted page with independent 404/noindex evidence
9. `performance.crux_field`: assess supplied, device-scoped CrUX p75 values while never fetching a site or claiming ranking effects
10. `seo.metadata`: report missing on-page signals

**Result:** 10/10 passed. Every response had structured data plus an explicit actionable next step and stayed under a 7,000-character human narrative cap. Test-only private sentinel values did not appear in outputs. No URLs/log content or credentials were sent over the network.

**One real public canary:** The local `http.delivery` MCP tool made one bounded, read-only request to `https://digestseo.com/`, returned a valid `live_public_http_probe` result with HTTP **200**, **zero** observed HTTP errors and **zero** Cloudflare challenge signals, and included its human-oriented next step. This is a single sampling instant, not proof of continuous delivery, verified Googlebot access, a site-wide crawl, or ranking recovery.

**Timing:** Two Windows runs measured **561 ms** and **681 ms** combined MCP tool execution across these ten **synthetic offline** scenarios (not including MCP initialization/connection, which varies substantially under Windows host contention). This is a regression baseline for trivial fixtures, **not** a measured performance improvement over the previous release, production website speed, a user study, or a real-world SEO diagnostic accuracy benchmark.

## Independent validation gates

| Check | Outcome |
| --- | --- |
| TypeScript root build | Pass |
| Full local Node regression | **802/802 passed**, zero failed |
| Hosted Worker TypeScript | Pass |
| Hosted Worker Vitest | **687/687 passed**, 29 files |
| Local production dependency audit | **0 vulnerabilities** |
| Hosted production dependency audit | **0 vulnerabilities** |
| Tool manifest consistency | Pass; **39** registered tools |
| `npm pack --dry-run --json` | Pass; 194 package entries |
| Wrangler Worker bundle build | Pass as **dry-run only** |
| `git diff --check` | Pass |
| Independent PR and post-merge CI | Required before merge; see the linked PR for actual results |

## Deliberately preserved limits and open research

- Tools and test fixtures are synthetic/sampled. **Actual production SEO diagnosis needs corroborated logs, Search Console data and authorization to inspect a site.** This test does not certify Google indexing or rank recovery.
- The Lighthouse tool still measures isolated, inert HTML only; a full-resource test needs a separate reviewed browser/network architecture.
- Direct CrUX queries require the existing free `CRUX_API_KEY`; no key was accessed, created, stored or sent.
- Googlebot source-IP checks are explicitly opt-in, based on Google's **current** published ranges, and cannot prove historical ownership or indexing.
- Long Windows clean-room npm installs can hit host-side timeouts. GitHub's independent Windows and Ubuntu installed-package tests are the required release proof. Do not bypass them or disable browser isolation.
- Vitest startup/transform overhead is significant on this resource-constrained Windows machine. Changing `isolate` or worker counts could make tests faster but risks cross-test state leakage; this batch deliberately keeps the test runner's safety/behavior unchanged.

## Reproduction and rollback

- Focused: `npm run build` then `node --test test/change-regression-strict-observation-time.test.js test/change-regression-production-change-comparison.test.js test/change-regression-historical-comparisons.test.js test/presentation.test.js test/seo-incident-productivity.integration.test.js`
- Full local: `node --test --test-concurrency=1 test/*.test.js`
- Hosted: `npm run check --prefix chatgpt-plugin`, `npm run test --prefix chatgpt-plugin -- --reporter=dot`
- Release: `npm run check:manifests`, `npm pack --dry-run --json`, `npm run deploy:dry-run --prefix chatgpt-plugin`
- Rollback: revert only the eventual isolated audit PR merge if a validated regression is discovered; do not reset unrelated workers or their worktrees.

**No npm release, live Cloudflare Worker deployment, Codexify restart or parallel-agent process mutation is authorized or performed in this audit.**
