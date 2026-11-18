import type {
  PublicSiteAuditResult,
  SiteAuditIssueGroup,
  SiteAuditPageSummary,
  SitePageStatus,
} from "./site-audit";

export type ComparisonStatus = "comparable" | "partial" | "not_comparable";
export type PageChangeKind =
  | "regressed"
  | "improved"
  | "mixed"
  | "unchanged"
  | "coverage_lost"
  | "coverage_recovered"
  | "unverified";

export interface ComparedPage {
  url: string;
  kind: PageChangeKind;
  before_status: SitePageStatus;
  after_status: SitePageStatus;
  error_delta?: number;
  warning_delta?: number;
  health_score_delta?: number;
  redirect_changed: boolean;
}

export interface ChangedIssueGroup {
  code?: string;
  severity: SiteAuditIssueGroup["severity"];
  category: SiteAuditIssueGroup["category"];
  message: string;
  affected_pages: number;
}

export interface ExpandedIssueGroup {
  code?: string;
  severity: SiteAuditIssueGroup["severity"];
  category: SiteAuditIssueGroup["category"];
  message: string;
  before_affected_pages: number;
  after_affected_pages: number;
  delta_pages: number;
}

export interface SiteAuditComparison {
  status: ComparisonStatus;
  baseline_site_url: string;
  current_site_url: string;
  baseline_selected_pages: number;
  current_selected_pages: number;
  pages_compared: number;
  regressed_pages: number;
  improved_pages: number;
  mixed_pages: number;
  coverage_lost_pages: number;
  coverage_recovered_pages: number;
  newly_selected_urls: string[];
  no_longer_selected_urls: string[];
  page_changes: ComparedPage[];
  issue_group_comparison_available: boolean;
  newly_observed_issue_groups: ChangedIssueGroup[];
  no_longer_observed_issue_groups: ChangedIssueGroup[];
  expanding_issue_groups: ExpandedIssueGroup[];
  shrinking_issue_groups: ExpandedIssueGroup[];
  limitations: string[];
}

function cleanUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function pageMap(snapshot: PublicSiteAuditResult): Map<string, SiteAuditPageSummary> | undefined {
  const pages = new Map<string, SiteAuditPageSummary>();
  for (const page of snapshot.pages) {
    const key = cleanUrl(page.url);
    if (!key || pages.has(key)) return undefined;
    pages.set(key, page);
  }
  return pages;
}

function completed(page: SiteAuditPageSummary): boolean {
  return page.page_fetched
    && page.html_validation_status === "completed"
    && (page.status === "passed" || page.status === "needs_attention")
    && page.health_score !== undefined;
}

function errors(page: SiteAuditPageSummary): number {
  return page.html_errors + page.seo_errors + page.schema_errors;
}

function warnings(page: SiteAuditPageSummary): number {
  return page.html_warnings + page.seo_warnings + page.schema_warnings;
}

function issueKey(issue: SiteAuditIssueGroup): string {
  // Audit codes survive wording changes. Uncoded HTML diagnostics use exact text,
  // not approximate matching that might falsely declare a problem resolved.
  return JSON.stringify([
    issue.category,
    issue.severity,
    issue.code ? "code" : "message",
    issue.code ?? issue.message,
  ]);
}

function changedGroup(issue: SiteAuditIssueGroup): ChangedIssueGroup {
  return {
    ...(issue.code ? { code: issue.code } : {}),
    severity: issue.severity,
    category: issue.category,
    message: issue.message,
    affected_pages: issue.affected_pages,
  };
}

function sortedGroups(groups: ChangedIssueGroup[]): ChangedIssueGroup[] {
  const order = { error: 0, warning: 1, info: 2 };
  return groups.sort((a, b) =>
    order[a.severity] - order[b.severity]
    || b.affected_pages - a.affected_pages
    || (a.code ?? a.message).localeCompare(b.code ?? b.message),
  );
}

function emptyResult(before: PublicSiteAuditResult, after: PublicSiteAuditResult): SiteAuditComparison {
  return {
    status: "not_comparable",
    baseline_site_url: before.site_url,
    current_site_url: after.site_url,
    baseline_selected_pages: before.pages.length,
    current_selected_pages: after.pages.length,
    pages_compared: 0,
    regressed_pages: 0,
    improved_pages: 0,
    mixed_pages: 0,
    coverage_lost_pages: 0,
    coverage_recovered_pages: 0,
    newly_selected_urls: [],
    no_longer_selected_urls: [],
    page_changes: [],
    issue_group_comparison_available: false,
    newly_observed_issue_groups: [],
    no_longer_observed_issue_groups: [],
    expanding_issue_groups: [],
    shrinking_issue_groups: [],
    limitations: [],
  };
}

