/**
 * V08: bounded redacted browser resource observations.
 * HTTP 4xx/5xx are responses, NOT Puppeteer requestfailed events; request
 * transport failures, tool-policy blocks and still-pending requests are
 * independent categories. No URLs, headers or exception text is returned.
 */
export const MAX_RESOURCE_OBSERVATIONS = 64;
export const MAX_RESOURCE_FINDINGS = 20;
export const MAX_RESOURCE_BROWSER_MS = 24_000;
export const RESOURCE_TYPES = [
  "document", "script", "stylesheet", "image", "font", "xhr", "fetch",
  "media", "other",
] as const;
export const RESOURCE_OUTCOMES = [
  "http", "transport_failed", "tool_blocked", "pending",
] as const;
export const RESOURCE_FAILURE_REASONS = [
  "dns", "timeout", "tls", "connection", "canceled", "other",
] as const;
export const RESOURCE_ORIGINS = ["same_origin", "third_party", "unknown"] as const;
export const RESOURCE_FINDING_CODES = [
  "document_http_error", "document_transport_failed",
  "script_http_error", "script_transport_failed",
  "stylesheet_http_error", "stylesheet_transport_failed",
  "api_http_error", "api_transport_failed",
  "image_http_error", "font_http_error",
  "other_http_error", "other_transport_failed",
  "third_party_failures", "slow_resource_sample",
  "resource_budget_reached", "tool_blocked_resources",
  "pending_resources", "navigation_incomplete",
] as const;

export type ResourceType = typeof RESOURCE_TYPES[number];
export type ResourceOutcome = typeof RESOURCE_OUTCOMES[number];
export type ResourceFailureReason = typeof RESOURCE_FAILURE_REASONS[number];
export type ResourceOrigin = typeof RESOURCE_ORIGINS[number];
export type ResourceFindingCode = typeof RESOURCE_FINDING_CODES[number];
export interface ResourceObservation {
  resource_type: ResourceType;
  origin: ResourceOrigin;
  outcome: ResourceOutcome;
  status_code?: number;
  failure_reason?: ResourceFailureReason;
  duration_ms?: number;
}
export interface ResourceReviewInput {
  observations: ResourceObservation[];
  /** Number of requests blocked after the fixed report observation cap. */
  additional_budget_blocked?: number;
  /** Whether main navigation completed before its deadline. */
  navigation_completed?: boolean;
}
export interface ResourceTypeSummary {
  resource_type: ResourceType;
  attempted: number;
  http_responses: number;
  http_4xx: number;
  http_5xx: number;
  transport_failures: number;
  blocked_by_tool: number;
  still_pending: number;
}
export interface ResourceFinding {
  code: ResourceFindingCode;
  severity: "warning" | "info";
  count: number;
  message: string;
}
export interface ResourceFailureReview {
  scope: "caller_supplied_resource_observations" | "guarded_public_browser_resources";
  browser_executed: boolean;
  requests_recorded: number;
  http_responses: number;
  http_2xx_3xx: number;
  http_4xx: number;
  http_5xx: number;
  http_429: number;
  transport_failures: number;
  tool_blocked_requests: number;
  pending_requests: number;
  additional_budget_blocked: number;
  critical_resource_failures: number;
  api_failures: number;
  image_failures: number;
  third_party_failures: number;
  slow_requests: number;
  navigation_completed: boolean | null;
  resource_types: ResourceTypeSummary[];
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: ResourceFinding[];
  findings_truncated: boolean;
  error?: string;
}
const limitations = [
  "The report is an observed, bounded network sample from a local browser or caller evidence; it is not a continuous uptime or Googlebot resource-loading audit.",
  "HTTP 4xx/5xx responses, transport failures, explicit tool-policy blocks and pending requests are distinct. Tool blocks are not website failures.",
  "A failed image, stylesheet or script is an investigation lead, not proof of visible breakage, Google indexing failure or a ranking cause.",
  "Only capped status/transport type/count observations are returned; URLs, query tokens, response bodies, headers and browser error messages are not exposed.",
];

