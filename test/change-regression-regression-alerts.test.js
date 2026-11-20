import assert from "node:assert/strict";
import test from "node:test";
import {
  previewRegressionAlerts, normalizeMonitorPolicy, emptyMonitorPreview,
  DEFAULT_MONITOR_POLICY, MONITOR_RULES, MONITOR_DECISIONS, MONITOR_STATUSES,
} from "../dist/modules/change-regression/regression-alerts.js";
import {
  analyzeHistoricalAudits,
} from "../dist/modules/change-regression/historical-comparisons.js";

const base = "https://example.test/";
const timestamp = (n) => new Date(Date.UTC(2026, 9, n + 1)).toISOString();
const page = (extra = {}) => ({
  url: base, fetched_url: base,
  status: "passed", page_fetched: true,
  html_validation_status: "completed",
  html_errors: 0, html_warnings: 0,
  seo_errors: 0, seo_warnings: 0, schema_errors: 0, schema_warnings: 0,
  health_score: 100, ...extra,
});
function snap(pages = [page()], extra = {}) {
  return {
    site_url: base, discovery: "sitemap",
    discovery_fingerprint: "a".repeat(64),
    pages_discovered: pages.length, pages_selected: pages.length,
    pages_partial: 0, pages_failed: 0, pages_skipped_robots: 0,
    score_coverage_percent: 100, truncated: false,
    pages, issue_groups: [], issue_groups_truncated: false, ...extra,
  };
}
const version = (n, snapshot = snap()) => ({ saved_at: timestamp(n), snapshot });
function review(...versions) {
  return analyzeHistoricalAudits(versions, "caller_supplied_snapshots");
}
function compare(versions, policy) {
  return previewRegressionAlerts(review(...versions), policy);
}
function rule(result, id) {
  return result.rules.find((r) => r.rule === id);
}
const first = version(0);
const improved = (n, errors) => version(n, snap([page({
  seo_errors: errors, health_score: 100 - Math.min(errors * 10, 70),
})]));

test("P2-02: manual dry-run defaults explicitly disable all sending and scheduling", () => {
  const result = compare([first, improved(1, 0)]);
  assert.equal(result.scope, "manual_sampled_regression_alert_preview_only");
  assert.equal(result.status, "no_candidate");
  assert.equal(result.source, "caller_supplied_snapshots");
  assert.equal(result.dry_run, true);
  assert.equal(result.manually_invoked, true);
  assert.equal(result.delivery_enabled, false);
  assert.equal(result.scheduler_enabled, false);
  assert.equal(result.notifications_sent, 0);
  assert.equal(result.external_integrations_used, false);
  assert.equal(result.candidate_count, 0);
  assert.equal(result.review_only_count, 0);
  assert.equal(result.suppressed_count, 0);
  assert.equal(result.rules.length, 5);
  assert.deepEqual(result.rules.map((r) => r.rule), [...MONITOR_RULES]);
  assert(result.rules.every((r) => r.decision === "below_threshold"));
  assert.equal(result.coverage_limited, true);
  assert(result.limitations.join(" ").includes("no scheduled jobs"));
  assert.equal(result.latest_baseline_version, 1);
  assert.equal(result.latest_current_version, 2);
  assert.equal(result.latest_comparability, "comparable_sample");
});

test("P2-02: real matched regression produces only preview candidates, never sends", () => {
  const result = compare([first, improved(1, 2)]);
  assert.equal(result.status, "preview_ready");
  assert.equal(result.candidate_count, 2);
  assert.equal(rule(result, "regressed_pages").decision, "preview_candidate");
  assert.equal(rule(result, "net_error_increase").decision, "preview_candidate");
  assert.equal(rule(result, "net_warning_increase").decision, "below_threshold");
  assert.equal(rule(result, "regressed_pages").latest_observed_value, 1);
  assert.equal(rule(result, "net_error_increase").latest_observed_value, 2);
  assert.equal(result.notifications_sent, 0);
  assert(!JSON.stringify(result).includes(base));
});

test("P2-02: thresholds block small changes but allow observed changes meeting threshold", () => {
  const r = compare([first, improved(1, 3)], {
    min_regressed_pages: 2, min_net_error_increase: 3,
  });
  assert.equal(r.candidate_count, 1);
  assert.equal(rule(r, "regressed_pages").decision, "below_threshold");
  assert.equal(rule(r, "net_error_increase").decision, "preview_candidate");
  assert.deepEqual(r.policy, {
    ...DEFAULT_MONITOR_POLICY,
    min_regressed_pages: 2,
    min_net_error_increase: 3,
  });
});

test("P2-02: net warnings metric uses completed matching pages not raw issue counts", () => {
  const r = compare([first, version(1, snap([page({
    seo_warnings: 4, seo_errors: 0, health_score: 90,
  })]))], { min_net_warning_increase: 4 });
  assert.equal(rule(r, "net_warning_increase").decision, "preview_candidate");
  assert.equal(rule(r, "net_warning_increase").latest_observed_value, 4);
  assert.equal(rule(r, "net_error_increase").decision, "below_threshold");
});

