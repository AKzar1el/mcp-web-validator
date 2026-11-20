import { describe, expect, it } from "vitest";
import {
  analyzeHistoricalAudits, emptyHistoricalReview,
  MAX_HISTORICAL_FINDINGS, MAX_HISTORICAL_VERSIONS,
  type HistoricalSnapshot,
} from "./historical-comparisons";

const base = "https://sample.example/";
const page = (extra: Record<string, unknown> = {}) => ({
  url: base, fetched_url: base, status: "passed" as const,
  page_fetched: true, html_validation_status: "completed" as const,
  html_errors: 0, html_warnings: 0, seo_errors: 0, seo_warnings: 0,
  schema_errors: 0, schema_warnings: 0, health_score: 100,
  ...extra,
});
const site = (pages: ReturnType<typeof page>[] = [page()],
  extra: Record<string, unknown> = {}) => ({
    site_url: base, discovery: "sitemap" as const,
    discovery_fingerprint: "a".repeat(64),
    pages_discovered: pages.length, pages_selected: pages.length,
    pages_partial: 0, pages_failed: 0, pages_skipped_robots: 0,
    truncated: false, score_coverage_percent: 100,
    pages, issue_groups: [], issue_groups_truncated: false,
    ...extra,
  }) as HistoricalSnapshot;
const version = (index: number, snapshot = site()) => ({
  saved_at: new Date(Date.UTC(2026, 9, index + 1)).toISOString(), snapshot,
});
const compare = (...versions: ReturnType<typeof version>[]) =>
  analyzeHistoricalAudits(versions, "caller_supplied_snapshots");
const codes = (r: ReturnType<typeof compare>) => r.findings.map((f) => f.code);

