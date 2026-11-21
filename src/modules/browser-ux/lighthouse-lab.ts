/**
 * V11-LAB: redacted real-Lighthouse laboratory performance metrics.
 * This module never executes Lighthouse; it extracts fixed numeric fields
 * from a finished Lighthouse result, and never returns report URLs or text.
 */
export const MAX_LAB_HTML_BYTES = 180_000;
export const MAX_LAB_FINDINGS = 10;
export const MAX_LAB_BROWSER_MS = 75_000;
export const MAX_LAB_PROXY_REQUESTS = 80;
export const LAB_FACTORS = ["mobile", "desktop"] as const;
export const LAB_STATUSES = ["complete", "partial", "failed"] as const;
export const LAB_FINDING_CODES = [
  "lab_score_review", "lcp_review", "cls_review", "tbt_review",
  "metric_unavailable", "run_incomplete", "runtime_failed", "external_resources_blocked",
] as const;
export type LabFactor = typeof LAB_FACTORS[number];
export type LabStatus = typeof LAB_STATUSES[number];
export type LabCode = typeof LAB_FINDING_CODES[number];
export interface LabFinding {
  code: LabCode;
  severity: "warning" | "info";
  message: string;
}
export interface LabMetrics {
  fcp_ms: number | null;
  lcp_ms: number | null;
  tbt_ms: number | null;
  speed_index_ms: number | null;
  cls: number | null;
}
export interface LabReview {
  scope: "isolated_caller_supplied_html_lighthouse_lab";
  status: LabStatus;
  form_factor: LabFactor;
  browser_executed: boolean;
  scripts_disabled: true;
  network_isolated: true;
  lighthouse_version: string | null;
  performance_score_percent: number | null;
  metrics: LabMetrics;
  requests_blocked: number;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: LabFinding[];
  findings_truncated: boolean;
  error?: string;
}
const limitations = [
  "Real Lighthouse lab metrics for a sanitized, caller-supplied static HTML sample; no production page, external CSS/JS/fonts/assets, or live site performance was measured.",
  "Executable page scripts, handlers, iframes and network requests are blocked; this cannot measure hydration, production APIs, third-party resources or Google Web Rendering Service.",
  "FCP, LCP, TBT, Speed Index and CLS are lab observations, not 28-day CrUX field data. INP is not measured without real user interactions.",
  "Machine load, Chromium version and Lighthouse throttling influence a single run. Repeat controlled runs before comparing performance or inferring ranking effects.",
];
export function emptyLighthouseLabReview(factor: LabFactor = "mobile"): LabReview {
  return {
    scope: "isolated_caller_supplied_html_lighthouse_lab",
    status: "failed", form_factor: factor, browser_executed: false,
    scripts_disabled: true, network_isolated: true,
    lighthouse_version: null, performance_score_percent: null,
    metrics: { fcp_ms: null, lcp_ms: null, tbt_ms: null, speed_index_ms: null, cls: null },
    requests_blocked: 0, coverage_limited: true, limitations,
    total_findings: 0, findings: [], findings_truncated: false,
  };
}
export interface LighthouseAuditLike {
  numericValue?: unknown;
  numericUnit?: unknown;
}
export interface LighthouseResultLike {
  lighthouseVersion?: unknown;
  runtimeError?: unknown;
  categories?: { performance?: { score?: unknown } };
  audits?: Record<string, LighthouseAuditLike | undefined>;
}
function boundedMetric(value: unknown, max: number, places = 1): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return null;
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}
function metric(lhr: LighthouseResultLike, id: string, max: number, places = 1): number | null {
  const audit = lhr.audits?.[id];
  return audit && (id === "cumulative-layout-shift" ?
    audit.numericUnit === "unitless" || audit.numericUnit === undefined :
    audit.numericUnit === "millisecond" || audit.numericUnit === undefined)
    ? boundedMetric(audit.numericValue, max, places)
    : null;
}
export function analyzeLighthouseLabResult(
  raw: LighthouseResultLike | null | undefined,
  factor: LabFactor = "mobile",
  blocked = 0,
): LabReview {
  if (!LAB_FACTORS.includes(factor) || !Number.isInteger(blocked) || blocked < 0) {
    throw new Error("Invalid Lighthouse lab evidence");
  }
  const report = emptyLighthouseLabReview(factor);
  report.browser_executed = raw !== null && raw !== undefined;
  report.requests_blocked = Math.min(MAX_LAB_PROXY_REQUESTS, blocked);
  const add = (code: LabCode, severity: LabFinding["severity"], message: string) => {
    report.total_findings++;
    if (report.findings.length < MAX_LAB_FINDINGS) report.findings.push({ code, severity, message });
  };
  if (!raw || typeof raw !== "object" || raw.runtimeError) {
    add("runtime_failed", "warning", "Lighthouse did not deliver a valid completed laboratory report.");
    return report;
  }
  report.lighthouse_version = typeof raw.lighthouseVersion === "string" &&
    /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(raw.lighthouseVersion)
    ? raw.lighthouseVersion.slice(0, 50) : null;
  const score = raw.categories?.performance?.score;
  report.performance_score_percent = typeof score === "number" &&
    Number.isFinite(score) && score >= 0 && score <= 1
      ? Math.round(score * 100) : null;
  report.metrics = {
    fcp_ms: metric(raw, "first-contentful-paint", 600_000),
    lcp_ms: metric(raw, "largest-contentful-paint", 600_000),
    tbt_ms: metric(raw, "total-blocking-time", 600_000),
    speed_index_ms: metric(raw, "speed-index", 600_000),
    cls: metric(raw, "cumulative-layout-shift", 100, 3),
  };
  const available = Object.values(report.metrics).filter((n) => n !== null).length;
  report.status = report.performance_score_percent !== null && available === 5
    ? "complete" : "partial";
  if (report.performance_score_percent !== null && report.performance_score_percent < 90) {
    add("lab_score_review", "info", "Lighthouse laboratory performance score is below 90; repeat with comparable inputs and machine load.");
  }
  if (report.metrics.lcp_ms !== null && report.metrics.lcp_ms > 2500)
    add("lcp_review", "warning", "Laboratory largest contentful paint exceeds 2.5 seconds for this isolated static sample.");
  if (report.metrics.cls !== null && report.metrics.cls > 0.1)
    add("cls_review", "warning", "Laboratory cumulative layout shift exceeds 0.1 for this isolated static sample.");
  if (report.metrics.tbt_ms !== null && report.metrics.tbt_ms > 200)
    add("tbt_review", "warning", "Laboratory total blocking time exceeds 200 ms for this isolated static sample.");
  if (available < 5) add("metric_unavailable", "info",
    "One or more Lighthouse laboratory metrics are missing or invalid; zero was not substituted.");
  if (report.status !== "complete") add("run_incomplete", "info",
    "The performance category or metric sample is incomplete and cannot support a full laboratory score.");
  if (report.requests_blocked > 0) add("external_resources_blocked", "info",
    "Resource attempts were denied by the isolated test policy; these are not confirmed production failures.");
  report.findings_truncated = report.findings.length < report.total_findings;
  return report;
}
