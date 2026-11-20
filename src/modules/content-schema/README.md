# M04 - content-schema (local)

**Owns:** P1-01, P1-03 through P1-07, P1-09. Content/metadata duplication, schema checks, evidence quality, citations, freshness, product-claim support and search intent.

- **Source:** `src/modules/content-schema/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/content-schema-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/seo-auditor.ts` metadata/JSON-LD; `chatgpt-plugin/src/audits.ts` is its hosted counterpart.
- **Guardrail:** Do not invent source evidence, competitor claims, rich-result eligibility or site-wide coverage; keep data bounded.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