export function emptyResourceFailureReview(
  scope: ResourceFailureReview["scope"] = "caller_supplied_resource_observations",
): ResourceFailureReview {
  return {
    scope, browser_executed: false, requests_recorded: 0,
    http_responses: 0, http_2xx_3xx: 0, http_4xx: 0, http_5xx: 0,
    http_429: 0, transport_failures: 0, tool_blocked_requests: 0,
    pending_requests: 0, additional_budget_blocked: 0,
    critical_resource_failures: 0, api_failures: 0,
    image_failures: 0, third_party_failures: 0, slow_requests: 0,
    navigation_completed: null,
    resource_types: RESOURCE_TYPES.map((resource_type) => ({
      resource_type, attempted: 0, http_responses: 0, http_4xx: 0,
      http_5xx: 0, transport_failures: 0, blocked_by_tool: 0,
      still_pending: 0,
    })),
    coverage_limited: true, limitations, total_findings: 0, findings: [],
    findings_truncated: false,
  };
}

function validEnum<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && list.includes(value as T);
}
const critical = (type: ResourceType): boolean =>
  ["document", "script", "stylesheet"].includes(type);
const isApi = (type: ResourceType): boolean => type === "xhr" || type === "fetch";
const isHttpError = (row: ResourceObservation): boolean =>
  row.outcome === "http" && (row.status_code ?? 0) >= 400;
const hasTransportError = (row: ResourceObservation): boolean => row.outcome === "transport_failed";

