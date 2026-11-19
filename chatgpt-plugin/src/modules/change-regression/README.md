# M05 - change-regression (hosted Worker)

**Owns:** V10, V12, P2-01, P2-02.

- **Source:** `chatgpt-plugin/src/modules/change-regression/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/change-regression/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/site-comparison.ts` provides pure audit comparison; no Worker snapshot storage.
- **Guardrail:** Do not add storage or scheduler. Crawler-log correlation requires separately authorized, bounded, redacted evidence; hosted support requires privacy review.

This directory is documentation-only; do not import local Node/browser modules or register new MCP tools during initialization.
