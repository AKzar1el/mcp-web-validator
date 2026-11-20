# P2-01 — Historical comparisons across saved site-audit versions

**Owner:** M05 `change-regression`. **Runtime scope:** local Node/stdio `audit.trends` plus hosted Worker `compare_historical_audits`. **Status:** implemented but intentionally **partial**; the tool compares **historical compact evidence**, not website-wide history, rankings or Search Console traffic.

## Existing foundations (preserved)

- **Local `audit.history`** already explicitly saves, lists and gets up to **10** compact `audit_public_site` snapshots in the local `.mcp-validator/audit-history.json`. It uses one bounded regular file, safe directory/file checks, no symlink following, <=60 KB per compact snapshot and oldest-first eviction on the 11th saved snapshot. P2-01 does **not** change its on-disk schema, retention, opt-in save semantics or existing API.
- **Hosted `compare_site_audits`** already compares two supplied snapshots and is retained unchanged. The hosted Worker remains stateless, with no access to the local history file or saved ID database.

P2-01 adds a **single dependency-free, shared pure TypeScript analyzer** for 2–10 versions in `src/modules/change-regression/historical-comparisons.ts`. Hosted `chatgpt-plugin/src/modules/change-regression/historical-comparisons.ts` only reexports that implementation, without root-package runtime dependencies.

## Local: compare versions already saved on the computer

Call `audit.history` with `action: "list"` to get the **newest-first** list. Then pass 2–10 **distinct, already-existing** version IDs in **oldest-to-newest** archive order to local read-only `audit.trends`:

```json
{
  "ids": [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  ]
}
```

IDs above are illustrative, not real archive entries. **No source snapshots are returned or echoed**. The local tool calls `getAuditHistoryVersions`, which reads the guarded history file **once**, verifies IDs exist, checks true saved order, and passes only matching compact snapshots to the pure analyzer. Missing or evicted IDs, duplicates, reversed archive order and invalid/corrupt history **fail closed**. A comparison never creates the history directory, writes, evicts, edits or repairs saved data.

## Hosted: compare supplied historical snapshots without storage

Call `compare_historical_audits` with 2–10 `versions`, each with an actual offset-aware `saved_at` timestamp and a compact `audit_public_site` snapshot. The full snapshot should contain the preexisting site-audit fields (`site_url`, `discovery`, `discovery_fingerprint`, selected page summaries and issue groups, coverage status). For example:

```json
{
  "versions": [
    {
      "saved_at": "2026-11-17T09:00:00Z",
      "snapshot": {
        "site_url": "https://example.com/",
        "discovery": "sitemap",
        "discovery_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pages_discovered": 1,
        "pages_selected": 1,
        "pages_audited": 1,
        "pages_partial": 0,
        "pages_failed": 0,
        "pages_skipped_robots": 0,
        "truncated": false,
        "score_coverage_percent": 100,
        "pages": [
          {
            "url": "https://example.com/",
            "status": "passed",
            "page_fetched": true,
            "html_validation_status": "completed",
            "html_errors": 0,
            "html_warnings": 0,
            "seo_errors": 0,
            "seo_warnings": 0,
            "schema_errors": 0,
            "schema_warnings": 0,
            "notes": 0,
            "health_score": 100,
            "top_findings": []
          }
        ],
        "issue_groups": [],
        "issue_groups_truncated": false
      }
    }
  ]
}
```

This example shows **one** version only to illustrate a record; at least **two** timestamped versions are required in a real call. Timestamp order must be non-decreasing. Equal timestamps are allowed (some local saves can share one millisecond), but make time ordering **ambiguous** and downgrade result status to `partial`. The hosted tool does not create or recover saved snapshots, and does not fetch source URLs.

## Evidence logic and interpretation

The analyzer returns only fixed **numeric** and controlled-code summaries, referring to version **1–10**, not the original IDs, URLs, issue text, timestamps or fingerprint hashes:

- Per-version count of sampled and completed pages and whether the original audit sample was partial or truncated.
- Up to nine **consecutive** comparisons and one **first-to-last** comparison. On **exact matched page URLs with completed validators on both sides**, it counts page regressions, improvements, opposing/mixed changes and unchanged pages. Errors and warnings are compared from completed HTML, SEO and schema counts only. A **failed, incomplete or timed-out check is coverage loss/recovery, not a repair or regression in actual page quality**.
- The **stable cohort** is the intersection of exact page URLs in **every** version. Its **complete stable cohort** includes only pages fully checked in **every** version. Per-version cohort errors, warnings and heuristic health-score averages are available only for that complete cohort. If it is empty, those metrics are `null` and `cohort_metrics_available=false`, never invented zeros.
- For each adjacent pair, changes in sitemap discovery fingerprints, selected page URLs, truncated sampling, robots exclusions or failed validators downgrade comparability to `partial`. A pair with **no exact overlapping audited URLs** is `not_comparable`; its zero change counters are not passed off as a clean result.
- **Issue-group appearance, disappearance or spread** is counted only when selected URLs are identical, discovery fingerprint matches, every shared page was completely checked, grouped findings are not truncated and issue-group identities are unique. Otherwise availability is `false` and counts are explicitly **`null`**, never zero.
- `comparable_sample` means **only the selected sample** can be compared. It does not mean a whole site was covered. A page count or issue change does not establish Google indexability, ranking, traffic causation or a site-wide fix.

## Limits, privacy and deployment

- **2–10 versions**, each at most **60,000 UTF-8 bytes**, <=**610,000 bytes** across submitted version snapshots, **8 page summaries** and **50 issue groups** per version. URLs must be safe query-free, credential-free, no-custom-port absolute HTTP(S) labels belonging to the same site origin; all versions must share that origin. Duplicate page URLs are rejected.
- At most **12 fixed, redacted findings**; true `total_findings` and `findings_truncated` record withheld findings. Input snapshots are not echoed; no page paths, query strings, raw issue messages, history IDs, discovery fingerprint or original timestamps are returned.
- Local source is the existing guarded archive; hosted source is caller-supplied. **No network requests, new storage, schedule, alert, parser, dependency, changed history retention, Cloudflare deployment or npm publication** are part of P2-01. The hosted stateless MCP tool cannot accept local saved IDs as a data source.
- This feature does not collect its own snapshots, compare arbitrary unseen pages, provide crawler logs or send notifications. P2-02 (regression monitoring and optional alerts) is still a **separate planned** feature requiring specific opt-in.

## Validation gate

Run root `npm run check` (including real local history save/get/trends stdio MCP tests and synchronized manifests), hosted `npm run check && npm test`, `npm run deploy:dry-run`, `npm audit --omit=dev` in both packages, and installed npm tarball MCP smoke. Windows/Ubuntu screenshot runs and hosted-only clean `npm ci` CI must pass. **No deployment** and **no P2-01 merge** until independent GitHub checks are green.

Source files:
- `src/modules/change-regression/historical-comparisons.ts`, `test/change-regression-historical-comparisons.test.js`
- `chatgpt-plugin/src/modules/change-regression/historical-comparisons.ts`, `chatgpt-plugin/src/modules/change-regression/historical-comparisons.test.ts`
- `src/audit-history.ts` (read-only batch retrieval method) and existing `src/index.ts`, `chatgpt-plugin/src/worker.ts` registration boundaries.