test("P2-02: all improvements remain no_candidate, never an invented 'site healthy' conclusion", () => {
  const r = compare([improved(0, 4), improved(1, 0)]);
  assert.equal(r.status, "no_candidate");
  assert.equal(r.candidate_count, 0);
  assert.equal(rule(r, "net_error_increase").latest_observed_value, -4);
  assert.equal(r.latest_completed_pairs, 1);
  assert(r.limitations.join(" ").includes("never the full site"));
});

test("P2-02: coverage lost is review-only, never a defect regression preview", () => {
  const timeout = snap([page({
    status: "partial", html_validation_status: "timeout",
    health_score: undefined, seo_errors: 0,
  })], { pages_partial: 1, score_coverage_percent: 0 });
  const r = compare([improved(0, 3), version(1, timeout)]);
  assert.equal(r.status, "review_only");
  assert.equal(r.candidate_count, 0);
  assert.equal(r.review_only_count, 1);
  assert.equal(r.suppressed_count, 3);
  assert.equal(rule(r, "coverage_loss").decision, "review_only");
  assert.equal(rule(r, "coverage_loss").reason_code, "observed_validator_coverage_loss");
  assert.equal(rule(r, "regressed_pages").decision, "suppressed");
  assert.equal(rule(r, "net_error_increase").decision, "suppressed");
  assert.equal(rule(r, "net_warning_increase").decision, "suppressed");
});

test("P2-02: a changed sitemap fingerprint is review-only, never an indexing alarm", () => {
  const r = compare([first, version(1, snap([page({ seo_errors: 5 })], {
    discovery_fingerprint: "b".repeat(64),
  }))]);
  assert.equal(r.status, "review_only");
  assert.equal(r.candidate_count, 0);
  assert.equal(rule(r, "sitemap_drift").decision, "review_only");
  assert.equal(rule(r, "regressed_pages").decision, "suppressed");
});

test("P2-02: disable optional review rules per invocation, no retained settings", () => {
  const r = compare([first, version(1, snap([page({
    status: "partial", html_validation_status: "timeout",
    health_score: undefined,
  })], { pages_partial: 1, discovery_fingerprint: "b".repeat(64) }))], {
    review_coverage_loss: false, review_sitemap_drift: false,
  });
  assert.equal(rule(r, "coverage_loss").decision, "disabled");
  assert.equal(rule(r, "sitemap_drift").decision, "disabled");
  assert.equal(r.status, "insufficient_evidence");
  assert.equal(r.candidate_count, 0);
  assert.equal(r.review_only_count, 0);
});

test("P2-02: latest pair comparable even if earlier historical pairs have partial coverage", () => {
  const earlier = version(0, snap([page({ seo_errors: 0 })], {
    discovery_fingerprint: "b".repeat(64),
  }));
  const later = improved(1, 1);
  const latest = improved(2, 3);
  const r = compare([earlier, later, latest]);
  assert.equal(r.latest_comparability, "comparable_sample");
  assert.equal(r.status, "preview_ready");
  assert.equal(rule(r, "regressed_pages").decision, "preview_candidate");
  assert.equal(rule(r, "net_error_increase").decision, "preview_candidate");
});

test("P2-02: configured two-step persistent regression streak triggers only when both steps comparable", () => {
  const r = compare([improved(0, 0), improved(1, 1), improved(2, 2)], {
    consecutive_regressing_steps: 2,
  });
  assert.equal(rule(r, "regressed_pages").decision, "preview_candidate");
  assert.equal(rule(r, "net_error_increase").decision, "preview_candidate");
});

test("P2-02: persistent streak requires sufficient versions and never guesses missing history", () => {
  const r = compare([first, improved(1, 2)], { consecutive_regressing_steps: 3 });
  assert.equal(rule(r, "regressed_pages").decision, "suppressed");
  assert.equal(rule(r, "regressed_pages").reason_code, "insufficient_streak_history");
  assert.equal(rule(r, "net_error_increase").decision, "preview_candidate");
});

test("P2-02: persistent streak suppressed on prior improvement or partial, net error may still preview latest", () => {
  const priorImproved = compare([improved(0, 3), improved(1, 0), improved(2, 2)],
    { consecutive_regressing_steps: 2 });
  assert.equal(rule(priorImproved, "regressed_pages").reason_code, "regression_streak_not_met");
  assert.equal(rule(priorImproved, "regressed_pages").decision, "suppressed");
  const partialFirst = compare([
    version(0, snap([page()], { discovery_fingerprint: "b".repeat(64) })),
    improved(1, 1), improved(2, 3),
  ], { consecutive_regressing_steps: 2 });
  assert.equal(rule(partialFirst, "regressed_pages").decision, "suppressed");
});