export function analyzeResourceFailures(
  input: ResourceReviewInput,
  scope: ResourceFailureReview["scope"] = "caller_supplied_resource_observations",
): ResourceFailureReview {
  if (!input || !Array.isArray(input.observations) ||
    input.observations.length === 0 || input.observations.length > MAX_RESOURCE_OBSERVATIONS ||
    (input.additional_budget_blocked !== undefined &&
      (!Number.isSafeInteger(input.additional_budget_blocked) ||
        input.additional_budget_blocked < 0 || input.additional_budget_blocked > 1_000_000)) ||
    (input.navigation_completed !== undefined &&
      typeof input.navigation_completed !== "boolean")) {
    throw new Error("Supply one to 64 fixed-shape observed resource outcomes.");
  }
  const result = emptyResourceFailureReview(scope);
  result.browser_executed = scope === "guarded_public_browser_resources";
  result.requests_recorded = input.observations.length;
  result.additional_budget_blocked = input.additional_budget_blocked ?? 0;
  result.navigation_completed = input.navigation_completed ?? null;
  for (const [i, row] of input.observations.entries()) {
    if (!row || typeof row !== "object" ||
      !validEnum(RESOURCE_TYPES, row.resource_type) ||
      !validEnum(RESOURCE_OUTCOMES, row.outcome) ||
      !validEnum(RESOURCE_ORIGINS, row.origin) ||
      (row.status_code !== undefined &&
        (!Number.isInteger(row.status_code) || row.status_code < 200 ||
          row.status_code > 599 || row.outcome !== "http")) ||
      (row.outcome === "http" && row.status_code === undefined) ||
      (row.failure_reason !== undefined &&
        (!validEnum(RESOURCE_FAILURE_REASONS, row.failure_reason) ||
          row.outcome !== "transport_failed")) ||
      (row.outcome === "transport_failed" && row.failure_reason === undefined) ||
      (row.duration_ms !== undefined &&
        (!Number.isFinite(row.duration_ms) || row.duration_ms < 0 ||
          row.duration_ms > 600_000))) {
      throw new Error("Invalid browser resource observation at ordinal " + (i + 1));
    }
    const type = result.resource_types.find((x) => x.resource_type === row.resource_type)!;
    type.attempted++;
    const httpError = isHttpError(row);
    const transportError = hasTransportError(row);
    const failed = httpError || transportError;
    if (row.outcome === "http") {
      result.http_responses++;
      type.http_responses++;
      if (row.status_code! >= 500) { result.http_5xx++; type.http_5xx++; }
      else if (row.status_code! >= 400) { result.http_4xx++; type.http_4xx++; }
      else result.http_2xx_3xx++;
      if (row.status_code === 429) result.http_429++;
    } else if (transportError) {
      result.transport_failures++;
      type.transport_failures++;
    } else if (row.outcome === "tool_blocked") {
      result.tool_blocked_requests++;
      type.blocked_by_tool++;
    } else {
      result.pending_requests++;
      type.still_pending++;
    }
    if (failed && critical(row.resource_type)) result.critical_resource_failures++;
    if (failed && isApi(row.resource_type)) result.api_failures++;
    if (failed && row.resource_type === "image") result.image_failures++;
    if (failed && row.origin === "third_party") result.third_party_failures++;
    if (row.duration_ms !== undefined && row.duration_ms > 3_000 &&
      row.outcome === "http") result.slow_requests++;
  }
  const all: ResourceFinding[] = [];
  const add = (code: ResourceFindingCode, severity: "warning" | "info",
    count: number, message: string) => {
    if (count) all.push({ code, severity, count, message });
  };
  const count = (type: ResourceType, predicate: (row: ResourceObservation) => boolean) =>
    input.observations.filter((row) => row.resource_type === type && predicate(row)).length;
  for (const [type, prefix] of [
    ["document", "document"], ["script", "script"],
    ["stylesheet", "stylesheet"],
  ] as const) {
    add((prefix + "_http_error") as ResourceFindingCode, "warning",
      count(type, isHttpError), "A sampled " + prefix +
      " returned HTTP 4xx/5xx; investigate server response and resource dependency.");
    add((prefix + "_transport_failed") as ResourceFindingCode, "warning",
      count(type, hasTransportError), "A sampled " + prefix +
      " request failed at the network/browser transport level without a usable response.");
  }
  add("api_http_error", "warning",
    input.observations.filter((row) => isApi(row.resource_type) && isHttpError(row)).length,
    "A sampled fetch/XHR API request returned HTTP 4xx/5xx.");
  add("api_transport_failed", "warning",
    input.observations.filter((row) => isApi(row.resource_type) && hasTransportError(row)).length,
    "A sampled fetch/XHR request failed before receiving a usable HTTP response.");
  add("image_http_error", "info", count("image", isHttpError),
    "One or more sampled image requests returned HTTP 4xx/5xx; verify affected image elements.");
  add("font_http_error", "info", count("font", isHttpError),
    "A sampled font request returned HTTP 4xx/5xx; verify visible fallback and font loading.");
  add("other_http_error", "info",
    input.observations.filter((row) => !critical(row.resource_type) && !isApi(row.resource_type)
      && row.resource_type !== "image" && row.resource_type !== "font" &&
      isHttpError(row)).length,
    "Other sampled resource requests returned HTTP 4xx/5xx.");
  add("other_transport_failed", "info",
    input.observations.filter((row) => !critical(row.resource_type) &&
      !isApi(row.resource_type) && hasTransportError(row)).length,
    "A non-critical sampled resource request failed at the transport level.");
  add("third_party_failures", "info", result.third_party_failures,
    "Some attempted third-party requests failed; compare against browser privacy and network policy.");
  add("slow_resource_sample", "info", result.slow_requests,
    "Some completed resource responses exceeded three seconds in this limited browser sample.");
  add("resource_budget_reached", "info", result.additional_budget_blocked,
    "The diagnostic stopped additional network requests at its fixed observation cap; the page was not fully loaded.");
  add("tool_blocked_resources", "info", result.tool_blocked_requests,
    "The validator blocked some requests by policy; these are not proven failures of the site's resources.");
  add("pending_resources", "info", result.pending_requests,
    "Some requests were still pending when the sampling window ended; no failure is presumed.");
  add("navigation_incomplete", "warning", result.navigation_completed === false ? 1 : 0,
    "The browser navigation did not complete within the bounded diagnostic window; inspect independently.");
  all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1)
    || a.code.localeCompare(b.code));
  result.total_findings = all.length;
  result.findings = all.slice(0, MAX_RESOURCE_FINDINGS);
  result.findings_truncated = all.length > MAX_RESOURCE_FINDINGS;
  return result;
}
