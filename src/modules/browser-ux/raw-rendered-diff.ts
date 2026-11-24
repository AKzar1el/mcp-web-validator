/**
 * V07: deterministic, redacted comparison of HTTP source HTML and a browser
 * rendered DOM snapshot. This analyzer is pure; Chromium is a separate local
 * probe. Rendering is NOT equivalent to Google WRS or its index decision.
 */
import { load } from "cheerio";
import { safeLinkPageUrl } from "../site-architecture/internal-link-quality.js";

export const MAX_RENDER_HTML_BYTES = 524_288;
export const MAX_RENDER_TOTAL_HTML_BYTES = 1_048_576;
export const MAX_RENDER_FINDINGS = 18;
export const MAX_RENDER_LINKS = 200;
export const MAX_RENDER_WORDS = 10_000;
export const MAX_RENDER_BROWSER_MS = 15_000;

export const RENDER_FINDING_CODES = [
  "title_removed", "title_added", "title_changed",
  "description_removed", "description_added",
  "h1_removed", "h1_added",
  "main_text_dropped", "main_text_added", "main_text_changed",
  "links_removed", "links_added",
  "noindex_added", "noindex_removed",
  "canonical_changed", "jsonld_removed", "jsonld_added",
  "external_scripts_blocked", "resources_blocked",
  "script_errors_observed", "snapshot_coverage_limited",
] as const;
export type RenderFindingCode = typeof RENDER_FINDING_CODES[number];
export type RenderScope =
  "caller_supplied_rendered_snapshot" | "isolated_inline_script_chromium" |
  "isolated_public_html_inline_script_sample";

export interface RawRenderedInput {
  page_url: string;
  raw_html: string;
  rendered_html: string;
}
export interface RenderEvidence {
  scope?: RenderScope;
  browser_executed?: boolean;
  inline_scripts_attempted?: boolean;
  external_resources_blocked?: number;
  script_errors_observed?: number;
}
export interface RenderSnapshot {
  title_present: boolean;
  title_characters: number;
  description_present: boolean;
  description_characters: number;
  h1_count: number;
  main_words: number;
  same_origin_link_targets: number;
  query_links_excluded: number;
  external_link_targets: number;
  canonicals: "missing" | "self" | "different" | "ambiguous";
  noindex_declared: boolean;
  jsonld_blocks: number;
  external_script_tags: number;
  inline_script_tags: number;
  sample_truncated: boolean;
}
export interface RenderFinding {
  code: RenderFindingCode;
  severity: "warning" | "info";
  message: string;
}
export interface RawRenderedReview {
  scope: RenderScope;
  browser_executed: boolean;
  inline_scripts_attempted: boolean;
  external_resources_blocked: number;
  script_errors_observed: number;
  raw: RenderSnapshot;
  rendered: RenderSnapshot;
  title_changed: boolean;
  h1_changed: boolean;
  canonical_changed: boolean;
  noindex_changed: boolean;
  shared_main_words: number;
  main_words_removed: number;
  main_words_added: number;
  link_targets_removed: number;
  link_targets_added: number;
  unchanged_link_targets: number;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: RenderFinding[];
  findings_truncated: boolean;
  error?: string;
}

const encoder = new TextEncoder();
const bytes = (value: string): number => encoder.encode(value).byteLength;
function boundedUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || bytes(value) > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(value)) return undefined;
  return safeLinkPageUrl(value);
}
const noindexPattern = /(?:^|[\s,;])(?:noindex|none)(?:$|[\s,;])/iu;
const hasRel = (raw: string | undefined, token: string): boolean =>
  (raw ?? "").toLowerCase().split(/\s+/u).includes(token);
const textWords = (raw: string): string[] =>
  (raw.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 2 && word.length <= 60)
    .slice(0, MAX_RENDER_WORDS + 1);

