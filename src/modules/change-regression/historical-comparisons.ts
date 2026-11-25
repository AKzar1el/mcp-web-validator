/**
 * P2-01: pure offline longitudinal comparisons of already-saved or supplied
 * compact site-audit snapshots. One analyzer for both MCP runtimes.
 * No network, filesystem, storage, timers or external dependency.
 *
 * An audit's absent observation is NOT a fixed defect. Stable cohort trends
 * contain only pages completed across every supplied version.
 */
import { strictObservationTime } from "./strict-observation-time.js";

export const MAX_HISTORICAL_VERSIONS = 10;
export const MAX_HISTORICAL_SNAPSHOT_BYTES = 60_000;
export const MAX_HISTORICAL_TOTAL_BYTES = 610_000;
export const MAX_HISTORICAL_PAGES = 8;
export const MAX_HISTORICAL_GROUPS = 50;
export const MAX_HISTORICAL_FINDINGS = 12;

export const HISTORICAL_STATUSES = ["comparable_sample", "partial", "not_comparable"] as const;
export type HistoricalStatus = typeof HISTORICAL_STATUSES[number];
export const HISTORICAL_FINDING_CODES = [
  "equal_timestamps", "changed_sitemap_fingerprint", "changed_sample",
  "incomplete_coverage", "nonoverlapping_versions", "regressed_pages",
  "mixed_page_changes", "coverage_lost", "group_changes_unavailable",
  "all_versions_incomplete", "historical_sample_only",
] as const;
export type HistoricalFindingCode = typeof HISTORICAL_FINDING_CODES[number];

export interface HistoricalPage {
  url: string;
  fetched_url?: string;
  status: "passed" | "needs_attention" | "partial" | "failed" | "skipped";
  page_fetched: boolean;
  html_validation_status: "completed" | "timeout" | "unavailable" | "not_run";
  html_errors: number;
  html_warnings: number;
  seo_errors: number;
  seo_warnings: number;
  schema_errors: number;
  schema_warnings: number;
  health_score?: number;
  redirects_followed?: number;
}
export interface HistoricalIssueGroup {
  category: "HTML" | "SEO" | "Schema" | "Accessibility";
  severity: "error" | "warning" | "info";
  code?: string;
  message: string;
  affected_pages: number;
}
export interface HistoricalSnapshot {
  site_url: string;
  discovery: "sitemap" | "root_only" | "partial";
  discovery_error?: string;
  discovery_fingerprint: string;
  pages_selected: number;
  pages_discovered: number;
  pages_partial: number;
  pages_failed: number;
  pages_skipped_robots: number;
  truncated: boolean;
  score_coverage_percent: number;
  pages: HistoricalPage[];
  issue_groups: HistoricalIssueGroup[];
  issue_groups_truncated: boolean;
}
export interface HistoricalVersion {
  saved_at: string;
  snapshot: HistoricalSnapshot;
}
export interface HistoricalPoint {
  version: number;
  sampled_pages: number;
  completed_pages: number;
  sample_limited: boolean;
  cohort_completed_pages: number;
  cohort_errors: number | null;
  cohort_warnings: number | null;
  cohort_mean_health_score: number | null;
}
export interface HistoricalStep {
  baseline_version: number;
  current_version: number;
  status: HistoricalStatus;
  shared_pages: number;
  completely_checked_pairs: number;
  regressed_pages: number;
  improved_pages: number;
  mixed_pages: number;
  unchanged_pages: number;
  coverage_lost_pages: number;
  coverage_recovered_pages: number;
  unverified_pages: number;
  errors_delta_checked: number;
  warnings_delta_checked: number;
  changed_sample: boolean;
  sitemap_changed: boolean;
  issue_group_comparison_available: boolean;
  newly_observed_groups: number | null;
  no_longer_observed_groups: number | null;
  expanding_groups: number | null;
  shrinking_groups: number | null;
}
export interface HistoricalFinding {
  version: number;
  code: HistoricalFindingCode;
  severity: "warning" | "info";
  message: string;
}
export interface HistoricalReview {
  scope: "historical_compact_audit_versions_only";
  source: "local_saved_ids" | "caller_supplied_snapshots";
  status: HistoricalStatus;
  versions_compared: number;
  comparisons_made: number;
  comparable_transitions: number;
  partial_transitions: number;
  not_comparable_transitions: number;
  stable_cohort_pages: number;
  complete_stable_cohort_pages: number;
  cohort_metrics_available: boolean;
  time_order_ambiguous: boolean;
  total_regressed_page_transitions: number;
  total_improved_page_transitions: number;
  total_coverage_lost_transitions: number;
  historical_points: HistoricalPoint[];
  consecutive_changes: HistoricalStep[];
  first_last_change: HistoricalStep | null;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: HistoricalFinding[];
  findings_truncated: boolean;
  error?: string;
}

