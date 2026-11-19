# M01 - http-crawl (local)

**Owns:** V01-V05, P1-11, P1-13, P1-14. HTTP delivery, availability observations, bot/crawl access, redirects/canonicals, sitemap and URL variants.

- **Source:** `src/modules/http-crawl/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/http-crawl-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/network.ts`, `src/seo-auditor.ts`; registrations remain in `src/index.ts`.
- **Guardrail:** Preserve public-IP/SSRF, redirects, robots, byte/time/concurrency caps. V02 history is owned by M05.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