function inspect(html: string, sourceUrl: string) {
  const $ = load(html);
  const head = $("head");
  const title = head.find("title").first().text().replace(/\s+/gu, " ").trim().slice(0, 600);
  const description = head.find('meta[name="description" i]').first()
    .attr("content")?.replace(/\s+/gu, " ").trim().slice(0, 1200) ?? "";
  const metaNoindex = head.find("meta[name][content]").toArray().some((el) => {
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    return ["robots", "googlebot"].includes(name) &&
      noindexPattern.test($(el).attr("content") ?? "");
  });
  const canonicals = head.find("link[rel][href]").toArray().filter((el) =>
    hasRel($(el).attr("rel"), "canonical"));
  const normalizedCanonicals = new Set<string>();
  let ambiguousCanonical = false;
  for (const el of canonicals) {
    const href = $(el).attr("href");
    if (!href) { ambiguousCanonical = true; continue; }
    try {
      const url = new URL(href, sourceUrl);
      url.hash = "";
      const safe = boundedUrl(url.href);
      if (safe) normalizedCanonicals.add(safe);
      else ambiguousCanonical = true;
    } catch { ambiguousCanonical = true; }
  }
  const canonicalState = canonicals.length === 0 ? "missing" :
    ambiguousCanonical || normalizedCanonicals.size !== 1 ? "ambiguous" :
      normalizedCanonicals.has(sourceUrl) ? "self" : "different";
  // Evaluate only text visible in the source HTML structure, not CSS computed
  // visibility or Google-selected content. Dynamic styles are out of scope.
  const main = $("main,[role='main'],article").first();
  const root = main.length ? main.clone() : $("body").first().clone();
  root.find("script,style,noscript,template,svg,nav,header,footer,aside").remove();
  const mainText = root.text();
  const sampledWords = textWords(mainText);
  const wordsTruncated = sampledWords.length > MAX_RENDER_WORDS || mainText.length > 100_000;
  const words = sampledWords.slice(0, MAX_RENDER_WORDS);
  const links = new Set<string>();
  const external = new Set<string>();
  let queryLinks = 0;
  let linksTruncated = false;
  const baseHref = head.find("base[href]").first().attr("href");
  let base = sourceUrl;
  let unsafeBase = false;
  if (baseHref !== undefined) {
    try {
      const candidate = new URL(baseHref, sourceUrl);
      const safe = boundedUrl(candidate.href);
      if (safe && candidate.origin === new URL(sourceUrl).origin) base = safe;
      else unsafeBase = true;
    } catch { unsafeBase = true; }
  }
  const anchors = $("body a[href]").toArray();
  if (anchors.length > MAX_RENDER_LINKS) linksTruncated = true;
  for (const el of anchors.slice(0, MAX_RENDER_LINKS)) {
    const raw = ($(el).attr("href") ?? "").trim();
    if (!raw || raw.length > 1024 || raw.startsWith("#")) continue;
    if (unsafeBase && !/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !raw.startsWith("//")) {
      linksTruncated = true;
      continue;
    }
    try {
      const url = new URL(raw, base);
      if (!["https:", "http:"].includes(url.protocol) ||
        url.username || url.password || url.port) continue;
      if (url.origin !== new URL(sourceUrl).origin) {
        external.add(url.origin);
        continue;
      }
      if (url.search || raw.includes("?")) {
        queryLinks++;
        continue;
      }
      url.hash = "";
      const safe = boundedUrl(url.href);
      if (safe) links.add(safe);
    } catch { /* No graph edge for unsafe or invalid URLs. */ }
  }
  const scripts = $("script").toArray();
  const scriptMediaType = (el: (typeof scripts)[number]) =>
    (($(el).attr("type") ?? "").split(";", 1)[0] ?? "").trim().toLowerCase();
  const snapshot: RenderSnapshot = {
    title_present: Boolean(title), title_characters: title.length,
    description_present: Boolean(description), description_characters: description.length,
    h1_count: $("body h1").length, main_words: words.length,
    same_origin_link_targets: links.size, query_links_excluded: queryLinks,
    external_link_targets: external.size,
    canonicals: canonicalState, noindex_declared: metaNoindex,
    jsonld_blocks: scripts.filter((el) =>
      scriptMediaType(el) === "application/ld+json").length,
    external_script_tags: scripts.filter((el) =>
      Boolean($(el).attr("src"))).length,
    inline_script_tags: scripts.filter((el) =>
      !$(el).attr("src") && !["application/ld+json", "application/json"].includes(
        scriptMediaType(el))).length,
    sample_truncated: linksTruncated || wordsTruncated,
  };
  return { snapshot, title, firstH1: $("body h1").first().text().trim().slice(0, 600),
    canonicalState, canonicalSet: normalizedCanonicals,
    links, words: new Set(words), linksTruncated, wordsTruncated };
}
const limitations = [
  "This tool compares supplied source and rendered HTML snapshots; it does not verify Googlebot, Google Web Rendering Service, indexing, search results or historical production behavior.",
  "Browser inline-script mode executes only local inline JavaScript in fresh, network-denied Chromium; external modules, frameworks, APIs, fonts, images and stylesheets do not load.",
  "Static DOM comparisons do not prove visual visibility, interactivity, hydration success, accessibility, semantic equivalence or actual loaded resource availability.",
  "All URL paths, titles, headings, text and script/console contents are omitted from output. Links with queries are excluded; only capped same-origin path-only links are compared. Numeric deltas describe samples when coverage is incomplete.",
];
export function emptyRawRenderedReview(
  scope: RenderScope = "caller_supplied_rendered_snapshot",
): RawRenderedReview {
  const blank: RenderSnapshot = {
    title_present: false, title_characters: 0,
    description_present: false, description_characters: 0,
    h1_count: 0, main_words: 0, same_origin_link_targets: 0,
    query_links_excluded: 0, external_link_targets: 0,
    canonicals: "missing", noindex_declared: false,
    jsonld_blocks: 0, external_script_tags: 0,
    inline_script_tags: 0, sample_truncated: false,
  };
  return {
    scope, browser_executed: false, inline_scripts_attempted: false,
    external_resources_blocked: 0, script_errors_observed: 0,
    raw: { ...blank }, rendered: { ...blank },
    title_changed: false, h1_changed: false, canonical_changed: false,
    noindex_changed: false, shared_main_words: 0,
    main_words_removed: 0, main_words_added: 0,
    link_targets_removed: 0, link_targets_added: 0,
    unchanged_link_targets: 0, coverage_limited: true,
    limitations, total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function analyzeRawRendered(input: RawRenderedInput,
  evidence: RenderEvidence = {}): RawRenderedReview {
  const url = boundedUrl(input?.page_url);
  if (!url || typeof input.raw_html !== "string" || !input.raw_html.trim() ||
    typeof input.rendered_html !== "string" || !input.rendered_html.trim() ||
    bytes(input.raw_html) > MAX_RENDER_HTML_BYTES ||
    bytes(input.rendered_html) > MAX_RENDER_HTML_BYTES ||
    bytes(input.raw_html) + bytes(input.rendered_html) > MAX_RENDER_TOTAL_HTML_BYTES) {
    throw new Error("Provide a safe page URL and two bounded HTML snapshots.");
  }
  const raw = inspect(input.raw_html, url);
  const rendered = inspect(input.rendered_html, url);
  const report = emptyRawRenderedReview(evidence.scope);
  report.browser_executed = evidence.browser_executed === true;
  report.inline_scripts_attempted = evidence.inline_scripts_attempted === true;
  report.external_resources_blocked = Math.min(1000,
    Math.max(0, evidence.external_resources_blocked ?? 0));
  report.script_errors_observed = Math.min(100,
    Math.max(0, evidence.script_errors_observed ?? 0));
  report.raw = raw.snapshot;
  report.rendered = rendered.snapshot;
  report.title_changed = raw.title !== rendered.title;
  report.h1_changed = raw.firstH1 !== rendered.firstH1;
  report.canonical_changed = raw.canonicalState !== rendered.canonicalState ||
    raw.canonicalSet.size !== rendered.canonicalSet.size ||
    [...raw.canonicalSet].some((value) => !rendered.canonicalSet.has(value));
  report.noindex_changed = raw.snapshot.noindex_declared !== rendered.snapshot.noindex_declared;
  report.shared_main_words = [...raw.words].filter((word) => rendered.words.has(word)).length;
  report.main_words_removed = [...raw.words].filter((word) => !rendered.words.has(word)).length;
  report.main_words_added = [...rendered.words].filter((word) => !raw.words.has(word)).length;
  report.link_targets_removed = [...raw.links].filter((target) => !rendered.links.has(target)).length;
  report.link_targets_added = [...rendered.links].filter((target) => !raw.links.has(target)).length;
  report.unchanged_link_targets = [...raw.links].filter((target) => rendered.links.has(target)).length;
  const records: RenderFinding[] = [];
  const add = (code: RenderFindingCode, severity: RenderFinding["severity"], message: string) =>
    records.push({ code, severity, message });
  if (report.raw.title_present && !report.rendered.title_present) add("title_removed",
    "warning", "An observed source title is absent from the rendered DOM.");
  else if (!report.raw.title_present && report.rendered.title_present) add("title_added",
    "info", "A title appears only after rendering; non-rendering crawlers may not see it.");
  else if (report.title_changed) add("title_changed", "info",
    "The rendered title differs from the HTTP source title.");
  if (report.raw.description_present && !report.rendered.description_present) add("description_removed",
    "warning", "A source meta description is absent from the rendered DOM.");
  else if (!report.raw.description_present && report.rendered.description_present) add("description_added",
    "info", "The rendered DOM adds a meta description not present in source HTML.");
  if (report.raw.h1_count > 0 && report.rendered.h1_count === 0) add("h1_removed",
    "warning", "A source H1 heading was absent after rendering.");
  else if (report.raw.h1_count === 0 && report.rendered.h1_count > 0) add("h1_added",
    "info", "The rendered DOM introduces an H1 absent in source HTML.");
  // Absence requires complete coverage on the side where evidence is missing.
  // A capped count on the other side remains a conservative lower bound.
  if (!rendered.wordsTruncated && report.raw.main_words >= 20 &&
    report.rendered.main_words < Math.floor(report.raw.main_words * 0.65)) {
    add("main_text_dropped", "warning",
      "Rendered main content has substantially fewer words than the supplied source.");
  } else if (!raw.wordsTruncated && report.rendered.main_words >= 20 &&
    report.raw.main_words < Math.floor(report.rendered.main_words * 0.65)) {
    add("main_text_added", "info",
      "Main textual content is predominantly rendered rather than available in source.");
  } else if (!rendered.wordsTruncated && report.main_words_removed > 15 && report.raw.main_words >= 20) {
    add("main_text_changed", "info",
      "Some distinct source text tokens were absent in the rendered sample.");
  }
  if (!rendered.linksTruncated && report.link_targets_removed) add("links_removed", "warning",
    "One or more source same-origin links are absent in the rendered DOM.");
  if (!raw.linksTruncated && report.link_targets_added) add("links_added", "info",
    "One or more same-origin links appear only in the rendered DOM.");
  if (!report.raw.noindex_declared && report.rendered.noindex_declared) add("noindex_added",
    "warning", "The rendered head declares noindex absent in source; verify indexing intentions.");
  if (report.raw.noindex_declared && !report.rendered.noindex_declared) add("noindex_removed",
    "warning", "The source noindex declaration is missing after rendering; verify effective directives.");
  if (report.canonical_changed) add("canonical_changed", "warning",
    "The observed canonical declaration changes during rendering.");
  if (report.rendered.jsonld_blocks < report.raw.jsonld_blocks) add("jsonld_removed",
    "info", "Some source JSON-LD blocks are no longer present in the rendered DOM.");
  if (report.rendered.jsonld_blocks > report.raw.jsonld_blocks) add("jsonld_added",
    "info", "Additional JSON-LD script blocks appear in the rendered DOM.");
  if (report.browser_executed && report.raw.external_script_tags) add("external_scripts_blocked",
    "info", "External scripts were not loaded in the isolated offline browser; hydration may be incomplete.");
  if (report.browser_executed && report.external_resources_blocked) add("resources_blocked",
    "info", "Chromium attempted one or more external resource requests, all blocked.");
  if (report.browser_executed && report.script_errors_observed) add("script_errors_observed",
    "info", "One or more JavaScript runtime errors occurred; error text was discarded.");
  if (report.raw.sample_truncated || report.rendered.sample_truncated) {
    add("snapshot_coverage_limited", "info",
      "Link or text coverage is incomplete; absence findings require complete coverage on the relevant side.");
  }
  records.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1)
    || a.code.localeCompare(b.code));
  report.total_findings = records.length;
  report.findings = records.slice(0, MAX_RENDER_FINDINGS);
  report.findings_truncated = records.length > MAX_RENDER_FINDINGS;
  return report;
}
