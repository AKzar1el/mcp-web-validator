import { describe, expect, it } from "vitest";
import { analyzeHistoricalAudits, type HistoricalSnapshot } from "./historical-comparisons";
import {
  previewRegressionAlerts, normalizeMonitorPolicy, emptyMonitorPreview,
  MONITOR_RULES, DEFAULT_MONITOR_POLICY,
  type MonitorPolicyInput,
} from "./regression-alerts";

const base = "https://site.example/";
const page = (overrides: Record<string, unknown> = {}) => ({
  url: base, fetched_url: base,
  status: "passed" as const, page_fetched: true,
  html_validation_status: "completed" as const,
  html_errors: 0, html_warnings: 0, seo_errors: 0, seo_warnings: 0,
  schema_errors: 0, schema_warnings: 0, health_score: 100,
  ...overrides,
});
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  site_url: base, discovery: "sitemap" as const,
  discovery_fingerprint: "a".repeat(64),
  pages_discovered: 1, pages_selected: 1,
  pages_partial: 0, pages_failed: 0, pages_skipped_robots: 0,
  truncated: false, score_coverage_percent: 100,
  pages: [page()], issue_groups: [], issue_groups_truncated: false,
  ...overrides,
}) as HistoricalSnapshot;
const versions = (...snaps: HistoricalSnapshot[]) => snaps.map((snap, index) => ({
  saved_at: new Date(Date.UTC(2026, 10, index + 1)).toISOString(), snapshot: snap,
}));
function preview(snaps: HistoricalSnapshot[], policy?: MonitorPolicyInput) {
  return previewRegressionAlerts(
    analyzeHistoricalAudits(versions(...snaps), "caller_supplied_snapshots"), policy,
  );
}
function rule(r: ReturnType<typeof preview>, name: string) {
  return r.rules.find((x) => x.rule === name);
}