test("P2-02: equal timestamps suppress defect candidates rather than claiming chronology", () => {
  const two = [first, { saved_at: first.saved_at, snapshot: snap([page({ seo_errors: 2 })]) }];
  const r = compare(two);
  assert.equal(r.status, "insufficient_evidence");
  assert.equal(r.suppressed_count, 3);
  assert.equal(rule(r, "net_error_increase").reason_code, "ambiguous_version_order");
  assert.equal(r.notifications_sent, 0);
});

test("P2-02: nonoverlapping page sets suppress all defect previews", () => {
  const r = compare([
    version(0, snap([page()])),
    version(1, snap([page({ url: base + "unrelated" })])),
  ]);
  assert.equal(r.latest_comparability, "not_comparable");
  assert.equal(r.status, "insufficient_evidence");
  assert.equal(r.candidate_count, 0);
  assert.equal(r.suppressed_count, 3);
});

test("P2-02: threshold inputs reject negative, fractional, NaN, strings and oversized values", () => {
  for (const input of [
    { min_regressed_pages: 0 }, { min_regressed_pages: 9 },
    { min_net_error_increase: 0 }, { min_net_error_increase: 10_001 },
    { min_net_warning_increase: -1 }, { min_net_warning_increase: Number.NaN },
    { min_coverage_lost_pages: 2.5 },
    { consecutive_regressing_steps: 0 }, { consecutive_regressing_steps: 5 },
    { review_coverage_loss: "yes" }, { review_sitemap_drift: 1 },
    { extra_remote_webhook: "https://secret.test/" },
    null, [], "bad",
  ]) assert.throws(() => normalizeMonitorPolicy(input));
});

test("P2-02: policy can only contain predefined non-network numeric/boolean controls", () => {
  const normalized = normalizeMonitorPolicy({
    min_regressed_pages: 5, min_net_error_increase: 5,
    min_net_warning_increase: 10000, min_coverage_lost_pages: 8,
    consecutive_regressing_steps: 4,
    review_coverage_loss: false, review_sitemap_drift: false,
  });
  assert.equal(Object.keys(normalized).length, 7);
  assert.equal(normalized.consecutive_regressing_steps, 4);
  assert(!JSON.stringify(normalized).includes("http"));
  assert(Object.isFrozen(DEFAULT_MONITOR_POLICY));
});

test("P2-02: sealed output contains rule IDs and fixed text but no URL, issue message, source timestamp or hash", () => {
  const secret = "PRIVATE_ISSUE_MESSAGE_P202";
  const s = snap([page({ seo_errors: 2 })], {
    issue_groups: [{
      category: "SEO", severity: "error", code: "private.code",
      message: secret, affected_pages: 1,
    }],
  });
  const r = compare([first, version(1, s)]);
  const serialized = JSON.stringify(r);
  assert(!serialized.includes(secret));
  assert(!serialized.includes(base));
  assert(!serialized.includes(s.discovery_fingerprint));
  assert(!serialized.includes(timestamp(1)));
  assert(!serialized.includes("private.code"));
  assert(r.rules.every((x) => MONITOR_DECISIONS.includes(x.decision)));
  assert(MONITOR_STATUSES.includes(r.status));
  assert(serialized.length < 7500);
});

test("P2-02: no-scheduler/no-delivery invariants survive alarming input and custom thresholds", () => {
  const r = compare([first, improved(1, 9)], {
    min_regressed_pages: 1, min_net_error_increase: 2,
  });
  assert.equal(r.candidate_count, 2);
  assert.equal(r.notifications_sent, 0);
  assert.equal(r.scheduler_enabled, false);
  assert.equal(r.delivery_enabled, false);
  assert.equal(r.dry_run, true);
  assert.equal(r.manually_invoked, true);
  assert.equal(r.external_integrations_used, false);
});

test("P2-02: policy default object is independent of mutation of returned policies", () => {
  const first = normalizeMonitorPolicy();
  first.min_regressed_pages = 8;
  assert.equal(normalizeMonitorPolicy().min_regressed_pages, 1);
  assert.equal(DEFAULT_MONITOR_POLICY.min_regressed_pages, 1);
});

test("P2-02: evaluator fails closed for absent/tampered historical results", () => {
  assert.throws(() => previewRegressionAlerts(null));
  assert.throws(() => previewRegressionAlerts({}));
  assert.throws(() => previewRegressionAlerts({
    ...review(first, improved(1, 2)), consecutive_changes: [],
  }));
  const broken = review(first, improved(1, 2));
  broken.consecutive_changes[0].errors_delta_checked = Number.NaN;
  assert.throws(() => previewRegressionAlerts(broken));
});

test("P2-02: failure scaffold is unambiguously non-sent, non-scheduled and insufficient", () => {
  const r = emptyMonitorPreview("local_saved_ids");
  assert.equal(r.status, "insufficient_evidence");
  assert.equal(r.candidate_count, 0);
  assert.equal(r.notifications_sent, 0);
  assert.equal(r.delivery_enabled, false);
  assert.equal(r.scheduler_enabled, false);
  assert.equal(r.scope, "manual_sampled_regression_alert_preview_only");
});
