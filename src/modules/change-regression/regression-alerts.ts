/**
 * P2-02 manual-only dry-run regression monitoring and optional alert PREVIEWS.
 *
 * The caller obtains a validated historical audit review via P2-01 first.
 * This pure evaluator has no browser/network/storage/scheduler/notification API.
 * A candidate is advice to review a comparable sampled-page observation;
 * it is NEVER delivered or interpreted as a site-wide/Google metric signal.
 */
import type { HistoricalReview, HistoricalStep } from "./historical-comparisons.js";

export const MONITOR_RULES = [
  "regressed_pages", "net_error_increase", "net_warning_increase",
  "coverage_loss", "sitemap_drift",
] as const;
export type MonitorRule = typeof MONITOR_RULES[number];
export const MONITOR_DECISIONS = [
  "preview_candidate", "review_only", "suppressed",
  "below_threshold", "disabled",
] as const;
export type MonitorDecision = typeof MONITOR_DECISIONS[number];
export const MONITOR_STATUSES = [
  "preview_ready", "review_only", "no_candidate", "insufficient_evidence",
] as const;
export type MonitorStatus = typeof MONITOR_STATUSES[number];
export const MONITOR_REASON_CODES = [
  "threshold_met", "threshold_not_met", "rule_disabled",
  "incomplete_latest_pair", "ambiguous_version_order",
  "insufficient_streak_history", "regression_streak_not_met",
  "observed_validator_coverage_loss", "observed_sitemap_drift",
  "not_enough_observed_comparisons",
] as const;
export type MonitorReasonCode = typeof MONITOR_REASON_CODES[number];

export interface MonitorPolicyInput {
  min_regressed_pages?: number;
  min_net_error_increase?: number;
  min_net_warning_increase?: number;
  min_coverage_lost_pages?: number;
  consecutive_regressing_steps?: number;
  review_coverage_loss?: boolean;
  review_sitemap_drift?: boolean;
}
export interface MonitorPolicy {
  min_regressed_pages: number;
  min_net_error_increase: number;
  min_net_warning_increase: number;
  min_coverage_lost_pages: number;
  consecutive_regressing_steps: number;
  review_coverage_loss: boolean;
  review_sitemap_drift: boolean;
}
export const DEFAULT_MONITOR_POLICY: Readonly<MonitorPolicy> = Object.freeze({
  min_regressed_pages: 1,
  min_net_error_increase: 1,
  min_net_warning_increase: 1,
  min_coverage_lost_pages: 1,
  consecutive_regressing_steps: 1,
  review_coverage_loss: true,
  review_sitemap_drift: true,
});

export interface MonitorRuleResult {
  rule: MonitorRule;
  decision: MonitorDecision;
  reason_code: MonitorReasonCode;
  latest_observed_value: number;
  threshold: number;
  review_required: boolean;
  message: string;
}
export interface MonitorPreview {
  scope: "manual_sampled_regression_alert_preview_only";
  source: "local_saved_ids" | "caller_supplied_snapshots";
  status: MonitorStatus;
  dry_run: true;
  manually_invoked: true;
  scheduler_enabled: false;
  delivery_enabled: false;
  notifications_sent: 0;
  external_integrations_used: false;
  latest_baseline_version: number;
  latest_current_version: number;
  latest_comparability: "comparable_sample" | "partial" | "not_comparable";
  latest_compared_pages: number;
  latest_completed_pairs: number;
  candidate_count: number;
  review_only_count: number;
  suppressed_count: number;
  coverage_limited: true;
  policy: MonitorPolicy;
  rules: MonitorRuleResult[];
  limitations: string[];
  error?: string;
}

function intRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Enforce a small, explicit policy with no arbitrary scripts, URLs or destinations. */
export function normalizeMonitorPolicy(input?: MonitorPolicyInput): MonitorPolicy {
  if (input !== undefined && (input === null || typeof input !== "object" ||
      Array.isArray(input))) {
    throw new Error("Monitoring policy must be a bounded object");
  }
  const provided = input ?? {};
  const allowed: ReadonlySet<string> = new Set(Object.keys(DEFAULT_MONITOR_POLICY));
  if (Object.keys(provided).some((key) => !allowed.has(key))) {
    throw new Error("Monitoring policy contains unsupported options");
  }
  const merged: MonitorPolicy = { ...DEFAULT_MONITOR_POLICY, ...provided };
  if (!intRange(merged.min_regressed_pages, 1, 8) ||
    !intRange(merged.min_net_error_increase, 1, 10_000) ||
    !intRange(merged.min_net_warning_increase, 1, 10_000) ||
    !intRange(merged.min_coverage_lost_pages, 1, 8) ||
    !intRange(merged.consecutive_regressing_steps, 1, 4) ||
    typeof merged.review_coverage_loss !== "boolean" ||
    typeof merged.review_sitemap_drift !== "boolean") {
    throw new Error("Monitoring thresholds or review toggles out of allowed range");
  }
  return merged;
}

export function emptyMonitorPreview(
  source: MonitorPreview["source"],
  policy: MonitorPolicy = { ...DEFAULT_MONITOR_POLICY },
): MonitorPreview {
  return {
    scope: "manual_sampled_regression_alert_preview_only",
    source, status: "insufficient_evidence",
    dry_run: true, manually_invoked: true,
    scheduler_enabled: false, delivery_enabled: false,
    notifications_sent: 0, external_integrations_used: false,
    latest_baseline_version: 0, latest_current_version: 0,
    latest_comparability: "not_comparable",
    latest_compared_pages: 0, latest_completed_pairs: 0,
    candidate_count: 0, review_only_count: 0, suppressed_count: 0,
    coverage_limited: true, policy, rules: [],
    limitations: ["No alerts or schedules were started; bounded historical source evidence was not sufficient for a monitoring preview."],
  };
}

function validateHistoricalReview(review: HistoricalReview): HistoricalStep {
  if (!review || review.scope !== "historical_compact_audit_versions_only" ||
    !["local_saved_ids", "caller_supplied_snapshots"].includes(review.source) ||
    !Number.isSafeInteger(review.versions_compared) ||
    review.versions_compared < 2 || review.versions_compared > 10 ||
    !Array.isArray(review.consecutive_changes) ||
    review.consecutive_changes.length !== review.versions_compared - 1) {
    throw new Error("Requires a bounded, validated P2-01 historical review");
  }
  const latest = review.consecutive_changes.at(-1)!;
  if (!latest || latest.baseline_version !== review.versions_compared - 1 ||
    latest.current_version !== review.versions_compared ||
    !["comparable_sample", "partial", "not_comparable"].includes(latest.status) ||
    ![latest.shared_pages, latest.completely_checked_pairs, latest.regressed_pages,
      latest.coverage_lost_pages, latest.errors_delta_checked,
      latest.warnings_delta_checked].every((n) => Number.isSafeInteger(n))) {
    throw new Error("Historical latest transition lacks validated evidence");
  }
  return latest;
}

const TEXTS: Record<MonitorRule, string> = {
  regressed_pages: "The latest comparable selected-page sample has enough pages with increased observed errors or warnings to preview a regression review.",
  net_error_increase: "The latest fully checked matched-page sample has a positive net increase in observed error counts above the configured threshold.",
  net_warning_increase: "The latest fully checked matched-page sample has a positive net increase in observed warning counts above the configured threshold.",
  coverage_loss: "A formerly completed validator observation is now incomplete; review check availability separately from actual page quality.",
  sitemap_drift: "The sampled site discovery fingerprint changed; verify selection and crawl coverage before interpreting historical trends.",
};
const BLOCKED =
  "Preview suppressed because the latest sample is incomplete/noncomparable or the source version order is ambiguous.";
const DISABLED = "This review rule is disabled for this manual evaluation only.";
const CLEAR = "The observed value did not meet this rule's configured preview threshold.";
const STREAK = "The configured number of consecutive comparable regression transitions was not established.";