const encoder = new TextEncoder();
const int = (value: unknown, max = 1_000_000): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function emptyHistoricalReview(
  source: HistoricalReview["source"],
): HistoricalReview {
  return {
    scope: "historical_compact_audit_versions_only",
    source, status: "not_comparable", versions_compared: 0,
    comparisons_made: 0, comparable_transitions: 0, partial_transitions: 0,
    not_comparable_transitions: 0, stable_cohort_pages: 0,
    complete_stable_cohort_pages: 0, cohort_metrics_available: false,
    time_order_ambiguous: false, total_regressed_page_transitions: 0,
    total_improved_page_transitions: 0, total_coverage_lost_transitions: 0,
    historical_points: [], consecutive_changes: [], first_last_change: null,
    coverage_limited: true,
    limitations: [
      "The supplied historical audit versions could not be compared within evidence and chronology limits.",
    ],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 ||
    /[\\\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("Invalid saved historical URL label");
  }
  const result = new URL(value);
  if (!["http:", "https:"].includes(result.protocol) || !result.hostname ||
    result.username || result.password || result.port || result.search || result.hash) {
    throw new Error("Unsafe saved historical URL label");
  }
  return result.href;
}
function checkDate(value: unknown): number {
  const parsed = strictObservationTime(value);
  if (parsed === undefined) throw new Error("History requires a real calendar date and ISO timestamp with UTC offset");
  return parsed;
}
function complete(page: HistoricalPage): boolean {
  return page.page_fetched && page.html_validation_status === "completed"
    && (page.status === "passed" || page.status === "needs_attention")
    && typeof page.health_score === "number";
}
function errorTotal(page: HistoricalPage): number {
  return page.html_errors + page.seo_errors + page.schema_errors;
}
function warningTotal(page: HistoricalPage): number {
  return page.html_warnings + page.seo_warnings + page.schema_warnings;
}
function groupKey(group: HistoricalIssueGroup): string {
  return JSON.stringify([group.category, group.severity,
    group.code ? "code" : "message", group.code ?? group.message]);
}
interface PreparedVersion {
  snapshot: HistoricalSnapshot;
  pages: Map<string, HistoricalPage>;
  completed: Set<string>;
  groups: Map<string, HistoricalIssueGroup>;
  duplicateGroups: boolean;
  sampleLimited: boolean;
}
function prepare(snapshot: HistoricalSnapshot): PreparedVersion {
  if (!snapshot || typeof snapshot !== "object"
    || !Array.isArray(snapshot.pages) || snapshot.pages.length > MAX_HISTORICAL_PAGES
    || !Array.isArray(snapshot.issue_groups) || snapshot.issue_groups.length > MAX_HISTORICAL_GROUPS
    || !int(snapshot.pages_selected) || !int(snapshot.pages_discovered)
    || !int(snapshot.pages_partial) || !int(snapshot.pages_failed)
    || !int(snapshot.pages_skipped_robots)
    || !int(snapshot.score_coverage_percent, 100)
    || typeof snapshot.truncated !== "boolean"
    || typeof snapshot.issue_groups_truncated !== "boolean"
    || !/^[a-f0-9]{64}$/u.test(snapshot.discovery_fingerprint)) {
    throw new Error("Invalid or oversized historical snapshot structure");
  }
  if (!["sitemap", "root_only", "partial"].includes(snapshot.discovery)) {
    throw new Error("Unsupported historical discovery state");
  }
  const origin = new URL(safeUrl(snapshot.site_url)).origin;
  const pages = new Map<string, HistoricalPage>();
  const completed = new Set<string>();
  for (const page of snapshot.pages) {
    if (!page || typeof page !== "object" || !page.url ||
      !["passed", "needs_attention", "partial", "failed", "skipped"].includes(page.status) ||
      !["completed", "timeout", "unavailable", "not_run"].includes(page.html_validation_status) ||
      typeof page.page_fetched !== "boolean" ||
      ![page.html_errors, page.html_warnings, page.seo_errors, page.seo_warnings,
        page.schema_errors, page.schema_warnings].every((value) => int(value)) ||
      (page.health_score !== undefined && (!Number.isInteger(page.health_score) ||
        page.health_score < 0 || page.health_score > 100)) ||
      (page.redirects_followed !== undefined && !int(page.redirects_followed, 3))) {
      throw new Error("Invalid bounded page evidence");
    }
    const url = safeUrl(page.url);
    if (new URL(url).origin !== origin || pages.has(url)) {
      throw new Error("Duplicate or cross-origin historical page labels");
    }
    if (page.fetched_url !== undefined) safeUrl(page.fetched_url);
    pages.set(url, page);
    if (complete(page)) completed.add(url);
  }
  const groups = new Map<string, HistoricalIssueGroup>();
  for (const group of snapshot.issue_groups) {
    if (!group || typeof group !== "object" ||
      !["HTML", "SEO", "Schema", "Accessibility"].includes(group.category) ||
      !["error", "warning", "info"].includes(group.severity) ||
      typeof group.message !== "string" || group.message.length > 300 ||
      (group.code !== undefined && (typeof group.code !== "string" || group.code.length > 120)) ||
      !int(group.affected_pages) || group.affected_pages > snapshot.pages.length) {
      throw new Error("Invalid bounded historical issue-group evidence");
    }
    groups.set(groupKey(group), group);
  }
  return {
    snapshot, pages, completed, groups,
    duplicateGroups: groups.size !== snapshot.issue_groups.length,
    sampleLimited: snapshot.truncated || snapshot.pages_selected !== pages.size ||
      snapshot.pages_partial > 0 || snapshot.pages_failed > 0 ||
      snapshot.pages_skipped_robots > 0 || snapshot.discovery !== "sitemap" ||
      Boolean(snapshot.discovery_error) || snapshot.issue_groups_truncated ||
      completed.size !== pages.size,
  };
}

function comparePrepared(a: PreparedVersion, b: PreparedVersion, from: number, to: number): HistoricalStep {
  const shared = [...a.pages.keys()].filter((key) => b.pages.has(key));
  const changedSample = a.pages.size !== b.pages.size ||
    shared.length !== a.pages.size || shared.length !== b.pages.size;
  const sitemapChanged = a.snapshot.discovery_fingerprint !== b.snapshot.discovery_fingerprint;
  let checked = 0, regressed = 0, improved = 0, mixed = 0, unchanged = 0;
  let lost = 0, recovered = 0, unverified = 0;
  let errorsDelta = 0, warningsDelta = 0;
  for (const key of shared) {
    const before = a.pages.get(key)!;
    const after = b.pages.get(key)!;
    const oldDone = a.completed.has(key);
    const newDone = b.completed.has(key);
    if (oldDone && newDone) {
      checked++;
      const e = errorTotal(after) - errorTotal(before);
      const w = warningTotal(after) - warningTotal(before);
      errorsDelta += e;
      warningsDelta += w;
      const worse = e > 0 || w > 0;
      const better = e < 0 || w < 0;
      if (worse && better) mixed++;
      else if (worse) regressed++;
      else if (better) improved++;
      else unchanged++;
    } else if (oldDone && !newDone) lost++;
    else if (!oldDone && newDone) recovered++;
    else unverified++;
  }
  const sampleAligned = !changedSample && !sitemapChanged &&
    !a.sampleLimited && !b.sampleLimited &&
    checked === shared.length;
  const groupComparable = !changedSample && !sitemapChanged &&
    a.snapshot.pages_selected === a.pages.size &&
    b.snapshot.pages_selected === b.pages.size &&
    !a.snapshot.issue_groups_truncated &&
    !b.snapshot.issue_groups_truncated &&
    !a.duplicateGroups && !b.duplicateGroups &&
    checked === shared.length && shared.length > 0;
  let newGroups: number | null = null;
  let goneGroups: number | null = null;
  let expanding: number | null = null;
  let shrinking: number | null = null;
  if (groupComparable) {
    newGroups = [...b.groups.keys()].filter((key) => !a.groups.has(key)).length;
    goneGroups = [...a.groups.keys()].filter((key) => !b.groups.has(key)).length;
    expanding = [...b.groups].filter(([key, group]) =>
      a.groups.has(key) && group.affected_pages > a.groups.get(key)!.affected_pages).length;
    shrinking = [...b.groups].filter(([key, group]) =>
      a.groups.has(key) && group.affected_pages < a.groups.get(key)!.affected_pages).length;
  }
  return {
    baseline_version: from, current_version: to,
    status: shared.length === 0 ? "not_comparable" :
      sampleAligned ? "comparable_sample" : "partial",
    shared_pages: shared.length, completely_checked_pairs: checked,
    regressed_pages: regressed, improved_pages: improved,
    mixed_pages: mixed, unchanged_pages: unchanged,
    coverage_lost_pages: lost, coverage_recovered_pages: recovered,
    unverified_pages: unverified,
    errors_delta_checked: errorsDelta, warnings_delta_checked: warningsDelta,
    changed_sample: changedSample, sitemap_changed: sitemapChanged,
    issue_group_comparison_available: groupComparable,
    newly_observed_groups: newGroups, no_longer_observed_groups: goneGroups,
    expanding_groups: expanding, shrinking_groups: shrinking,
  };
}

/** All caller input is assumed untrusted and is validated, even for local saved versions. */
export function analyzeHistoricalAudits(
  versions: HistoricalVersion[], source: HistoricalReview["source"],
): HistoricalReview {
  if (!["local_saved_ids", "caller_supplied_snapshots"].includes(source) ||
    !Array.isArray(versions) || versions.length < 2 ||
    versions.length > MAX_HISTORICAL_VERSIONS) {
    throw new Error("Require between two and ten historical audit versions");
  }
  let totalBytes = 0;
  let prevTime = Number.NEGATIVE_INFINITY;
  let equalTime = false;
  const prepared: PreparedVersion[] = [];
  let origin: string | undefined;
  for (const version of versions) {
    if (!version || typeof version !== "object" || !version.snapshot) {
      throw new Error("Invalid historical version");
    }
    const time = checkDate(version.saved_at);
    if (time < prevTime) throw new Error("Historical versions must be ordered oldest to newest");
    if (time === prevTime) equalTime = true;
    prevTime = time;
    const bytes = encoder.encode(JSON.stringify(version.snapshot)).byteLength;
    if (bytes > MAX_HISTORICAL_SNAPSHOT_BYTES) {
      throw new Error("Historical snapshot exceeds 60 KB");
    }
    totalBytes += bytes;
    if (totalBytes > MAX_HISTORICAL_TOTAL_BYTES) {
      throw new Error("Total historical evidence exceeds 610 KB");
    }
    const siteOrigin = new URL(safeUrl(version.snapshot.site_url)).origin;
    if (origin !== undefined && siteOrigin !== origin) {
      throw new Error("Historical versions must share one site origin");
    }
    origin = siteOrigin;
    prepared.push(prepare(version.snapshot));
  }
  const result = emptyHistoricalReview(source);
  result.versions_compared = prepared.length;
  result.comparisons_made = prepared.length - 1;
  result.time_order_ambiguous = equalTime;
  result.limitations = [
    "Comparison uses only saved or caller-supplied compact audit evidence; no new HTTP requests, stored-history mutation, crawling, indexing, ranking or causal analysis is performed.",
    "Errors and warnings are compared only for matching pages with complete checks in both snapshots; unknown or failed checks are coverage changes, never demonstrated fixes.",
    "Cross-version cohort trends cover only exact URLs fully checked in every supplied version; changes in sitemap sampling or discovery fingerprint limit conclusions to comparable sampled pages.",
    "Issue-group appearance/disappearance is counted only with identical fully checked selected pages and matching discovery fingerprints. Even then, changes are sampled evidence, not site-wide resolution.",
  ];
  let stable = new Set(prepared[0].pages.keys());
  let completeStable = new Set(prepared[0].completed);
  for (const v of prepared.slice(1)) {
    stable = new Set([...stable].filter((key) => v.pages.has(key)));
    completeStable = new Set([...completeStable].filter((key) => v.completed.has(key)));
  }
  result.stable_cohort_pages = stable.size;
  result.complete_stable_cohort_pages = completeStable.size;
  result.cohort_metrics_available = completeStable.size > 0;
  prepared.forEach((v, i) => {
    const stablePages = [...completeStable].map((key) => v.pages.get(key)!);
    const n = stablePages.length;
    result.historical_points.push({
      version: i + 1, sampled_pages: v.pages.size,
      completed_pages: v.completed.size,
      sample_limited: v.sampleLimited,
      cohort_completed_pages: n,
      cohort_errors: n ? stablePages.reduce((acc, page) => acc + errorTotal(page), 0) : null,
      cohort_warnings: n ? stablePages.reduce((acc, page) => acc + warningTotal(page), 0) : null,
      cohort_mean_health_score: n ? Math.round(
        100 * stablePages.reduce((acc, page) => acc + page.health_score!, 0) / n,
      ) / 100 : null,
    });
  });
  const findings: HistoricalFinding[] = [];
  const add = (version: number, code: HistoricalFindingCode,
    severity: "warning" | "info", message: string) => findings.push({
    version, code, severity, message,
  });
  if (equalTime) add(1, "equal_timestamps", "info",
    "Two or more source versions have equal timestamps; preserve saved ordering, but their exact time order cannot be independently established.");
  for (let i = 1; i < prepared.length; i++) {
    const step = comparePrepared(prepared[i - 1], prepared[i], i, i + 1);
    result.consecutive_changes.push(step);
    if (step.status === "comparable_sample") result.comparable_transitions++;
    else if (step.status === "partial") result.partial_transitions++;
    else result.not_comparable_transitions++;
    result.total_regressed_page_transitions += step.regressed_pages;
    result.total_improved_page_transitions += step.improved_pages;
    result.total_coverage_lost_transitions += step.coverage_lost_pages;
    if (step.status === "not_comparable") {
      add(i + 1, "nonoverlapping_versions", "warning",
        "Consecutive versions share no exact audited page labels; a regression or improvement cannot be established.");
    }
    if (step.changed_sample) add(i + 1, "changed_sample", "info",
      "The selected page sample changed; absent pages are not proven repaired or broken.");
    if (step.sitemap_changed) add(i + 1, "changed_sitemap_fingerprint", "info",
      "Discovery fingerprints changed; historical issue and coverage trends may reflect different selections.");
    if (step.status === "partial") add(i + 1, "incomplete_coverage", "info",
      "An incomplete check, discovery constraint or differing sample limits this version-pair comparison.");
    if (step.regressed_pages) add(i + 1, "regressed_pages", "warning",
      "At least one matched, fully checked page has more observed errors or warnings than in the prior version.");
    if (step.mixed_pages) add(i + 1, "mixed_page_changes", "info",
      "Some matched pages show opposing error and warning changes; they are not simple improvements.");
    if (step.coverage_lost_pages) add(i + 1, "coverage_lost", "warning",
      "A previously completed page lacked a comparable completed check in the later version; this is not a demonstrated defect regression.");
    if (!step.issue_group_comparison_available) add(i + 1, "group_changes_unavailable", "info",
      "Issue-group appearance and disappearance cannot be safely compared for this version pair.");
  }
  result.first_last_change = comparePrepared(prepared[0], prepared.at(-1)!, 1, prepared.length);
  result.status = result.not_comparable_transitions === result.comparisons_made
    ? "not_comparable" : result.partial_transitions || result.not_comparable_transitions ||
      equalTime || !result.cohort_metrics_available ? "partial" : "comparable_sample";
  if (!result.cohort_metrics_available) add(1, "all_versions_incomplete", "warning",
    "No page was completely audited in every supplied version; longitudinal error and warning trends are unavailable.");
  add(1, "historical_sample_only", "info",
    "Historical changes describe only the exact selected audit samples, never full-site health or Google Search outcomes.");
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1) ||
    a.version - b.version || a.code.localeCompare(b.code));
  result.total_findings = findings.length;
  result.findings = findings.slice(0, MAX_HISTORICAL_FINDINGS);
  result.findings_truncated = findings.length > MAX_HISTORICAL_FINDINGS;
  return result;
}
