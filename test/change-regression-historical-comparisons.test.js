import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeHistoricalAudits, emptyHistoricalReview,
  MAX_HISTORICAL_VERSIONS, MAX_HISTORICAL_FINDINGS,
  MAX_HISTORICAL_SNAPSHOT_BYTES,
} from "../dist/modules/change-regression/historical-comparisons.js";

const base = "https://example.test/";
const digest = "a".repeat(64);
const time = (n) => new Date(Date.UTC(2026, 9, 1+n)).toISOString();
const pg = (url = base, x = {}) => ({
  url, fetched_url: url,
  status: "passed", page_fetched: true, html_validation_status: "completed",
  html_errors: 0, html_warnings: 0, seo_errors: 0, seo_warnings: 0,
  schema_errors: 0, schema_warnings: 0, health_score: 100, ...x,
});
function snapshot(pages = [pg()], extra = {}) {
  return {
    site_url: base, discovery: "sitemap",
    discovery_fingerprint: digest,
    pages_discovered: pages.length, pages_selected: pages.length,
    pages_partial: 0, pages_failed: 0, pages_skipped_robots: 0,
    truncated: false, score_coverage_percent: 100,
    pages, issue_groups: [], issue_groups_truncated: false,
    ...extra,
  };
}
const v = (i, s = snapshot()) => ({ saved_at: time(i), snapshot: s });
const compare = (...versions) => analyzeHistoricalAudits(versions, "caller_supplied_snapshots");
const codes = (r) => r.findings.map((f) => f.code);
const group = (code = "seo.title.missing", affected_pages = 1) => ({
  category: "SEO", severity: "error",
  code, message: "Some caller-provided secret-bearing title message",
  affected_pages,
});

test("P2-01: identical complete three-version same-sample history is comparable, without site-wide verdicts", () => {
  const r = compare(v(0), v(1), v(2));
  assert.equal(r.scope, "historical_compact_audit_versions_only");
  assert.equal(r.source, "caller_supplied_snapshots");
  assert.equal(r.status, "comparable_sample");
  assert.equal(r.versions_compared, 3);
  assert.equal(r.comparisons_made, 2);
  assert.equal(r.comparable_transitions, 2);
  assert.equal(r.partial_transitions, 0);
  assert.equal(r.stable_cohort_pages, 1);
  assert.equal(r.complete_stable_cohort_pages, 1);
  assert.equal(r.cohort_metrics_available, true);
  assert.equal(r.first_last_change.status, "comparable_sample");
  assert.equal(r.historical_points[1].cohort_errors, 0);
  assert.equal(r.historical_points[1].cohort_mean_health_score, 100);
  assert.equal(r.consecutive_changes[0].unchanged_pages, 1);
  assert.equal(r.consecutive_changes[0].issue_group_comparison_available, true);
  assert.equal(r.coverage_limited, true);
  assert(r.limitations.join(" ").includes("not site-wide") || r.limitations.join(" ").includes("not full-site"));
});

test("P2-01: impossible calendar dates cannot enter historical audit comparisons", () => {
  for (const invalid of [
    "2026-02-30T09:00:00Z",
    "2026-04-31T09:00:00Z",
    "2025-02-29T09:00:00Z",
  ]) {
    assert.throws(() => compare({...v(0), saved_at:invalid},v(1)), /timestamp|date|time/i);
  }
  assert.equal(compare({...v(0),saved_at:"2024-02-29T09:00:00+01:00"},v(1)).status,"comparable_sample");
});

