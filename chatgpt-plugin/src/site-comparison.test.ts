import { describe, expect, it } from "vitest";
import { compareSiteAudits, type ComparableSiteAudit } from "./site-comparison";
import type { SiteAuditPageSummary } from "./site-audit";

const FINGERPRINT = "a".repeat(64);

function page(
  url: string,
  options: Partial<SiteAuditPageSummary> = {},
): SiteAuditPageSummary {
  return {
    url,
    fetched_url: url,
    status: "passed",
    http_status: 200,
    redirects_followed: 0,
    page_fetched: true,
    html_validation_status: "completed",
    html_errors: 0,
    html_warnings: 0,
    seo_errors: 0,
    seo_warnings: 0,
    schema_errors: 0,
    schema_warnings: 0,
    notes: 0,
    health_score: 100,
    top_findings: [],
    ...options,
  };
}

function site(
  pages: SiteAuditPageSummary[],
  options: Partial<ComparableSiteAudit> = {},
): ComparableSiteAudit {
  return {
    site_url: "https://example.com/",
    sitemap_url: "https://example.com/sitemap.xml",
    discovery: "sitemap",
    pages_discovered: pages.length,
    pages_selected: pages.length,
    pages_audited: pages.length,
    pages_partial: 0,
    pages_failed: 0,
    pages_skipped_robots: 0,
    truncated: false,
    discovery_fingerprint: FINGERPRINT,
    audit_health_score: 100,
    score_coverage_percent: 100,
    pages,
    issue_groups: [],
    issue_groups_truncated: false,
    ...options,
  };
}

