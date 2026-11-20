# M05 - change-regression (hosted Worker)

**Owns:** V10, V12, P2-01, P2-02.

- **Source:** `chatgpt-plugin/src/modules/change-regression/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/change-regression/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/site-comparison.ts` provides pure audit comparison; no Worker snapshot storage.
- **Guardrail:** Do not add storage or scheduler. Crawler-log correlation requires separately authorized, bounded, redacted evidence; hosted support requires privacy review.

P2-01's `historical-comparisons.ts` reexports the exact local M05 pure analyzer
without Node imports. Hosted `compare_historical_audits` accepts 2–10 **caller-
supplied** timestamped bounded compact audit snapshots; unlike local
`audit.trends`, it **cannot** access local history IDs and does not retain data.
No schedules, browser, filesystem or new HTTP fetches were added. See
`docs/p2-01-historical-comparisons.md`.

P2-02 adds a thin Worker-safe `regression-alerts.ts` re-export of the exact
local pure evaluator. Hosted MCP `preview_regression_alerts` accepts only
caller-supplied timestamped audit versions and bounded per-call thresholds,
returns **unsent dry-run** candidates, and retains no settings or history.
No background scheduler, email/webhook/notification delivery, GSC/GA4 or
browser/network/storage permission. See
`docs/p2-02-manual-regression-alert-preview.md`.
