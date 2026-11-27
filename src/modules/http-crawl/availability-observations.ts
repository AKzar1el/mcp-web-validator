/**
 * V02: bounded point-in-time availability-history observations.
 * This is an analyzer of observed outcomes, NOT an uptime monitor, a scheduler,
 * a Googlebot verification tool, or evidence of continuous availability.
 */
import { strictObservationTime } from "../change-regression/strict-observation-time.js";

export const MAX_AVAILABILITY_OBSERVATIONS = 48;
export const MAX_AVAILABILITY_FINDINGS = 12;
export const AVAILABILITY_FAILURE_CODES = [
  "timeout", "dns_error", "network_error", "fetch_error", "policy_blocked",
] as const;
export const AVAILABILITY_STATES = [
  "success", "challenge", "redirect", "forbidden", "rate_limited", "client_error",
  "server_error", "timeout", "transport_error", "policy_blocked", "other",
] as const;
export const AVAILABILITY_FINDING_CODES = [
  "intermittent_non_success", "latest_non_success", "rate_limiting",
  "server_failures", "transport_failures", "challenge_observed",
  "status_transitions", "sparse_samples", "large_sampling_gap",
] as const;

export type AvailabilityFailureCode = typeof AVAILABILITY_FAILURE_CODES[number];
export type AvailabilityState = typeof AVAILABILITY_STATES[number];
export type AvailabilityFindingCode = typeof AVAILABILITY_FINDING_CODES[number];

export interface AvailabilityObservation {
  observed_at: string;
  status_code?: number;
  failure?: AvailabilityFailureCode;
  cf_challenge?: boolean;
  elapsed_ms?: number;
}

export interface AvailabilitySample {
  observation: number;
  observed_at: string;
  status_code?: number;
  state: AvailabilityState;
  cf_challenge: boolean;
  elapsed_ms?: number;
}

export interface AvailabilityFinding {
  code: AvailabilityFindingCode;
  severity: "warning" | "info";
  message: string;
}

export interface AvailabilityReview {
  scope: "caller_supplied_history" | "live_bounded_burst" | "local_saved_history";
  observations_count: number;
  first_observed_at?: string;
  last_observed_at?: string;
  sampled_window_minutes: number;
  max_observation_gap_minutes: number;
  observed_successes: number;
  observed_redirects: number;
  observed_http_4xx: number;
  observed_http_5xx: number;
  observed_timeouts: number;
  observed_transport_failures: number;
  observed_rate_limits: number;
  observed_challenges: number;
  observed_success_percent: number;
  http_status_changes: number;
  outcome_changes: number;
  intermittent_non_success: boolean;
  longest_non_success_streak: number;
  current_non_success_streak: number;
  latest_observed_state?: AvailabilityState;
  latest_http_status?: number;
  coverage_limited: true;
  limitations: string[];
  samples: AvailabilitySample[];
  total_findings: number;
  findings: AvailabilityFinding[];
  findings_truncated: boolean;
  error?: string;
}

const limitations = [
  "Sampled response outcomes cannot establish continuous uptime, actual outage duration, or unobserved intervals.",
  "The timestamps and HTTP outcomes are supplied or observed by this caller, not verified crawler-log evidence.",
  "A short live burst tests only a brief window; repeat checks and retain snapshots for historical trend evidence.",
];

export function emptyAvailabilityReview(
  scope: AvailabilityReview["scope"] = "caller_supplied_history",
): AvailabilityReview {
  return {
    scope, observations_count: 0, sampled_window_minutes: 0, max_observation_gap_minutes: 0,
    observed_successes: 0, observed_redirects: 0, observed_http_4xx: 0,
    observed_http_5xx: 0, observed_timeouts: 0, observed_transport_failures: 0,
    observed_rate_limits: 0, observed_challenges: 0, observed_success_percent: 0,
    http_status_changes: 0, outcome_changes: 0, intermittent_non_success: false,
    longest_non_success_streak: 0, current_non_success_streak: 0,
    coverage_limited: true, limitations, samples: [], total_findings: 0,
    findings: [], findings_truncated: false,
  };
}

const failures = new Set<string>(AVAILABILITY_FAILURE_CODES);

export function validateAvailabilityObservation(value: AvailabilityObservation): number {
  const timestamp = value && typeof value === "object"
    ? strictObservationTime(value.observed_at) : undefined;
  if (timestamp === undefined) {
    throw new Error("Each availability sample requires a real ISO timestamp with an explicit UTC offset and valid calendar date and clock.");
  }
  const hasStatus = value.status_code !== undefined;
  const hasFailure = value.failure !== undefined;
  if (hasStatus === hasFailure) {
    throw new Error("Exactly one of status_code or failure is required per observation.");
  }
  if (hasStatus && (!Number.isInteger(value.status_code) ||
    value.status_code! < 100 || value.status_code! > 599)) {
    throw new Error("HTTP status must be an observed integer between 100 and 599.");
  }
  if (hasFailure && !failures.has(value.failure!)) {
    throw new Error("Unrecognized availability failure code.");
  }
  if (value.cf_challenge !== undefined &&
    (typeof value.cf_challenge !== "boolean" || (!hasStatus && value.cf_challenge))) {
    throw new Error("A challenge flag requires an actual HTTP response.");
  }
  if (value.elapsed_ms !== undefined &&
    (!Number.isInteger(value.elapsed_ms) || value.elapsed_ms < 0 || value.elapsed_ms > 120_000)) {
    throw new Error("Response elapsed_ms must be a nonnegative integer at most 120,000.");
  }
  return timestamp;
}

