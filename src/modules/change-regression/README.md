# M05 - change-regression (local)

**Owns:** V10, V12, P2-01, P2-02. Baselines, comparisons, historical retention, crawler-log correlation and optional change alerts.

- **Source:** `src/modules/change-regression/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/change-regression-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/audit-history.ts` stores at most 10 compact local snapshots; hosted comparison is `chatgpt-plugin/src/site-comparison.ts`.
- **Guardrail:** No new storage, scheduler or alerts without authorization; retain only redacted bounded observations. HTTP observations remain M01.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
