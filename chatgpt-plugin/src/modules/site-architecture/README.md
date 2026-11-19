# M02 - site-architecture (hosted Worker)

**Owns:** V06, P1-02, P1-08.

- **Source:** `chatgpt-plugin/src/modules/site-architecture/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/site-architecture/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/indexability-graph.ts`, `chatgpt-plugin/src/site-audit.ts`.
- **Guardrail:** Keep graph findings sample-scoped. Never assert full link depth, orphan status, or indexing from absent pages.

This directory is documentation-only; do not import local Node/browser modules or register new MCP tools during initialization.