/**
 * Compare two already-collected, bounded site audits. Pure and offline:
 * no HTTP requests, no persistence, no changes to either source snapshot.
 *
 * Comparisons of observed pages remain useful under partial coverage, but
 * issue-group disappearance is never called a site-wide fix: observations
 * can be compared only within the same fully checked selected page sample.
 */
export function compareSiteAudits(
  before: PublicSiteAuditResult,
  after: PublicSiteAuditResult,
): SiteAuditComparison {
  const result = emptyResult(before, after);
  const baselineUrl = cleanUrl(before.site_url);
  const currentUrl = cleanUrl(after.site_url);
  if (!baselineUrl || !currentUrl || new URL(baselineUrl).origin !== new URL(currentUrl).origin) {
    result.limitations.push("The audits have invalid site URLs or different origins; do not compare them.");
    return result;
  }

  const baseline = pageMap(before);
  const current = pageMap(after);
  if (!baseline || !current) {
    result.limitations.push("At least one audit has invalid or duplicate page URLs; the comparison is not trustworthy.");
    return result;
  }

  const baselineKeys = [...baseline.keys()];
  const currentKeys = [...current.keys()];
  result.newly_selected_urls = currentKeys.filter((url) => !baseline.has(url));
  result.no_longer_selected_urls = baselineKeys.filter((url) => !current.has(url));
  const shared = baselineKeys.filter((url) => current.has(url));
  result.pages_compared = shared.length;
  if (shared.length === 0) {
    result.limitations.push("No matching audited pages were found; compare the same sitemap batch or URLs.");
    return result;
  }

  // Non-overlapping pages are absent from the comparison, not automatically
  // newly broken or repaired. A failed check is a coverage change, not a pass.
  for (const url of shared) {
    const oldPage = baseline.get(url)!;
    const newPage = current.get(url)!;
    const beforeCompleted = completed(oldPage);
    const afterCompleted = completed(newPage);
    let kind: PageChangeKind = "unverified";
    let errorDelta: number | undefined;
    let warningDelta: number | undefined;
    let scoreDelta: number | undefined;
    if (beforeCompleted && afterCompleted) {
      errorDelta = errors(newPage) - errors(oldPage);
      warningDelta = warnings(newPage) - warnings(oldPage);
      scoreDelta = newPage.health_score! - oldPage.health_score!;
      const worse = errorDelta > 0 || warningDelta > 0;
      const better = errorDelta < 0 || warningDelta < 0;
      kind = worse && better ? "mixed"
        : worse ? "regressed"
          : better ? "improved" : "unchanged";
    } else if (beforeCompleted && !afterCompleted) {
      kind = "coverage_lost";
    } else if (!beforeCompleted && afterCompleted) {
      kind = "coverage_recovered";
    }
    result.page_changes.push({
      url,
      kind,
      before_status: oldPage.status,
      after_status: newPage.status,
      ...(errorDelta !== undefined ? { error_delta: errorDelta } : {}),
      ...(warningDelta !== undefined ? { warning_delta: warningDelta } : {}),
      ...(scoreDelta !== undefined ? { health_score_delta: scoreDelta } : {}),
      redirect_changed: oldPage.fetched_url !== newPage.fetched_url
        || oldPage.redirects_followed !== newPage.redirects_followed,
    });
  }

  const priority: Record<PageChangeKind, number> = {
    coverage_lost: 0, regressed: 1, mixed: 2, unverified: 3,
    coverage_recovered: 4, improved: 5, unchanged: 6,
  };
  result.page_changes.sort((a, b) => priority[a.kind] - priority[b.kind] || a.url.localeCompare(b.url));
  result.regressed_pages = result.page_changes.filter((page) => page.kind === "regressed").length;
  result.improved_pages = result.page_changes.filter((page) => page.kind === "improved").length;
  result.mixed_pages = result.page_changes.filter((page) => page.kind === "mixed").length;
  result.coverage_lost_pages = result.page_changes.filter((page) => page.kind === "coverage_lost").length;
  result.coverage_recovered_pages = result.page_changes.filter((page) => page.kind === "coverage_recovered").length;

  const sameSet = result.newly_selected_urls.length === 0 && result.no_longer_selected_urls.length === 0;
  if (!sameSet) result.limitations.push("Different pages were selected; only matching pages were compared.");
  if (before.discovery_fingerprint !== after.discovery_fingerprint) {
    result.limitations.push("Sitemap discovery fingerprints differ; omitted or reordered pages may change apparent trends.");
  }
  if (before.discovery !== "sitemap" || after.discovery !== "sitemap"
    || before.discovery_error || after.discovery_error) {
    result.limitations.push("Sitemap discovery was incomplete or unavailable in at least one audit.");
  }
  if (before.truncated || after.truncated || before.pages_selected !== before.pages.length
    || after.pages_selected !== after.pages.length) {
    result.limitations.push("At least one audit has a discovery, pagination, or selected-page coverage limit.");
  }
  if (before.pages_partial || after.pages_partial || before.pages_failed || after.pages_failed
    || before.pages_skipped_robots || after.pages_skipped_robots
    || shared.some((url) => !completed(baseline.get(url)!) || !completed(current.get(url)!))) {
    result.limitations.push("At least one page failed, was excluded, or was only partially audited; missing findings are not verified fixes.");
  }
  if (before.issue_groups_truncated || after.issue_groups_truncated) {
    result.limitations.push("Grouped findings were truncated; their absence cannot establish resolution.");
  }

  result.status = result.limitations.length > 0 ? "partial" : "comparable";
  // Even when the sitemap contains more pages than this batch, changes to
  // grouped findings remain meaningful *within the same fully checked sample*.
  // Never present them as site-wide changes or as evidence of indexing.
  const sampleCanCompareGroups = sameSet
    && before.discovery_fingerprint === after.discovery_fingerprint
    && before.pages_selected === before.pages.length
    && after.pages_selected === after.pages.length
    && !before.issue_groups_truncated
    && !after.issue_groups_truncated
    && shared.every((url) => completed(baseline.get(url)!) && completed(current.get(url)!));
  if (!sampleCanCompareGroups) return result;
  if (result.status === "partial") {
    result.limitations.push("Grouped-finding changes apply only to the identical, fully checked sampled pages; they do not establish site-wide resolution.");
  }

  const beforeGroups = new Map(before.issue_groups.map((group) => [issueKey(group), group]));
  const afterGroups = new Map(after.issue_groups.map((group) => [issueKey(group), group]));
  // A duplicate machine identity invalidates group disappearance claims.
  if (beforeGroups.size !== before.issue_groups.length || afterGroups.size !== after.issue_groups.length) {
    result.status = "partial";
    result.limitations.push("Duplicate issue group identities prevent a reliable group comparison.");
    return result;
  }

  result.issue_group_comparison_available = true;
  result.newly_observed_issue_groups = sortedGroups(
    [...afterGroups].filter(([key]) => !beforeGroups.has(key)).map(([, group]) => changedGroup(group)),
  );
  result.no_longer_observed_issue_groups = sortedGroups(
    [...beforeGroups].filter(([key]) => !afterGroups.has(key)).map(([, group]) => changedGroup(group)),
  );
  for (const [key, currentGroup] of afterGroups) {
    const baselineGroup = beforeGroups.get(key);
    if (!baselineGroup || currentGroup.affected_pages === baselineGroup.affected_pages) continue;
    const delta = currentGroup.affected_pages - baselineGroup.affected_pages;
    const shift: ExpandedIssueGroup = {
      ...(currentGroup.code ? { code: currentGroup.code } : {}),
      category: currentGroup.category,
      severity: currentGroup.severity,
      message: currentGroup.message,
      before_affected_pages: baselineGroup.affected_pages,
      after_affected_pages: currentGroup.affected_pages,
      delta_pages: delta,
    };
    (delta > 0 ? result.expanding_issue_groups : result.shrinking_issue_groups).push(shift);
  }
  result.expanding_issue_groups.sort((a, b) => b.delta_pages - a.delta_pages);
  result.shrinking_issue_groups.sort((a, b) => a.delta_pages - b.delta_pages);
  return result;
}