test("P2-01: one stable page across 4 versions has accurate errors, warnings and mean-score trends", () => {
  const r = compare(v(0), v(1, snapshot([pg(base, { seo_errors: 2, seo_warnings: 1, health_score: 82 })])),
    v(2, snapshot([pg(base, { seo_errors: 2, seo_warnings: 0, health_score: 85 })])),
    v(3, snapshot([pg(base, { seo_errors: 1, seo_warnings: 0, health_score: 94 })])));
  assert.deepEqual(r.historical_points.map((p) => p.cohort_errors), [0, 2, 2, 1]);
  assert.deepEqual(r.historical_points.map((p) => p.cohort_warnings), [0, 1, 0, 0]);
  assert.deepEqual(r.historical_points.map((p) => p.cohort_mean_health_score), [100, 82, 85, 94]);
  assert.deepEqual(r.consecutive_changes.map((s) => s.regressed_pages), [1, 0, 0]);
  assert.deepEqual(r.consecutive_changes.map((s) => s.improved_pages), [0, 1, 1]);
  assert.equal(r.total_regressed_page_transitions, 1);
  assert.equal(r.total_improved_page_transitions, 2);
  assert.equal(r.first_last_change.regressed_pages, 1);
  assert.equal(r.first_last_change.errors_delta_checked, 1);
});

test("P2-01: mixed error and warning movement does not claim simple improvement", () => {
  const before = snapshot([pg(base, { seo_errors: 2, seo_warnings: 0 })]);
  const after = snapshot([pg(base, { seo_errors: 1, seo_warnings: 1 })]);
  const r = compare(v(0, before), v(1, after));
  assert.equal(r.consecutive_changes[0].mixed_pages, 1);
  assert.equal(r.consecutive_changes[0].regressed_pages, 0);
  assert.equal(r.consecutive_changes[0].improved_pages, 0);
  assert(codes(r).includes("mixed_page_changes"));
});

test("P2-01: validated matching exact page subset ignores new or missing pages instead of declaring repairs", () => {
  const pageA = pg(base);
  const pageB = pg(base + "b", { seo_errors: 2 });
  const pageC = pg(base + "c");
  const r = compare(
    v(0, snapshot([pageA, pageB])),
    v(1, snapshot([pageA, pageC])),
    v(2, snapshot([pageA, pageB])),
  );
  assert.equal(r.status, "partial");
  assert.equal(r.stable_cohort_pages, 1);
  assert.equal(r.complete_stable_cohort_pages, 1);
  assert.equal(r.consecutive_changes[0].shared_pages, 1);
  assert.equal(r.consecutive_changes[0].changed_sample, true);
  assert.equal(r.consecutive_changes[0].issue_group_comparison_available, false);
  assert.equal(r.consecutive_changes[0].no_longer_observed_groups, null);
  assert.equal(r.historical_points[0].cohort_errors, 0);
  assert.equal(r.first_last_change.status, "comparable_sample");
});

test("P2-01: validation timeouts are coverage lost, not confirmed issue improvements", () => {
  const good = snapshot([pg(base, { seo_errors: 3 })]);
  const failed = snapshot([pg(base, {
    status: "partial", page_fetched: true, html_validation_status: "timeout", health_score: undefined,
    seo_errors: 0,
  })], { pages_partial: 1, score_coverage_percent: 0 });
  const r = compare(v(0, good), v(1, failed));
  assert.equal(r.status, "partial");
  assert.equal(r.consecutive_changes[0].coverage_lost_pages, 1);
  assert.equal(r.consecutive_changes[0].improved_pages, 0);
  assert.equal(r.consecutive_changes[0].regressed_pages, 0);
  assert.equal(r.consecutive_changes[0].completely_checked_pairs, 0);
  assert.equal(r.consecutive_changes[0].errors_delta_checked, 0);
  assert.equal(r.complete_stable_cohort_pages, 0);
  assert.equal(r.cohort_metrics_available, false);
  assert.equal(r.historical_points[0].cohort_errors, null);
  assert(codes(r).includes("coverage_lost"));
  assert(codes(r).includes("all_versions_incomplete"));
});

test("P2-01: later recovered check counted separately from issue improvement", () => {
  const failed = snapshot([pg(base, { status: "failed", page_fetched: false,
    html_validation_status: "unavailable", health_score: undefined })], { pages_failed: 1 });
  const good = snapshot([pg()]);
  const r = compare(v(0, failed), v(1, good));
  assert.equal(r.consecutive_changes[0].coverage_recovered_pages, 1);
  assert.equal(r.consecutive_changes[0].improved_pages, 0);
  assert.equal(r.consecutive_changes[0].completely_checked_pairs, 0);
});

