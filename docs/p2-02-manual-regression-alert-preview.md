# P2-02 — Manual regression monitoring and alert previews (dry-run phase)

**Owner:** M05 `change-regression`. **Local:** `audit.monitor`. **Hosted:** `preview_regression_alerts`. **Stage:** **partial, manual/dry-run only**. This is the final currently planned P1/P2 check; **automatic monitoring and alert delivery are intentionally not implemented**, and GSC/GA4 integrations are explicitly out of scope.

## Why this limited first phase?

Historical audit snapshots can be missing pages, use different sitemap selections or record validator outages. Firing real notifications from such evidence would generate false alarms. This phase provides a **manually invoked, read-only simulation**, so users can tune thresholds and check behavior before considering an independently authorized scheduler or delivery channel.

There is **no live site request, periodic job, background task, email, webhook, push message, database, stored rule, notification destination, GSC or GA4**. All alert-like output is a controlled **preview candidate** requiring human review. Zero candidates is **not** a statement that a whole website is healthy.

## Two existing-source entrypoints

### Local — saved archive only

First use `audit.history` with `action: "list"` to see available IDs, then invoke:

```json
{
  "ids": [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  ],
  "dry_run": true,
  "policy": {
    "min_regressed_pages": 1,
    "min_net_error_increase": 2,
    "min_net_warning_increase": 2,
    "min_coverage_lost_pages": 1,
    "consecutive_regressing_steps": 1,
    "review_coverage_loss": true,
    "review_sitemap_drift": true
  }
}
```

These UUIDs are **examples only**: caller must use real saved IDs, **oldest-to-newest**. The input requires **2–10 unique existing records**. Local `getAuditHistoryVersions` reads the existing guarded archive once; this tool never writes, evicts or repairs history. Missing, reversed, corrupt or evicted records cause safe failure without any delivery.

### Hosted — caller-supplied, stateless

Call `preview_regression_alerts` with exactly the same `dry_run: true` and optional `policy`, plus `versions` instead of IDs. `versions` is a list of **2–10 actual saved `{ saved_at, snapshot }` audit records** with offset-aware ISO timestamps and the compact preexisting `audit_public_site` fields; use the format in [P2-01 historical comparison examples](p2-01-historical-comparisons.md). The Worker does **not** read the local saved-ID store or persist source snapshots and cannot send anything.

The input schema accepts **only** `dry_run: true`. Supplying `false`, an email address, webhook destination, external API key, cron expression or unsupported policy field fails validation.

## Configurable rules

| Rule | Per-call parameter | Default | Decision when threshold is reached |
| --- | --- | ---: | --- |
| `regressed_pages` | `min_regressed_pages`, integer 1–8 | 1 | **Unsent preview candidate**, only for the latest exactly matched, fully checked, fully comparable page sample |
| `net_error_increase` | `min_net_error_increase`, integer 1–10,000 | 1 | **Unsent preview candidate** when the net error increase across completed matched pages meets the bound |
| `net_warning_increase` | `min_net_warning_increase`, integer 1–10,000 | 1 | **Unsent preview candidate** when the completed matched pages' net warning increase meets the bound |
| `coverage_loss` | `min_coverage_lost_pages`, integer 1–8 | 1 | **Review-only** notice: a previously completed validator check is now incomplete; not a page regression |
| `sitemap_drift` | `review_sitemap_drift`, boolean | true | **Review-only** notice: discovery fingerprint changed; it is not an indexing/traffic alarm |

Optional `consecutive_regressing_steps` is an integer **1–4** (default **1**). For values greater than 1, only the **regressed-pages** rule additionally requires that many consecutive comparable adjacent transitions to meet its threshold. If there is insufficient history or a partial prior transition, that rule is **suppressed**, not guessed or triggered.

Set `review_coverage_loss: false` or `review_sitemap_drift: false` to disable those two **review-only** observations for one invocation. **Policy settings are not stored** anywhere and do not change the default of the next call.

## Evidence gates and output

- The local and hosted MCPs call the **same shared P2-01 pure historical analyzer** before checking policies; both receive the same strict compact history validity, safe URL, cross-origin, timestamp, size and sample-coverage guards.
- Only the **latest adjacent pair** is eligible for a defect **preview candidate**. It must be `comparable_sample`: identical selected pages and discovery fingerprint, a complete check for every shared page, no truncated or partial coverage. Source timestamps must have unambiguous order.
- An incomplete validator, changed sitemap sample, no overlap, unknown completion or equal timestamps **suppresses all defect candidates**. A validated missing check can still emit a *review-only* coverage warning. An observed changed discovery fingerprint can emit a *review-only* drift warning.
- An improved or below-threshold sampled comparison returns `no_candidate`, **not** `healthy`, `passed`, or `site_clean`.
- Outputs have at most **five fixed rules**, each with `preview_candidate`, `review_only`, `suppressed`, `below_threshold` or `disabled`, and a bounded reason code, latest observed number and configured threshold.
- `candidate_count` is **not** the number of delivered alerts; `notifications_sent: 0`, `delivery_enabled: false`, `scheduler_enabled: false`, `manually_invoked: true`, `dry_run: true` and `external_integrations_used: false` are *invariants* of every success and failure result.
- The evaluator returns **no raw page URL, query, audit-history UUID, source timestamp, issue text, discovery hash or secret**. All text is controlled and generic. It does not make a Google ranking/traffic/canonical claim, prove a full-site SEO regression, or identify traffic causality.

## Test sequence and launch gate

1. **Pure rule tests**: positive regression, increased errors/warnings, threshold independence, persistence streaks, invalid configurations, ambiguous chronology, incomplete validators, missing/changed samples, safe failure, redaction, and the zero-delivery invariants.
2. **Local real MCP test**: save two fixtures into an isolated temporary `MCP_WEB_VALIDATOR_WORKSPACE_ROOT`, call `audit.monitor`, compare archive bytes **before/after**, verify no source URL/ID leak and reject `dry_run: false`.
3. **Hosted real MCP test**: use supplied snapshot fixtures and a mocked/forbidden `fetch` for all preview calls; test policy isolation across requests, full and partial evidence and unknown destination rejection. No Worker storage.
4. **Installed npm-package smoke**: pack the actual distribution, install into a disposable directory, use local history save/read/monitor MCP, assert 0 notifications and unchanged archive bytes; verify actual pinned browser screenshot smoke remains healthy.
5. **CI gate**: complete root and hosted full test suites, manifest/catalog checks, zero production dependency vulnerabilities, Wrangler **dry-run only**, and all six independent CI/security checks before reviewing the PR.

The hosted source is a thin re-export of `src/modules/change-regression/regression-alerts.ts`, alongside the shared P2-01 historical analyzer. There are no new package dependencies or external permissions. This PR is left **unmerged and undeployed** for review.

**Deferred:** an actual scheduler, polling, alerts being sent, acknowledgement/deduplication across time, notification channels, cross-company storage, GSC and GA4. These are **not prerequisites** for testing the manually invoked offline preview and will **not** be added automatically.

## Core files

- `src/modules/change-regression/regression-alerts.ts`, `test/change-regression-regression-alerts.test.js`
- `chatgpt-plugin/src/modules/change-regression/regression-alerts.ts`, `chatgpt-plugin/src/modules/change-regression/regression-alerts.test.ts`
- MCP registration in `src/index.ts` and `chatgpt-plugin/src/worker.ts`.
