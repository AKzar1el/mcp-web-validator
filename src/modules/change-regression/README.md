# M05 - change-regression (local)

**Owns:** V10, V12, P2-01, P2-02. Baselines, comparisons, historical retention, crawler-log correlation and optional change alerts.

- **Source:** `src/modules/change-regression/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/change-regression-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/audit-history.ts` stores at most 10 compact local snapshots; hosted comparison is `chatgpt-plugin/src/site-comparison.ts`.
- **Guardrail:** No new storage, scheduler or alerts without authorization; retain only redacted bounded observations. HTTP observations remain M01.

V10 is the shared offline `production-change-comparison.ts` analyzer, exposed as
local `audit.production_change` and hosted `compare_production_snapshots`.
Two caller-supplied timestamped HTML bodies of one page are compared for
SHA-256 byte/main-text fingerprints, static metadata, canonical/noindex and
bounded link differences. Failed HTTP delivery suppresses content-delta claims.
V10 does not save or fetch any HTML, infer the deployment responsible or
replace P2-01's compact multi-page audit history. See
`docs/v10-production-change-comparison.md`.

P2-01 implements the **shared pure** `historical-comparisons.ts` analyzer,
exposed through local read-only `audit.trends` (2–10 exact existing saved IDs,
oldest first). The local `audit-history.ts` batch read preserves the existing
single guarded 10-snapshot archive, evictions and symlink protections. There
are no history writes, new captures, scheduled checks, remote requests or
site-wide conclusions. See `docs/p2-01-historical-comparisons.md`.

P2-02 now implements an **offline, manual-only** `regression-alerts.ts`
evaluator with read-only `audit.monitor`. It compares the latest adjacent
sample from existing `audit.history` saved IDs using the shared P2-01
historical analyzer, with bounded per-call thresholds and 1–4-step optional
regression persistence. It previews alert candidates but **never sends any
notification, starts a scheduler, edits saved history, fetches URLs, or connects
GSC/GA4**. Coverage loss and sitemap drift are review-only; source gaps
suppress defect candidates. See `docs/p2-02-manual-regression-alert-preview.md`.
External alert delivery/automated checks remain explicitly out of scope.