test("P2-01: mismatched sitemap fingerprints make pair partial and suppress group changes", () => {
  const old = snapshot([pg(base, { seo_errors: 2 })], { issue_groups: [group()] });
  const now = snapshot([pg(base)], { discovery_fingerprint: "b".repeat(64) });
  const r = compare(v(0, old), v(1, now));
  assert.equal(r.status, "partial");
  assert.equal(r.consecutive_changes[0].sitemap_changed, true);
  assert.equal(r.consecutive_changes[0].issue_group_comparison_available, false);
  assert.equal(r.consecutive_changes[0].no_longer_observed_groups, null);
  assert(codes(r).includes("changed_sitemap_fingerprint"));
  assert.equal(r.consecutive_changes[0].improved_pages, 1);
});

test("P2-01: group changes are counted only in aligned fully audited selected samples", () => {
  const old = snapshot([pg()], { issue_groups: [group("missing-title")] });
  const cur = snapshot([pg()], { issue_groups: [group("missing-description")] });
  const r = compare(v(0, old), v(1, cur));
  const step = r.consecutive_changes[0];
  assert.equal(step.issue_group_comparison_available, true);
  assert.equal(step.newly_observed_groups, 1);
  assert.equal(step.no_longer_observed_groups, 1);
  assert.equal(step.expanding_groups, 0);
  assert.equal(step.shrinking_groups, 0);
  assert(!JSON.stringify(r).includes("missing-title"));
  assert(!JSON.stringify(r).includes("missing-description"));
  assert(!JSON.stringify(r).includes("caller-provided"));
});

test("P2-01: code-identical group affected-page counts expand/shrink without false new issue", () => {
  const pages = [pg(), pg(base + "about")];
  const a = snapshot(pages, { issue_groups: [group("seo.title", 1)] });
  const b = snapshot(pages, { issue_groups: [group("seo.title", 2)] });
  const c = snapshot(pages, { issue_groups: [group("seo.title", 1)] });
  const r = compare(v(0, a), v(1, b), v(2, c));
  assert.equal(r.consecutive_changes[0].expanding_groups, 1);
  assert.equal(r.consecutive_changes[1].shrinking_groups, 1);
  assert.equal(r.consecutive_changes[0].newly_observed_groups, 0);
});

test("P2-01: duplicate same-identity issue groups cannot prove disappearance or appearance", () => {
  const g = group();
  const a = snapshot([pg()], { issue_groups: [g, g] });
  const b = snapshot([pg()]);
  const r = compare(v(0, a), v(1, b));
  assert.equal(r.consecutive_changes[0].issue_group_comparison_available, false);
  assert.equal(r.consecutive_changes[0].no_longer_observed_groups, null);
});

test("P2-01: changed discovery or truncated selected batch keeps partial, no sitewide resolution", () => {
  const r = compare(
    v(0, snapshot([pg()], { discovery: "partial", truncated: true, pages_discovered: 250 })),
    v(1, snapshot([pg()], { discovery: "root_only", truncated: true, pages_discovered: 250 })),
  );
  assert.equal(r.status, "partial");
  assert(r.historical_points.every((p) => p.sample_limited));
  assert.equal(r.coverage_limited, true);
});

test("P2-01: two version samples with zero page overlap explicitly not comparable", () => {
  const r = compare(v(0, snapshot([pg(base)])), v(1, snapshot([pg(base + "other")])));
  assert.equal(r.status, "not_comparable");
  assert.equal(r.not_comparable_transitions, 1);
  assert.equal(r.consecutive_changes[0].shared_pages, 0);
  assert.equal(r.consecutive_changes[0].no_longer_observed_groups, null);
  assert(codes(r).includes("nonoverlapping_versions"));
});

test("P2-01: cross-origin archives, credential-bearing and query URLs fail closed", () => {
  assert.throws(() => compare(v(0), v(1, snapshot([pg("https://other.test/")], {
    site_url: "https://other.test/",
  }))));
  assert.throws(() => compare(v(0, snapshot([pg(base + "?token=PRIVATE")])) , v(1)));
  assert.throws(() => compare(v(0, snapshot([pg(base + "#secret")])) , v(1)));
  assert.throws(() => compare(v(0, snapshot([pg("https://user:password@example.test/")])) , v(1)));
  assert.throws(() => compare(v(0, snapshot([pg(), pg()])) , v(1)));
});