describe("P2-01 pure shared historical analyzer (hosted-only install)", () => {
  it("analyzes three exact complete versions and full stable cohort without claiming site-wide repair", () => {
    const r = compare(version(0), version(1), version(2));
    expect(r.status).toBe("comparable_sample");
    expect(r.versions_compared).toBe(3);
    expect(r.consecutive_changes).toHaveLength(2);
    expect(r.comparable_transitions).toBe(2);
    expect(r.stable_cohort_pages).toBe(1);
    expect(r.complete_stable_cohort_pages).toBe(1);
    expect(r.historical_points.every((p) => p.cohort_errors === 0)).toBe(true);
    expect(r.coverage_limited).toBe(true);
    expect(r.limitations.join(" ")).toContain("not site-wide");
  });

  it("tracks only matched completed page error and warning deltas, not assumed traffic changes", () => {
    const r = compare(version(0),
      version(1, site([page({ seo_errors: 2, health_score: 80 })])),
      version(2, site([page({ seo_errors: 1, health_score: 90 })])));
    expect(r.consecutive_changes[0].regressed_pages).toBe(1);
    expect(r.consecutive_changes[1].improved_pages).toBe(1);
    expect(r.first_last_change?.regressed_pages).toBe(1);
    expect(r.historical_points.map((p) => p.cohort_errors)).toEqual([0, 2, 1]);
  });

  it("does not turn timed-out html validation into an apparent improvement", () => {
    const r = compare(
      version(0, site([page({ html_errors: 4 })])),
      version(1, site([page({
        html_errors: 0, health_score: undefined, status: "partial",
        html_validation_status: "timeout",
      })], { pages_partial: 1 })),
    );
    expect(r.status).toBe("partial");
    expect(r.total_coverage_lost_transitions).toBe(1);
    expect(r.total_improved_page_transitions).toBe(0);
    expect(r.cohort_metrics_available).toBe(false);
    expect(r.historical_points[1].cohort_errors).toBeNull();
    expect(codes(r)).toContain("coverage_lost");
  });

  it("uses exact all-version page intersection for stable page trend with changing samples", () => {
    const extra = page({ url: base + "extra" });
    const other = page({ url: base + "other" });
    const r = compare(version(0, site([page(), extra])),
      version(1, site([page(), other])),
      version(2, site([page(), extra])));
    expect(r.status).toBe("partial");
    expect(r.stable_cohort_pages).toBe(1);
    expect(r.complete_stable_cohort_pages).toBe(1);
    expect(r.consecutive_changes[0].changed_sample).toBe(true);
    expect(r.consecutive_changes[0].no_longer_observed_groups).toBeNull();
    expect(r.first_last_change?.status).toBe("comparable_sample");
  });

  it("marks different discovery fingerprints as limited and suppresses issue disappearance", () => {
    const r = compare(version(0, site([page({ seo_errors: 1 })])),
      version(1, site([page()], { discovery_fingerprint: "b".repeat(64) })));
    expect(r.consecutive_changes[0].sitemap_changed).toBe(true);
    expect(r.status).toBe("partial");
    expect(r.consecutive_changes[0].issue_group_comparison_available).toBe(false);
  });

  it("gates issue-group comparisons on exact complete samples", () => {
    const g = (code: string) => ({
      severity: "warning" as const, category: "SEO" as const,
      code, message: "Redacted caller description", affected_pages: 1,
    });
    const r = compare(version(0, site([page()], { issue_groups: [g("a")] })),
      version(1, site([page()], { issue_groups: [g("b")] })));
    expect(r.consecutive_changes[0].issue_group_comparison_available).toBe(true);
    expect(r.consecutive_changes[0].newly_observed_groups).toBe(1);
    expect(r.consecutive_changes[0].no_longer_observed_groups).toBe(1);
    expect(JSON.stringify(r)).not.toContain("Redacted caller");
    expect(JSON.stringify(r)).not.toContain("sample.example");
  });

  it("does not establish group fixes when issue_groups are truncated", () => {
    const r = compare(version(0, site([page()], { issue_groups_truncated: true })),
      version(1));
    expect(r.consecutive_changes[0].issue_group_comparison_available).toBe(false);
    expect(r.consecutive_changes[0].no_longer_observed_groups).toBeNull();
  });

  it("nonoverlapping versions explicitly fail comparability even with identical origins", () => {
    const r = compare(version(0, site([page({ url: base + "a" })])),
      version(1, site([page({ url: base + "b" })])));
    expect(r.status).toBe("not_comparable");
    expect(r.consecutive_changes[0].shared_pages).toBe(0);
    expect(codes(r)).toContain("nonoverlapping_versions");
  });

  it("invalid chronology and duplicate/foreign page identities fail closed", () => {
    expect(() => compare(version(2), version(1))).toThrow();
    expect(() => compare(version(0, site([page(), page()])), version(1))).toThrow();
    expect(() => compare(version(0), version(1, site([
      page({ url: "https://foreign.example/" }),
    ])))).toThrow();
  });

  it("does not leak credential- or query-bearing page labels", () => {
    const secret = "FAKE_TOKEN_P201_HOSTED";
    expect(() => compare(version(0, site([page({ url: base + "?token=" + secret })])),
      version(1))).toThrow();
    expect(() => compare(version(0, site([page({
      url: "https://user:" + secret + "@sample.example/",
    })])), version(1))).toThrow();
  });

  it("rejects an invalid digest and negative counts", () => {
    expect(() => compare(version(0), version(1, site([page()], {
      discovery_fingerprint: "bad",
    })))).toThrow();
    expect(() => compare(version(0), version(1, site([page({ seo_warnings: -1 })])))).toThrow();
  });

  it("rejects fewer than two or more than ten source versions", () => {
    expect(() => compare(version(0))).toThrow();
    expect(() => compare(...Array.from({ length: MAX_HISTORICAL_VERSIONS + 1 },
      (_, i) => version(i)))).toThrow();
  });

  it("equal timestamps produce an ambiguous and explicitly limited result", () => {
    const r = compare(version(0), version(0));
    expect(r.time_order_ambiguous).toBe(true);
    expect(r.status).toBe("partial");
    expect(codes(r)).toContain("equal_timestamps");
  });

  it("caps fixed redacted issue output while retaining true trends and totals", () => {
    const versions = Array.from({ length: MAX_HISTORICAL_VERSIONS }, (_, i) =>
      version(i, site([page({ seo_errors: i })], {
        discovery_fingerprint: (i % 2 ? "b" : "a").repeat(64),
      })));
    const r = compare(...versions);
    expect(r.total_regressed_page_transitions).toBe(9);
    expect(r.findings).toHaveLength(MAX_HISTORICAL_FINDINGS);
    expect(r.findings_truncated).toBe(true);
    expect(r.total_findings).toBeGreaterThan(MAX_HISTORICAL_FINDINGS);
    expect(r.historical_points.map((p) => p.cohort_errors)).toEqual(
      Array.from({ length: MAX_HISTORICAL_VERSIONS }, (_, i) => i));
  });

  it("empty failure result is truthful and offline", () => {
    const r = emptyHistoricalReview("caller_supplied_snapshots");
    expect(r.versions_compared).toBe(0);
    expect(r.status).toBe("not_comparable");
    expect(r.coverage_limited).toBe(true);
  });
});
