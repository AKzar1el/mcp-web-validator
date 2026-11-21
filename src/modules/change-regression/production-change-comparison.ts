/**
 * V10: offline production HTML baseline comparison.
 * Reuses V07's audited structural parser; never fetches, renders, stores or
 * returns input text, metadata values or URLs.
 */
import { load } from "cheerio";
import { analyzeRawRendered } from "../browser-ux/raw-rendered-diff.js";
import { safeMetadataLabel } from "../content-schema/metadata-consistency.js";

export const MAX_CHANGE_HTML_BYTES = 180_000;
export const MAX_CHANGE_TOTAL_BYTES = 360_000;
export const MAX_CHANGE_FINDINGS = 14;
export const CHANGE_STATUSES = ["comparable_snapshot", "partial", "not_comparable"] as const;
export const CHANGE_FINDING_CODES = [
  "status_changed", "delivery_not_comparable", "delivery_unverified",
  "time_ambiguous", "extraction_limited", "noindex_added", "noindex_removed",
  "canonical_changed", "title_changed", "description_changed", "h1_changed",
  "robots_changed", "main_content_changed", "links_changed", "jsonld_changed",
  "html_only_changed",
] as const;

type FindingCode = typeof CHANGE_FINDING_CODES[number];
type ReviewStatus = typeof CHANGE_STATUSES[number];
export interface ChangeVersion {
  observed_at: string;
  html: string;
  http_status?: number;
}
export interface ProductionChangeInput {
  page_url: string;
  baseline: ChangeVersion;
  current: ChangeVersion;
}
export interface PageFingerprint {
  http_status: number | null;
  html_bytes: number;
  html_sha256: string | null;
  main_text_sha256: string | null;
  main_words: number | null;
  same_origin_link_targets: number | null;
  title_present: boolean | null;
  description_present: boolean | null;
  h1_count: number | null;
  canonical_state: "missing" | "self" | "different" | "ambiguous" | null;
  noindex_declared: boolean | null;
  jsonld_blocks: number | null;
  sample_truncated: boolean;
}
export interface ChangeFinding {
  code: FindingCode;
  severity: "warning" | "info";
  message: string;
}
export interface ProductionChangeReview {
  scope: "two_caller_supplied_html_observations";
  status: ReviewStatus;
  time_order_ambiguous: boolean;
  baseline: PageFingerprint;
  current: PageFingerprint;
  http_status_changed: boolean | null;
  html_fingerprint_changed: boolean | null;
  main_text_fingerprint_changed: boolean | null;
  title_changed: boolean | null;
  description_changed: boolean | null;
  h1_changed: boolean | null;
  canonical_changed: boolean | null;
  robots_changed: boolean | null;
  noindex_added: boolean | null;
  noindex_removed: boolean | null;
  main_words_added: number | null;
  main_words_removed: number | null;
  links_added: number | null;
  links_removed: number | null;
  jsonld_blocks_changed: boolean | null;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: ChangeFinding[];
  findings_truncated: boolean;
  error?: string;
}
const limitations = [
  "Only two explicitly supplied HTML observations are compared; timestamps and HTTP statuses are caller claims, not independently verified production events.",
  "No live fetches, deployments, browser execution, history writes, search-console evidence, ranking or traffic-causality conclusions.",
  "Hashes describe supplied exact HTML bytes and normalized sampled main text; a fingerprint difference is not proof of deployment causality or indexing impact.",
  "Content, links, metadata values, timestamps and page URLs are redacted. Static HTML cannot establish CSS/JS-rendered visibility or full-site coverage.",
];
function blank(): PageFingerprint {
  return {
    http_status: null, html_bytes: 0, html_sha256: null,
    main_text_sha256: null, main_words: null,
    same_origin_link_targets: null, title_present: null,
    description_present: null, h1_count: null,
    canonical_state: null, noindex_declared: null,
    jsonld_blocks: null, sample_truncated: false,
  };
}
export function emptyProductionChangeReview(): ProductionChangeReview {
  return {
    scope: "two_caller_supplied_html_observations", status: "not_comparable",
    time_order_ambiguous: false, baseline: blank(), current: blank(),
    http_status_changed: null, html_fingerprint_changed: null,
    main_text_fingerprint_changed: null, title_changed: null,
    description_changed: null, h1_changed: null, canonical_changed: null,
    robots_changed: null, noindex_added: null, noindex_removed: null,
    main_words_added: null, main_words_removed: null,
    links_added: null, links_removed: null, jsonld_blocks_changed: null,
    coverage_limited: true, limitations, total_findings: 0,
    findings: [], findings_truncated: false,
  };
}
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("");
}
function timeValue(value: string): number {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error("Expected offset-aware ISO observation times");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid observation time");
  return parsed;
}
function validateVersion(value: ChangeVersion): void {
  if (!value || typeof value.html !== "string" ||
      byteLength(value.html) > MAX_CHANGE_HTML_BYTES ||
      (value.http_status !== undefined &&
       (!Number.isInteger(value.http_status) || value.http_status < 200 || value.http_status > 599)) ||
      (value.http_status === 200 && !value.html.trim())) {
    throw new Error("Invalid bounded production HTML observation");
  }
}
function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
function extractExtra(html: string) {
  const $ = load(html);
  const head = $("head");
  const desc = normalized(head.find('meta[name="description" i]').first().attr("content") ?? "");
  const robots = head.find("meta[name][content]").toArray()
    .filter((el) => ["robots", "googlebot"].includes(($(el).attr("name") ?? "").toLowerCase()))
    .flatMap((el) => ($(el).attr("content") ?? "").toLowerCase().split(/[\s,;]+/u))
    .filter(Boolean).sort().join(",");
  const main = $("main,[role='main'],article").first();
  const content = (main.length ? main.clone() : $("body").first().clone());
  content.find("script,style,noscript,template,svg,nav,header,footer,aside").remove();
  const source = content.text();
  const tooLong = source.length > 100_000;
  return {
    desc, robots,
    normalizedMain: tooLong ? null : normalized(source).toLocaleLowerCase("en"),
    tooLong,
  };
}
export async function analyzeProductionChange(
  input: ProductionChangeInput,
): Promise<ProductionChangeReview> {
  if (!input || !safeMetadataLabel(input.page_url) || !input.baseline || !input.current) {
    throw new Error("Expected one safe query-free page URL and two observations");
  }
  validateVersion(input.baseline);
  validateVersion(input.current);
  if (byteLength(input.baseline.html) + byteLength(input.current.html) > MAX_CHANGE_TOTAL_BYTES) {
    throw new Error("Combined observations exceed HTML size limit");
  }
  const older = timeValue(input.baseline.observed_at);
  const newer = timeValue(input.current.observed_at);
  if (newer < older) throw new Error("Observation times must be oldest first");
  const report = emptyProductionChangeReview();
  report.time_order_ambiguous = newer === older;
  const a = input.baseline, b = input.current;
  report.baseline.http_status = a.http_status ?? null;
  report.current.http_status = b.http_status ?? null;
  report.http_status_changed = a.http_status === undefined || b.http_status === undefined
    ? null : a.http_status !== b.http_status;
  report.baseline.html_bytes = byteLength(a.html);
  report.current.html_bytes = byteLength(b.html);
  report.baseline.html_sha256 = a.html ? await digest(a.html) : null;
  report.current.html_sha256 = b.html ? await digest(b.html) : null;
  report.html_fingerprint_changed = report.baseline.html_sha256 && report.current.html_sha256
    ? report.baseline.html_sha256 !== report.current.html_sha256 : null;
  const add = (code: FindingCode, severity: ChangeFinding["severity"], message: string) => {
    report.total_findings++;
    if (report.findings.length < MAX_CHANGE_FINDINGS) report.findings.push({ code, severity, message });
  };
  if (report.http_status_changed) add("status_changed", "warning",
    "Supplied HTTP status codes differ; check delivery and challenge behavior before interpreting content changes.");
  if (report.time_order_ambiguous) add("time_ambiguous", "info",
    "Observations share the same claimed instant, so chronological order cannot be independently resolved.");
  if (a.http_status === undefined || b.http_status === undefined) add("delivery_unverified", "info",
    "A supplied HTTP status is missing; HTML differences cannot verify production availability.");
  if ((a.http_status !== undefined && a.http_status !== 200) ||
      (b.http_status !== undefined && b.http_status !== 200) || !a.html.trim() || !b.html.trim()) {
    report.status = "not_comparable";
    add("delivery_not_comparable", "warning",
      "At least one observation has no confirmed successful HTML delivery; content and metadata changes are suppressed, not counted as repairs.");
    report.findings_truncated = report.total_findings > report.findings.length;
    return report;
  }
  const core = analyzeRawRendered({
    page_url: input.page_url, raw_html: a.html, rendered_html: b.html,
  });
  const [before, after] = [extractExtra(a.html), extractExtra(b.html)];
  report.baseline.main_words = core.raw.main_words;
  report.current.main_words = core.rendered.main_words;
  report.baseline.same_origin_link_targets = core.raw.same_origin_link_targets;
  report.current.same_origin_link_targets = core.rendered.same_origin_link_targets;
  report.baseline.title_present = core.raw.title_present;
  report.current.title_present = core.rendered.title_present;
  report.baseline.description_present = core.raw.description_present;
  report.current.description_present = core.rendered.description_present;
  report.baseline.h1_count = core.raw.h1_count;
  report.current.h1_count = core.rendered.h1_count;
  report.baseline.canonical_state = core.raw.canonicals;
  report.current.canonical_state = core.rendered.canonicals;
  report.baseline.noindex_declared = core.raw.noindex_declared;
  report.current.noindex_declared = core.rendered.noindex_declared;
  report.baseline.jsonld_blocks = core.raw.jsonld_blocks;
  report.current.jsonld_blocks = core.rendered.jsonld_blocks;
  report.baseline.sample_truncated = core.raw.sample_truncated || before.tooLong;
  report.current.sample_truncated = core.rendered.sample_truncated || after.tooLong;
  report.baseline.main_text_sha256 = before.normalizedMain === null ? null : await digest(before.normalizedMain);
  report.current.main_text_sha256 = after.normalizedMain === null ? null : await digest(after.normalizedMain);
  report.main_text_fingerprint_changed =
    report.baseline.main_text_sha256 && report.current.main_text_sha256
      ? report.baseline.main_text_sha256 !== report.current.main_text_sha256 : null;
  report.title_changed = core.title_changed;
  report.description_changed = before.desc !== after.desc;
  report.h1_changed = core.h1_changed;
  report.canonical_changed = core.canonical_changed;
  report.robots_changed = before.robots !== after.robots;
  report.noindex_added = !core.raw.noindex_declared && core.rendered.noindex_declared;
  report.noindex_removed = core.raw.noindex_declared && !core.rendered.noindex_declared;
  // V07 exposes a bounded vocabulary and link sample; do not present an
  // incomplete sample as an exact before/after removal count.
  const sampleIncomplete = report.baseline.sample_truncated || report.current.sample_truncated;
  report.main_words_added = sampleIncomplete ? null : core.main_words_added;
  report.main_words_removed = sampleIncomplete ? null : core.main_words_removed;
  report.links_added = sampleIncomplete ? null : core.link_targets_added;
  report.links_removed = sampleIncomplete ? null : core.link_targets_removed;
  report.jsonld_blocks_changed = core.raw.jsonld_blocks !== core.rendered.jsonld_blocks;
  const limited = sampleIncomplete;
  report.status = report.time_order_ambiguous || limited ||
    a.http_status === undefined || b.http_status === undefined ? "partial" : "comparable_snapshot";
  if (limited) add("extraction_limited", "warning",
    "Main text or link sampling was truncated; absence and count differences are incomplete evidence.");
  if (report.noindex_added) add("noindex_added", "warning",
    "A noindex directive appears in the later supplied HTML.");
  if (report.noindex_removed) add("noindex_removed", "info",
    "A noindex directive is absent in the later supplied HTML; search-engine indexing remains unverified.");
  if (report.canonical_changed) add("canonical_changed", "warning",
    "Canonical declaration differs between observations; selection by search engines is not verified.");
  if (report.title_changed) add("title_changed", "info", "The supplied page title changed.");
  if (report.description_changed) add("description_changed", "info",
    "The supplied meta description changed.");
  if (report.h1_changed) add("h1_changed", "info",
    "The supplied first H1 heading changed.");
  if (report.robots_changed) add("robots_changed", "warning",
    "The supplied robots or Googlebot meta directives changed.");
  if (report.main_text_fingerprint_changed) add("main_content_changed", "info",
    "Normalized sampled main content changed; inspect authorized source versions for significance.");
  if (report.links_added || report.links_removed) add("links_changed", "info",
    "The bounded same-origin link target set changed.");
  if (report.jsonld_blocks_changed) add("jsonld_changed", "info",
    "The number of JSON-LD script blocks changed; schema validity is not established.");
  if (report.html_fingerprint_changed && report.main_text_fingerprint_changed === false &&
      !report.title_changed && !report.description_changed && !report.h1_changed &&
      !report.canonical_changed && !report.robots_changed &&
      !report.links_added && !report.links_removed && !report.jsonld_blocks_changed) {
    add("html_only_changed", "info",
      "Exact HTML bytes changed while the selected content and metadata signals remained stable.");
  }
  report.findings_truncated = report.total_findings > report.findings.length;
  return report;
}
