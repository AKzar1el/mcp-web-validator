# M01 - http-crawl (local)

**Owns:** V01-V05, P1-11, P1-13, P1-14. HTTP delivery, availability observations, bot/crawl access, redirects/canonicals, sitemap and URL variants.

- **Source:** `src/modules/http-crawl/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/http-crawl-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/network.ts`, `src/seo-auditor.ts`; registrations remain in `src/index.ts`.
- **Guardrail:** Preserve public-IP/SSRF, redirects, robots, byte/time/concurrency caps. V02 history is owned by M05.

P1-11 now provides a bounded **offline HTTP response-observation analyzer** in
`non-html-directives.ts`, exposed through local MCP `http.directives`. It
parses supplied headers only; no binary download, URL probing or crawler
verification. See `docs/p1-11-non-html-http-directives.md`. Live non-HTML
probes, variant tests and other M01 features require separate work.
