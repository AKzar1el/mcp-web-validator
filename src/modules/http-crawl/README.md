# M01 - http-crawl (local)

**Owns:** V01-V05, P1-11, P1-13, P1-14. HTTP delivery, availability observations, bot/crawl access, redirects/canonicals, sitemap and URL variants.

- **Source:** `src/modules/http-crawl/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/http-crawl-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/network.ts`, `src/seo-auditor.ts`; registrations remain in `src/index.ts`.
- **Guardrail:** Preserve public-IP/SSRF, redirects, robots, byte/time/concurrency caps. V02 history is owned by M05.

V01 adds the bounded point-in-time `http.delivery` response probe.
V02 adds shared `http.availability` sampled outcome analysis (2–48 supplied
observations or two/three live HTTP probes). The optional local ten-record
`availability.history` archive lives in M05 at
`src/modules/change-regression/availability-history-store.ts`. Hosted
`review_availability_history` has **no** persisted state, background scheduler
or uptime-certification claim. See `docs/v02-availability-history.md`.

V03 `crawler.access` and hosted `review_crawler_access` compare crawler
product-token robots rules with explicit static meta and X-Robots-Tag evidence,
or inspect robots.txt plus one authorized page with the service's own UA.
Crawler access and indexing are intentionally separate and unknown evidence is
not reported as healthy. See `docs/v03-crawler-access.md`.

V04 `http.redirect_chain` and hosted `review_redirect_canonical_chains`
validate ordered HTTP Location observations, sampled destination status,
Google-applicable static noindex declarations and canonical chains/cycles.
An explicit expected destination is required before declaring a wrong target;
unobserved destinations are unknown, not presumed broken. See
`docs/v04-redirect-canonical-chains.md`.

V05 `site.sitemaps` and hosted `review_sitemap_inventory` review bounded
XML/text sitemap documents, child sitemap coverage, lastmod anomalies and
duplicates, alongside independently observed page redirect/noindex/canonical
conflicts. Live fetch reads at most three sitemap documents and never crawls
their listed pages. See `docs/v05-sitemap-inventory.md`.

P1-11 now provides a bounded **offline HTTP response-observation analyzer** in
`non-html-directives.ts`, exposed through local MCP `http.directives`. It
parses supplied headers only; no binary download, URL probing or crawler
verification. See `docs/p1-11-non-html-http-directives.md`. Live non-HTML
probes, variant tests and other M01 features require separate work.

P1-13 adds local `http.security` using the same shared pure
`https-security.ts` analyzer as hosted `review_https_security`. It examines
bounded, supplied HTTP/HTTPS status, Location/HSTS/CSP/referrer/nosniff/framing
headers and static mixed-content, CSS and form-action declarations. There is
**no network fetch, browser, TLS handshake, certificate validation or
security verdict**. See `docs/p1-13-https-security.md` for contracts and limits.

P1-14 adds local `http.variants` through a pure shared `url-variants.ts`
analyzer. Its hosted adapter reexports the same implementation.
Caller-supplied URL/status/Location/canonical/body-SHA observations are checked
across explicit HTTP/HTTPS, apex/www, slash, ASCII path case and query candidate
variants without any URL fetch, redirect following or SEO canonical-selection
assertions. Case/query differences do **not** imply duplicate pages; see
`docs/p1-14-url-variants.md` for bounds, sample input and caveats.