test("P2-01: chronological timestamps must ascend and identical timestamps remain ambiguous", () => {
  assert.throws(() => compare(v(2), v(1)));
  const same = compare(v(0), v(0));
  assert.equal(same.time_order_ambiguous, true);
  assert.equal(same.status, "partial");
  assert(codes(same).includes("equal_timestamps"));
  assert.throws(() => compare({ saved_at: "bad_timestamp", snapshot: snapshot() }, v(1)));
});

test("P2-01: 2-10 version caps, malformed page counts and invalid digest fail closed", () => {
  assert.throws(() => compare(v(0)));
  assert.throws(() => compare(...Array.from({ length: MAX_HISTORICAL_VERSIONS + 1 }, (_, i) => v(i))));
  assert.throws(() => compare(v(0), v(1, snapshot([pg()], { discovery_fingerprint: "x" }))));
  assert.throws(() => compare(v(0), v(1, snapshot([pg()], { pages_selected: -1 }))));
  assert.throws(() => compare(v(0), v(1, snapshot([pg()], { score_coverage_percent: 101 }))));
  assert.throws(() => compare(v(0), v(1, snapshot([pg(base, { health_score: 101 })]))));
  assert.throws(() => compare(v(0), v(1, snapshot([pg(base, { seo_errors: -1 })]))));
  assert.throws(() => compare(v(0), v(1, snapshot(Array.from({ length: 9 }, (_, i) => pg(base + i))))));
});

test("P2-01: site query tokens and issue messages are not echoed even in findings", () => {
  const secret = "SENSITIVE_ISSUE_MESSAGE_P201";
  const r = compare(v(0, snapshot([pg(base)], { issue_groups: [group("seo-secret", 1)] })),
    v(1, snapshot([pg(base, { seo_errors: 2 })], {
      issue_groups: [{ ...group("seo-other", 1), message: secret }],
    })));
  assert.equal(r.consecutive_changes[0].regressed_pages, 1);
  assert(!JSON.stringify(r).includes(secret));
  assert(!JSON.stringify(r).includes(base));
  assert(!JSON.stringify(r).includes("seo-secret"));
  assert(!JSON.stringify(r).includes("seo-other"));
  assert(!JSON.stringify(r).includes(digest));
});

test("P2-01: 10 complete versions bounded findings, stable cohort and truthful totals", () => {
  const versions = Array.from({ length: MAX_HISTORICAL_VERSIONS }, (_, i) =>
    v(i, snapshot([pg(base, { seo_errors: i, health_score: 100 - i })], {
      discovery_fingerprint: (i % 2 ? "b" : "a").repeat(64),
    })));
  const r = compare(...versions);
  assert.equal(r.versions_compared, 10);
  assert.equal(r.comparisons_made, 9);
  assert.equal(r.total_regressed_page_transitions, 9);
  assert.equal(r.consecutive_changes.length, 9);
  assert.equal(r.historical_points.length, 10);
  assert.equal(r.stable_cohort_pages, 1);
  assert.equal(r.complete_stable_cohort_pages, 1);
  assert.deepEqual(r.historical_points.map((p) => p.cohort_errors),
    Array.from({ length: 10 }, (_, i) => i));
  assert(r.total_findings > MAX_HISTORICAL_FINDINGS);
  assert.equal(r.findings.length, MAX_HISTORICAL_FINDINGS);
  assert.equal(r.findings_truncated, true);
  assert(r.findings.every((f) => f.severity === "warning" || f.severity === "info"));
  assert(MAX_HISTORICAL_SNAPSHOT_BYTES === 60_000);
});

test("P2-01: status and empty failed-call scaffold retain coverage_limited true", () => {
  const empty = emptyHistoricalReview("caller_supplied_snapshots");
  assert.equal(empty.status, "not_comparable");
  assert.equal(empty.versions_compared, 0);
  assert.equal(empty.coverage_limited, true);
  assert.deepEqual(empty.historical_points, []);
});