describe("site audit comparison: evidence boundaries", () => {
  it("compares identical complete snapshots without creating false regressions", () => {
    const before = site([page("https://example.com/"), page("https://example.com/about")]);
    const after = structuredClone(before);
    const result = compareSiteAudits(before, after);
    expect(result).toMatchObject({
      status: "comparable",
      pages_compared: 2,
      regressed_pages: 0,
      improved_pages: 0,
      mixed_pages: 0,
      issue_group_comparison_available: true,
      limitations: [],
      newly_selected_urls: [],
      no_longer_selected_urls: [],
    });
    expect(result.page_changes.every((change) => change.kind === "unchanged")).toBe(true);
  });

  it("reports per-page error/warning changes, mixed shifts, and separately changed redirects", () => {
    const urls = ["https://example.com/", "https://example.com/a", "https://example.com/b"];
    const before = site([
      page(urls[0], { seo_errors: 1, health_score: 88 }),
      page(urls[1], { seo_errors: 1, health_score: 88 }),
      page(urls[2], { seo_errors: 1, seo_warnings: 1, health_score: 84 }),
    ]);
    const after = site([
      page(urls[0], { seo_errors: 2, health_score: 76, fetched_url: "https://example.com/new", redirects_followed: 1 }),
      page(urls[1], { seo_errors: 0, health_score: 100 }),
      page(urls[2], { seo_errors: 2, seo_warnings: 0, health_score: 76 }),
    ]);
    const result = compareSiteAudits(before, after);
    expect(result).toMatchObject({ status: "comparable", regressed_pages: 1, improved_pages: 1, mixed_pages: 1 });
    expect(result.page_changes.find((c) => c.url === urls[0])).toMatchObject({
      kind: "regressed", error_delta: 1, warning_delta: 0, health_score_delta: -12, redirect_changed: true,
    });
    expect(result.page_changes.find((c) => c.url === urls[2])).toMatchObject({
      kind: "mixed", error_delta: 1, warning_delta: -1,
    });
  });

  it("only reports grouped findings as newly/no-longer observed with complete matching coverage", () => {
    const url = "https://example.com/";
    const a = { code: "seo.title.missing", severity: "error" as const, category: "SEO" as const, message: "Missing title", affected_pages: 1, example_urls: [url] };
    const b = { code: "seo.meta_description.missing", severity: "warning" as const, category: "SEO" as const, message: "Missing description", affected_pages: 1, example_urls: [url] };
    const before = site([page(url)], { issue_groups: [a] });
    const after = site([page(url)], { issue_groups: [b] });
    const result = compareSiteAudits(before, after);
    expect(result.issue_group_comparison_available).toBe(true);
    expect(result.newly_observed_issue_groups).toMatchObject([{ code: "seo.meta_description.missing" }]);
    expect(result.no_longer_observed_issue_groups).toMatchObject([{ code: "seo.title.missing" }]);
    // The wording is observational: an absent finding does not prove Google indexing.
    expect(JSON.stringify(result)).not.toContain("indexed");
  });

  it("tracks issue groups that spread across more sampled pages", () => {
    const urls = ["https://example.com/", "https://example.com/a"];
    const g = { code: "seo.title.missing", severity: "error" as const, category: "SEO" as const, message: "Missing title", example_urls: [urls[0]] };
    const before = site(urls.map((u) => page(u)), { issue_groups: [{ ...g, affected_pages: 1 }] });
    const after = site(urls.map((u) => page(u)), { issue_groups: [{ ...g, affected_pages: 2 }] });
    const result = compareSiteAudits(before, after);
    expect(result.expanding_issue_groups).toMatchObject([{
      code: "seo.title.missing", before_affected_pages: 1, after_affected_pages: 2, delta_pages: 1,
    }]);
  });

  it("can compare changes within the identical fully checked sample even if site-wide coverage is partial", () => {
    const url = "https://example.com/";
    const issue = {
      code: "seo.title.missing", severity: "error" as const, category: "SEO" as const,
      message: "Missing title", affected_pages: 1, example_urls: [url],
    };
    const before = site([page(url, { seo_errors: 1, health_score: 88 })], {
      truncated: true,
      pages_discovered: 250,
      next_page_offset: 1,
      issue_groups: [issue],
    });
    const after = site([page(url)], {
      truncated: true,
      pages_discovered: 250,
      next_page_offset: 1,
      issue_groups: [],
    });
    const result = compareSiteAudits(before, after);
    expect(result).toMatchObject({
      status: "partial",
      pages_compared: 1,
      improved_pages: 1,
      issue_group_comparison_available: true,
      no_longer_observed_issue_groups: [{ code: "seo.title.missing" }],
    });
    expect(result.limitations.join(" ")).toMatch(/sampled pages/i);
    expect(result.limitations.join(" ")).toMatch(/not establish site-wide resolution/i);
  });

  it("suppresses claims of resolution after sitemap drift or pagination differences", () => {
    const before = site([page("https://example.com/"), page("https://example.com/a")], {
      issue_groups: [{ code: "seo.title.missing", severity: "error", category: "SEO", message: "Missing title", affected_pages: 1, example_urls: ["https://example.com/a"] }],
    });
    const after = site([page("https://example.com/"), page("https://example.com/b")], {
      discovery_fingerprint: "b".repeat(64), truncated: true, next_page_offset: 2,
    });
    const result = compareSiteAudits(before, after);
    expect(result).toMatchObject({ status: "partial", pages_compared: 1, issue_group_comparison_available: false });
    expect(result.newly_selected_urls).toEqual(["https://example.com/b"]);
    expect(result.no_longer_selected_urls).toEqual(["https://example.com/a"]);
    expect(result.no_longer_observed_issue_groups).toEqual([]);
    expect(result.limitations.join(" ")).toMatch(/fingerprints differ/i);
  });

  it("separates validation outages from real improvements or regressions", () => {
    const url = "https://example.com/";
    const good = page(url);
    const broken = page(url, {
      status: "partial", html_validation_status: "timeout", health_score: undefined,
    });
    const lost = compareSiteAudits(site([good]), site([broken], { pages_audited: 0, pages_partial: 1 }));
    expect(lost).toMatchObject({ status: "partial", coverage_lost_pages: 1, regressed_pages: 0, improved_pages: 0 });
    expect(lost.page_changes[0]).toMatchObject({ kind: "coverage_lost" });
    expect(lost.page_changes[0].error_delta).toBeUndefined();
    const recovered = compareSiteAudits(site([broken], { pages_audited: 0, pages_partial: 1 }), site([good]));
    expect(recovered).toMatchObject({ status: "partial", coverage_recovered_pages: 1, improved_pages: 0 });
  });

  it("rejects unrelated origins, duplicate URLs, and non-overlapping batches", () => {
    const a = site([page("https://example.com/")]);
    expect(compareSiteAudits(a, site([page("https://another.example/")], {
      site_url: "https://another.example/",
    })).status).toBe("not_comparable");
    expect(compareSiteAudits(a, site([page("https://example.com/"), page("https://example.com/#x")])).status)
      .toBe("not_comparable");
    const noOverlap = compareSiteAudits(a, site([page("https://example.com/b")]));
    expect(noOverlap).toMatchObject({ status: "not_comparable", pages_compared: 0 });
  });

  it("keeps inputs unchanged", () => {
    const before = site([page("https://example.com/")]);
    const after = site([page("https://example.com/")]);
    const a = structuredClone(before);
    const b = structuredClone(after);
    compareSiteAudits(before, after);
    expect(before).toEqual(a);
    expect(after).toEqual(b);
  });
});