export function previewRegressionAlerts(
  review: HistoricalReview, input?: MonitorPolicyInput,
): MonitorPreview {
  const policy = normalizeMonitorPolicy(input);
  const step = validateHistoricalReview(review);
  const completeLatest = step.status === "comparable_sample" &&
    step.shared_pages > 0 &&
    step.completely_checked_pairs === step.shared_pages &&
    !review.time_order_ambiguous;
  const result = emptyMonitorPreview(review.source, policy);
  result.latest_baseline_version = step.baseline_version;
  result.latest_current_version = step.current_version;
  result.latest_comparability = step.status;
  result.latest_compared_pages = step.shared_pages;
  result.latest_completed_pairs = step.completely_checked_pairs;
  result.limitations = [
    "Manual dry-run only: no scheduled jobs, live website checks, email/webhook delivery, external data integrations or notifications of any kind.",
    "Defect alert candidates are emitted only for the latest fully comparable selected-page pair with unambiguous timestamp order, never the full site or Google ranking/traffic behavior.",
    "A coverage-loss or changed-sitemap rule produces a review-only observation, not a validated SEO defect or notification.",
    "A threshold or regression streak concerns only already-observed completed checks; source snapshots and message content are never returned.",
  ];
  const add = (rule: MonitorRule, observed: number, threshold: number,
    decision: MonitorDecision, reason: MonitorReasonCode, message: string) => {
    result.rules.push({
      rule, decision, reason_code: reason,
      latest_observed_value: observed,
      threshold, review_required: decision === "preview_candidate" || decision === "review_only",
      message,
    });
  };

  const thresholdRules = [
    { rule: "regressed_pages" as const, observed: step.regressed_pages, threshold: policy.min_regressed_pages },
    { rule: "net_error_increase" as const, observed: step.errors_delta_checked, threshold: policy.min_net_error_increase },
    { rule: "net_warning_increase" as const, observed: step.warnings_delta_checked, threshold: policy.min_net_warning_increase },
  ];
  for (const rule of thresholdRules) {
    if (!completeLatest) {
      add(rule.rule, rule.observed, rule.threshold, "suppressed",
        review.time_order_ambiguous ? "ambiguous_version_order" : "incomplete_latest_pair",
        BLOCKED);
    } else if (rule.observed < rule.threshold) {
      add(rule.rule, rule.observed, rule.threshold, "below_threshold", "threshold_not_met", CLEAR);
    } else if (rule.rule === "regressed_pages" &&
      policy.consecutive_regressing_steps > 1) {
      const required = policy.consecutive_regressing_steps;
      const recent = review.consecutive_changes.slice(-required);
      const tooShort = recent.length < required;
      const validStreak = !tooShort && recent.every((s) =>
        s.status === "comparable_sample" &&
        s.regressed_pages >= policy.min_regressed_pages);
      if (validStreak) {
        add(rule.rule, rule.observed, rule.threshold, "preview_candidate", "threshold_met", TEXTS[rule.rule]);
      } else {
        add(rule.rule, rule.observed, rule.threshold, "suppressed",
          tooShort ? "insufficient_streak_history" : "regression_streak_not_met",
          STREAK);
      }
    } else {
      add(rule.rule, rule.observed, rule.threshold, "preview_candidate", "threshold_met", TEXTS[rule.rule]);
    }
  }
  if (!policy.review_coverage_loss) {
    add("coverage_loss", step.coverage_lost_pages, policy.min_coverage_lost_pages,
      "disabled", "rule_disabled", DISABLED);
  } else if (step.coverage_lost_pages >= policy.min_coverage_lost_pages) {
    add("coverage_loss", step.coverage_lost_pages, policy.min_coverage_lost_pages,
      "review_only", "observed_validator_coverage_loss", TEXTS.coverage_loss);
  } else {
    add("coverage_loss", step.coverage_lost_pages, policy.min_coverage_lost_pages,
      "below_threshold", "threshold_not_met", CLEAR);
  }
  if (!policy.review_sitemap_drift) {
    add("sitemap_drift", step.sitemap_changed ? 1 : 0, 1,
      "disabled", "rule_disabled", DISABLED);
  } else if (step.sitemap_changed) {
    add("sitemap_drift", 1, 1, "review_only", "observed_sitemap_drift", TEXTS.sitemap_drift);
  } else {
    add("sitemap_drift", 0, 1, "below_threshold", "threshold_not_met", CLEAR);
  }
  result.candidate_count = result.rules.filter((r) => r.decision === "preview_candidate").length;
  result.review_only_count = result.rules.filter((r) => r.decision === "review_only").length;
  result.suppressed_count = result.rules.filter((r) => r.decision === "suppressed").length;
  result.status = result.candidate_count > 0 ? "preview_ready" :
    result.review_only_count > 0 ? "review_only" :
      !completeLatest ? "insufficient_evidence" : "no_candidate";
  return result;
}