export function availabilityState(value: AvailabilityObservation): AvailabilityState {
  if (value.failure === "timeout") return "timeout";
  if (value.failure === "policy_blocked") return "policy_blocked";
  if (value.failure !== undefined) return "transport_error";
  const code = value.status_code!;
  // Cloudflare challenges sometimes use HTTP 200; this is not proof that the
  // protected page was delivered. Keep 403/429 error classes distinct.
  if (value.cf_challenge === true && code >= 200 && code < 300) return "challenge";
  if (code === 403) return "forbidden";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "server_error";
  if (code >= 400) return "client_error";
  if (code >= 300 && code < 400) return "redirect";
  if (code >= 200 && code < 300) return "success";
  return "other";
}

export function analyzeAvailabilityHistory(
  observations: AvailabilityObservation[],
  scope: AvailabilityReview["scope"] = "caller_supplied_history",
): AvailabilityReview {
  if (!Array.isArray(observations) || observations.length < 2 ||
    observations.length > MAX_AVAILABILITY_OBSERVATIONS) {
    throw new Error("Supply two to 48 ordered availability observations.");
  }
  const times = observations.map(validateAvailabilityObservation);
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] <= times[i - 1]) {
      throw new Error("Availability timestamps must be unique and strictly chronological.");
    }
  }
  const r = emptyAvailabilityReview(scope);
  r.observations_count = observations.length;
  r.first_observed_at = new Date(times[0]).toISOString();
  r.last_observed_at = new Date(times[times.length - 1]).toISOString();
  r.sampled_window_minutes = Math.round((times[times.length - 1] - times[0]) / 600) / 100;
  let maxGap = 0;
  let streak = 0;
  let hasNonSuccess = false;
  let previousState: AvailabilityState | undefined;
  let previousHttpStatus: number | undefined;
  for (let i = 0; i < observations.length; i += 1) {
    const value = observations[i];
    const state = availabilityState(value);
    const success = state === "success";
    const challenge = value.cf_challenge === true;
    r.samples.push({
      observation: i + 1,
      observed_at: new Date(times[i]).toISOString(),
      ...(value.status_code === undefined ? {} : { status_code: value.status_code }),
      state, cf_challenge: challenge,
      ...(value.elapsed_ms === undefined ? {} : { elapsed_ms: value.elapsed_ms }),
    });
    if (success) r.observed_successes++;
    else {
      hasNonSuccess = true;
      streak += 1;
      r.longest_non_success_streak = Math.max(r.longest_non_success_streak, streak);
    }
    if (success) streak = 0;
    if (state === "redirect") r.observed_redirects++;
    if (value.status_code !== undefined) {
      if (value.status_code >= 400 && value.status_code < 500) r.observed_http_4xx++;
      if (value.status_code >= 500) r.observed_http_5xx++;
      if (value.status_code === 429) r.observed_rate_limits++;
      if (previousHttpStatus !== undefined && previousHttpStatus !== value.status_code) {
        r.http_status_changes += 1;
      }
    }
    if (state === "timeout") r.observed_timeouts++;
    if (value.failure !== undefined) r.observed_transport_failures++;
    if (challenge) r.observed_challenges++;
    if (previousState !== undefined && previousState !== state) r.outcome_changes += 1;
    if (i > 0) maxGap = Math.max(maxGap, times[i] - times[i - 1]);
    previousState = state;
    previousHttpStatus = value.status_code;
    r.latest_observed_state = state;
    r.latest_http_status = value.status_code;
  }
  r.current_non_success_streak = streak;
  r.max_observation_gap_minutes = Math.round(maxGap / 600) / 100;
  r.observed_success_percent = Math.round(r.observed_successes * 100 / observations.length);
  r.intermittent_non_success = hasNonSuccess && r.observed_successes > 0;

  const add = (code: AvailabilityFindingCode, severity: "warning" | "info", message: string) => {
    r.total_findings++;
    if (r.findings.length < MAX_AVAILABILITY_FINDINGS) {
      r.findings.push({ code, severity, message });
    } else r.findings_truncated = true;
  };
  if (r.intermittent_non_success) add("intermittent_non_success", "warning",
    "Both successful and non-successful HTTP/transport outcomes occurred in these discrete samples.");
  if (r.latest_observed_state !== "success") add("latest_non_success", "warning",
    "The last sampled response was not a completed HTTP 2xx; verify whether the condition remains.");
  if (r.observed_rate_limits > 0) add("rate_limiting", "warning",
    "At least one sampled response reported HTTP 429 rate limiting.");
  if (r.observed_http_5xx > 0) add("server_failures", "warning",
    "One or more sampled HTTP 5xx responses were observed.");
  if (r.observed_transport_failures > 0) add("transport_failures", "warning",
    "One or more sampled requests returned no HTTP response.");
  if (r.observed_challenges > 0) add("challenge_observed", "warning",
    "One or more samples carried an explicit Cloudflare challenge flag.");
  if (r.http_status_changes > 0) add("status_transitions", "info",
    "HTTP status codes changed between adjacent response observations.");
  if (observations.length < 3) add("sparse_samples", "info",
    "Only two samples were supplied; more observations improve interpretation.");
  if (maxGap >= 60 * 60 * 1_000) add("large_sampling_gap", "info",
    "Samples include at least one gap of an hour or more; no continuity is established during gaps.");

  return r;
}
