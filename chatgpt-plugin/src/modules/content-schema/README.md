# M04 - content-schema (hosted Worker)

**Owns:** P1-01, P1-03 through P1-07, P1-09.

- **Source:** `chatgpt-plugin/src/modules/content-schema/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/content-schema/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/audits.ts`; cross-page duplicate-title observations in `chatgpt-plugin/src/indexability-graph.ts`.
- **Guardrail:** Worker-safe static content only; rely on supplied evidence for competitor claims and product promises. No browser.

This directory is documentation-only; do not import local Node/browser modules or register new MCP tools during initialization.