describe("P2-02 shared pure rule evaluator in clean hosted Worker environment", () => {
  it("dry-run never enables notification delivery, scheduler, network or connectors", () => {
    const r = preview([snapshot(), snapshot()]);
    expect(r).toMatchObject({
      source: "caller_supplied_snapshots", status: "no_candidate",
      scope: "manual_sampled_regression_alert_preview_only",
      dry_run: true, manually_invoked: true,
      scheduler_enabled: false, delivery_enabled: false,
      notifications_sent: 0, external_integrations_used: false,
      candidate_count: 0, review_only_count: 0, suppressed_count: 0,
      coverage_limited: true,
    });
    expect(r.rules.map((x) => x.rule)).toEqual([...MONITOR_RULES]);
    expect(r.rules.every((x) => x.decision === "below_threshold")).toBe(true);
  });

  it("summarizes comparable page regression and net error warning increases as UNSENT candidates", () => {
    const r = preview([snapshot(), snapshot({ pages: [
      page({ seo_errors: 3, seo_warnings: 2, health_score: 82 }),
    ] })]);
    expect(r.status).toBe("preview_ready");
    expect(r.candidate_count).toBe(3);
    expect(rule(r, "regressed_pages")?.decision).toBe("preview_candidate");
    expect(rule(r, "net_error_increase")?.latest_observed_value).toBe(3);
    expect(rule(r, "net_warning_increase")?.latest_observed_value).toBe(2);
    expect(r.notifications_sent).toBe(0);
  });

  it("honors different independently supplied thresholds without persistent configuration", () => {
    const r = preview([snapshot(), snapshot({ pages: [page({
      seo_errors: 3, health_score: 90,
    })] })], { min_regressed_pages: 2, min_net_error_increase: 4 });
    expect(r.status).toBe("no_candidate");
    expect(r.candidate_count).toBe(0);
    expect(r.policy.min_regressed_pages).toBe(2);
    expect(normalizeMonitorPolicy()).toEqual(DEFAULT_MONITOR_POLICY);
  });

  it("sitemap drift suppresses defect alerts and is a review-only issue", () => {
    const r = preview([snapshot(), snapshot({
      discovery_fingerprint: "b".repeat(64),
      pages: [page({ seo_errors: 2 })],
    })]);
    expect(r.candidate_count).toBe(0);
    expect(rule(r, "regressed_pages")?.decision).toBe("suppressed");
    expect(rule(r, "sitemap_drift")?.decision).toBe("review_only");
    expect(r.status).toBe("review_only");
  });

  it("validator outage is coverage review not apparent page recovery or repair", () => {
    const r = preview([snapshot({ pages: [page({ seo_errors: 3 })] }),
      snapshot({ pages_partial: 1, pages: [page({
        status: "partial", health_score: undefined,
        html_validation_status: "timeout", seo_errors: 0,
      })] })]);
    expect(r.candidate_count).toBe(0);
    expect(r.review_only_count).toBe(1);
    expect(rule(r, "coverage_loss")?.decision).toBe("review_only");
    expect(rule(r, "net_error_increase")?.decision).toBe("suppressed");
    expect(r.latest_completed_pairs).toBe(0);
  });

  it("disabled review-only rules never become notifications", () => {
    const r = preview([snapshot({ pages: [page({ seo_errors: 2 })] }),
      snapshot({ pages_partial: 1, discovery_fingerprint: "b".repeat(64),
        pages: [page({ status: "partial", health_score: undefined,
          html_validation_status: "unavailable" })],
      })], { review_coverage_loss: false, review_sitemap_drift: false });
    expect(r.status).toBe("insufficient_evidence");
    expect(rule(r, "coverage_loss")?.decision).toBe("disabled");
    expect(rule(r, "sitemap_drift")?.decision).toBe("disabled");
  });

  it("persistent regression streak requires matching complete consecutive observations", () => {
    const r = preview([
      snapshot(),
      snapshot({ pages: [page({ seo_errors: 1 })] }),
      snapshot({ pages: [page({ seo_errors: 2 })] }),
    ], { consecutive_regressing_steps: 2 });
    expect(rule(r, "regressed_pages")?.decision).toBe("preview_candidate");
    const insufficient = preview([
      snapshot(), snapshot({ pages: [page({ seo_errors: 2 })] }),
    ], { consecutive_regressing_steps: 3 });
    expect(rule(insufficient, "regressed_pages")?.reason_code).toBe("insufficient_streak_history");
    expect(rule(insufficient, "net_error_increase")?.decision).toBe("preview_candidate");
  });

  it("earlier inconsistent sitemap breaks persistent streak but latest net change stays comparable", () => {
    const r = preview([
      snapshot({ discovery_fingerprint: "b".repeat(64) }),
      snapshot({ pages: [page({ seo_errors: 1 })] }),
      snapshot({ pages: [page({ seo_errors: 2 })] }),
    ], { consecutive_regressing_steps: 2 });
    expect(rule(r, "regressed_pages")?.decision).toBe("suppressed");
    expect(rule(r, "net_error_increase")?.decision).toBe("preview_candidate");
  });

  it("equal timestamps suppress defect candidates", () => {
    const a = snapshot(), b = snapshot({ pages: [page({ seo_errors: 2 })] });
    const rows = versions(a,b);
    rows[1].saved_at = rows[0].saved_at;
    const r = previewRegressionAlerts(
      analyzeHistoricalAudits(rows, "caller_supplied_snapshots"),
    );
    expect(r.candidate_count).toBe(0);
    expect(r.status).toBe("insufficient_evidence");
    expect(rule(r, "net_error_increase")?.reason_code).toBe("ambiguous_version_order");
  });

  it("rejects all unsupported thresholds, remote addresses and options", () => {
    for (const policy of [
      { consecutive_regressing_steps: 5 },
      { min_regressed_pages: -1 },
      { min_coverage_lost_pages: 0 },
      { min_net_warning_increase: 10001 },
      { review_coverage_loss: "yes" },
      { webhook_url: "https://private.example/hook" },
    ]) {
      expect(() => normalizeMonitorPolicy(policy as MonitorPolicyInput)).toThrow();
    }
  });

  it("never returns raw URLs, query tokens, timestamps, issue text or hashes", () => {
    const r = preview([snapshot(), snapshot({ pages: [
      page({ seo_errors: 2, health_score: 82 }),
    ], issue_groups: [{
      severity: "warning", category: "SEO", code: "private.setting",
      message: "SECRET_HISTORICAL_DESCRIPTION", affected_pages: 1,
    }] })]);
    const out = JSON.stringify(r);
    for (const value of [
      base, "SECRET_HISTORICAL_DESCRIPTION", "private.setting",
      "a".repeat(64), "2026-11-02",
    ]) expect(out).not.toContain(value);
    expect(r.notifications_sent).toBe(0);
  });

  it("fake or absent comparator data fails closed, not an automatic alert", () => {
    expect(() => previewRegressionAlerts(null as never)).toThrow();
    const r = emptyMonitorPreview("caller_supplied_snapshots");
    expect(r.status).toBe("insufficient_evidence");
    expect(r.candidate_count).toBe(0);
    expect(r.scheduler_enabled).toBe(false);
    expect(r.delivery_enabled).toBe(false);
  });
});
