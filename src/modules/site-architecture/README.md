# M02 - site-architecture (local)

**Owns:** V06, P1-02, P1-08. Internal-link graph, crawl depth, orphan hypotheses, multilingual canonical/hreflang clusters and link quality.

- **Source:** `src/modules/site-architecture/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/site-architecture-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/seo-auditor.ts` link checks; hosted graph is `chatgpt-plugin/src/indexability-graph.ts`.
- **Guardrail:** Use M01 crawl observations; never classify unsampled/unreachable pages as confirmed orphans or indexing failures.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
