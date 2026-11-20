/**
 * V06: bounded, static internal-link graph analysis.
 * Only observed <a href> URLs are edges; no script execution, network, storage,
 * Googlebot identity, full-site orphan verdict, ranking or PageRank.
 */
import { load } from "cheerio";
import { safeLinkPageUrl } from "./internal-link-quality.js";

export const MAX_GRAPH_PAGES = 8;
export const MAX_GRAPH_HTML_BYTES = 1_048_576;
// The hosted MCP has a 2 MiB request-body cap; leave room for JSON metadata.
export const MAX_GRAPH_TOTAL_HTML_BYTES = 1_500_000;
export const MAX_GRAPH_LINKS_PER_PAGE = 240;
export const MAX_GRAPH_CATALOG_URLS = 256;
export const MAX_GRAPH_FINDINGS = 24;
export const MAX_GRAPH_LIVE_PAGES = 3;

export const GRAPH_FINDING_CODES = [
  "entry_not_sampled", "entry_not_crawlable", "sampled_page_unreachable",
  "possible_orphan_in_sample", "sampled_deep_page", "link_sample_truncated",
  "linked_to_http_error", "linked_to_robots_blocked", "linked_to_noindex",
  "linked_to_noncanonical", "nofollow_only_path", "unobserved_link_targets",
  "sitemap_pages_unobserved", "unsafe_links_excluded", "query_links_excluded",
  "external_base_ignored", "page_html_unverified", "no_sampled_outgoing_links",
] as const;
export type GraphFindingCode = typeof GRAPH_FINDING_CODES[number];
type GraphScope = "caller_supplied_link_graph" | "live_bounded_public_link_graph";
export interface GraphPageInput {
  url: string;
  html?: string;
  status_code?: number;
  robots_allowed?: boolean;
  noindex?: boolean;
  canonical_url?: string;
}
export interface InternalLinkGraphInput {
  site_url: string;
  pages: GraphPageInput[];
  entry_urls?: string[];
  sitemap_urls?: string[];
}
export interface GraphPageReport {
  page: number;
  html_examined: boolean;
  status_code?: number;
  robots_access: "allowed" | "disallowed" | "unknown";
  noindex_state: "declared" | "not_observed" | "unknown";
  canonical_state: "self" | "different" | "ambiguous" | "unknown";
  links_observed: number;
  internal_links: number;
  external_links: number;
  fragment_links: number;
  query_links_excluded: number;
  unsafe_links_excluded: number;
  self_links: number;
  nofollow_internal: number;
  sampled_targets: number;
  unobserved_internal_targets: number;
  incoming_sampled_sources: number;
  depth_from_entry: number | null;
  potential_orphan_in_sample: boolean;
  extraction_limited: boolean;
}
export interface GraphFinding {
  code: GraphFindingCode;
  severity: "warning" | "info";
  page: number;
  target_page?: number;
  count: number;
  message: string;
}
export interface InternalLinkGraphReview {
  scope: GraphScope;
  pages_observed: number;
  html_pages_examined: number;
  entry_pages_observed: number;
  entry_pages_missing: number;
  pages_reachable_within_sample: number;
  pages_unreachable_within_sample: number;
  deepest_observed_sample_depth: number | null;
  deep_pages_at_three_or_more: number;
  potential_orphans_within_sample: number;
  unique_observed_sample_edges: number;
  internal_links_observed: number;
  external_links_observed: number;
  nofollow_internal_links: number;
  distinct_unsampled_link_targets: number;
  unsafe_or_query_links_excluded: number;
  pages_with_truncated_links: number;
  linked_http_error_pages: number;
  linked_robots_blocked_pages: number;
  linked_declared_noindex_pages: number;
  linked_noncanonical_pages: number;
  sitemap_urls_provided: number;
  sitemap_urls_without_page_sample: number;
  sampled_pages_not_in_sitemap: number;
  robots_unknown_pages: number;
  status_unknown_pages: number;
  coverage_limited: true;
  limitations: string[];
  pages: GraphPageReport[];
  total_findings: number;
  findings: GraphFinding[];
  findings_truncated: boolean;
  error?: string;
}
const limitations = [
  "Depth is the shortest observed static <a href> path inside the supplied page sample, not a whole-site or Googlebot crawl depth.",
  "An orphan candidate has no incoming links from other supplied pages; unobserved site pages and external links may still reach it.",
  "Sitemap URLs are independent caller-supplied labels. Unobserved sitemap pages are not proven orphans, and a sitemap does not guarantee indexing.",
  "JavaScript-rendered links, query variants, historical responses, redirects and Google-selected canonicals are not followed or verified.",
];
const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const statusOK = (s?: number): boolean =>
  s === undefined || (s >= 200 && s < 300 && ![204, 205, 206].includes(s));
function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || bytes(value) > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(value)) return undefined;
  return safeLinkPageUrl(value);
}

type Edge = { to: string; nofollow: boolean };
type Extraction = {
  links: number; internal: number; external: number; fragments: number;
  query: number; unsafe: number; self: number; nofollow: number;
  limited: boolean; ignoredBase: boolean; edges: Edge[];
};

/** Reuse this pure extractor to select a tiny subset of safe same-origin live links. */
export function extractGraphLinks(html: string, pageUrl: string): Extraction {
  const safe = safeLabel(pageUrl);
  if (!safe || typeof html !== "string" || bytes(html) > MAX_GRAPH_HTML_BYTES) {
    throw new Error("Graph HTML or URL is not safe within bounded limits.");
  }
  const origin = new URL(safe).origin;
  const $ = load(html);
  // Template/JS nodes have no established network-visible navigation edges.
  $("template,script,noscript").remove();
  const baseHref = $("head > base[href]").first().attr("href");
  let base = safe;
  let ignoredBase = false;
  if (baseHref !== undefined) {
    try {
      const candidate = new URL(baseHref, safe);
      const usable = safeLabel(candidate.href);
      if (!usable || candidate.origin !== origin) ignoredBase = true;
      else base = usable;
    } catch {
      ignoredBase = true;
    }
  }
  const anchors = $("body a[href]").toArray();
  const sample = anchors.slice(0, MAX_GRAPH_LINKS_PER_PAGE);
  const out: Extraction = {
    links: sample.length, internal: 0, external: 0, fragments: 0,
    query: 0, unsafe: 0, self: 0, nofollow: 0,
    limited: anchors.length > MAX_GRAPH_LINKS_PER_PAGE,
    ignoredBase, edges: [],
  };
  for (const anchor of sample) {
    const raw = ($(anchor).attr("href") ?? "").trim();
    if (!raw || bytes(raw) > 1_024 ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(raw)) {
      out.unsafe++; continue;
    }
    if (raw.startsWith("#")) { out.fragments++; continue; }
    // A foreign or invalid <base> changes how relative URLs resolve in a browser.
    // Do not silently assume they refer to this site's own paths.
    if (ignoredBase && !/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !raw.startsWith("//")) {
      out.unsafe++; continue;
    }
    try {
      const target = new URL(raw, base);
      if (!["http:", "https:"].includes(target.protocol) ||
        !target.hostname || target.username || target.password || target.port) {
        out.unsafe++; continue;
      }
      if (target.origin !== origin) { out.external++; continue; }
      if (target.search || raw.includes("?")) { out.query++; continue; }
      target.hash = "";
      const usable = safeLabel(target.href);
      if (!usable) { out.unsafe++; continue; }
      out.internal++;
      if (usable === safe) { out.self++; continue; }
      const nofollow = ($(anchor).attr("rel") ?? "").toLowerCase()
        .split(/\s+/u).includes("nofollow");
      if (nofollow) out.nofollow++;
      out.edges.push({ to: usable, nofollow });
    } catch {
      out.unsafe++;
    }
  }
  return out;
}

/** Select next live targets without leaking the target URLs in MCP results. */
export function graphLiveTargets(html: string, pageUrl: string): string[] {
  const links = extractGraphLinks(html, pageUrl);
  return Array.from(new Set(links.edges.filter((e) => !e.nofollow)
    .map((e) => e.to))).slice(0, MAX_GRAPH_LINKS_PER_PAGE);
}

function noindexInHtml(html: string): boolean {
  const $ = load(html);
  for (const el of $("head meta[name][content]").toArray()) {
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    if (name !== "robots" && name !== "googlebot") continue;
    const content = ($(el).attr("content") ?? "").toLowerCase();
    if (content.split(/[,;\s]+/u).some((token) => token === "noindex" || token === "none")) return true;
  }
  return false;
}
function canonicalInHtml(html: string, url: string): "self" | "different" | "ambiguous" | "unknown" {
  const $ = load(html);
  const values = $("head link[rel][href]").toArray().filter((el) =>
    ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/u).includes("canonical"));
  if (!values.length) return "unknown";
  const targets = new Set<string>();
  for (const el of values) {
    const href = $(el).attr("href") ?? "";
    try {
      const target = new URL(href, url);
      target.hash = "";
      const safe = safeLabel(target.href);
      if (!safe) return "ambiguous";
      targets.add(safe);
    } catch { return "ambiguous"; }
  }
  if (targets.size !== 1) return "ambiguous";
  return [...targets][0] === url ? "self" : "different";
}

export function emptyInternalLinkGraphReview(
  scope: GraphScope = "caller_supplied_link_graph",
): InternalLinkGraphReview {
  return {
    scope, pages_observed: 0, html_pages_examined: 0,
    entry_pages_observed: 0, entry_pages_missing: 0,
    pages_reachable_within_sample: 0, pages_unreachable_within_sample: 0,
    deepest_observed_sample_depth: null, deep_pages_at_three_or_more: 0,
    potential_orphans_within_sample: 0, unique_observed_sample_edges: 0,
    internal_links_observed: 0, external_links_observed: 0,
    nofollow_internal_links: 0, distinct_unsampled_link_targets: 0,
    unsafe_or_query_links_excluded: 0, pages_with_truncated_links: 0,
    linked_http_error_pages: 0, linked_robots_blocked_pages: 0,
    linked_declared_noindex_pages: 0, linked_noncanonical_pages: 0,
    sitemap_urls_provided: 0, sitemap_urls_without_page_sample: 0,
    sampled_pages_not_in_sitemap: 0, robots_unknown_pages: 0,
    status_unknown_pages: 0, coverage_limited: true, limitations,
    pages: [], total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function analyzeInternalLinkGraph(
  input: InternalLinkGraphInput,
  scope: GraphScope = "caller_supplied_link_graph",
): InternalLinkGraphReview {
  const site = safeLabel(input?.site_url);
  if (!site || !Array.isArray(input.pages) ||
    input.pages.length < 1 || input.pages.length > MAX_GRAPH_PAGES) {
    throw new Error("Supply one to eight safe, same-origin page observations.");
  }
  const rootSite = new URL(site).origin;
  const refs = input.pages.map((item) => {
    const url = safeLabel(item?.url);
    if (!url || new URL(url).origin !== rootSite ||
      (item.html !== undefined && (typeof item.html !== "string" ||
        bytes(item.html) > MAX_GRAPH_HTML_BYTES)) ||
      (item.status_code !== undefined && (!Number.isInteger(item.status_code) ||
        item.status_code < 100 || item.status_code > 599)) ||
      (item.noindex !== undefined && typeof item.noindex !== "boolean") ||
      (item.robots_allowed !== undefined && typeof item.robots_allowed !== "boolean") ||
      (item.canonical_url !== undefined && !safeLabel(item.canonical_url))) {
      throw new Error("All page evidence must be valid, bounded and same-origin.");
    }
    return url;
  });
  if (new Set(refs).size !== refs.length) throw new Error("Page URLs must be unique.");
  const totalHtml = input.pages.reduce((sum, page) => sum + bytes(page.html ?? ""), 0);
  if (totalHtml > MAX_GRAPH_TOTAL_HTML_BYTES) throw new Error("Combined HTML exceeds the graph byte budget.");
  const entries = input.entry_urls ?? [rootSite + "/"];
  const catalog = input.sitemap_urls ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_GRAPH_PAGES ||
    !Array.isArray(catalog) || catalog.length > MAX_GRAPH_CATALOG_URLS) {
    throw new Error("Entry roots or sitemap URL evidence exceed bounded limits.");
  }
  const entryRefs = entries.map((value) => {
    const normalized = safeLabel(value);
    if (!normalized || new URL(normalized).origin !== rootSite) throw new Error("Invalid entry URL evidence.");
    return normalized;
  });
  const catalogRefs = catalog.map((value) => {
    const normalized = safeLabel(value);
    if (!normalized || new URL(normalized).origin !== rootSite) throw new Error("Invalid sitemap URL evidence.");
    return normalized;
  });
  if (new Set(entryRefs).size !== entryRefs.length ||
    new Set(catalogRefs).size !== catalogRefs.length) throw new Error("Graph label arrays require unique URLs.");
  const review = emptyInternalLinkGraphReview(scope);
  review.pages_observed = input.pages.length;
  review.sitemap_urls_provided = catalogRefs.length;
  const byUrl = new Map(refs.map((url, index) => [url, index]));
  review.sitemap_urls_without_page_sample = catalogRefs.filter((url) => !byUrl.has(url)).length;
  const inSitemap = new Set(catalogRefs);
  if (catalogRefs.length) review.sampled_pages_not_in_sitemap =
    refs.filter((url) => !inSitemap.has(url)).length;
  const roots = new Set(entryRefs.map((value) => byUrl.get(value)).filter((n): n is number => n !== undefined));
  review.entry_pages_observed = roots.size;
  review.entry_pages_missing = entryRefs.length - roots.size;

  const outgoing: Array<Array<{ target: number; nofollow: boolean }>> = [];
  const incoming: Array<Set<number>> = refs.map(() => new Set());
  const incomingFollowable: Array<Set<number>> = refs.map(() => new Set());
  const ignoredBasePages = new Set<number>();
  const uniqueEdges = new Set<string>();
  const unseen = new Set<string>();
  const reports: GraphPageReport[] = [];
  const canTraverse: boolean[] = [];

  for (const [i, page] of input.pages.entries()) {
    const examined = page.html !== undefined && statusOK(page.status_code);
    const parsed = examined ? extractGraphLinks(page.html!, refs[i]) : undefined;
    if (parsed?.ignoredBase) ignoredBasePages.add(i);
    const htmlNoindex = examined ? noindexInHtml(page.html!) : false;
    const noindexState: GraphPageReport["noindex_state"] =
      page.noindex === true || htmlNoindex ? "declared"
        : examined || page.noindex === false ? "not_observed" : "unknown";
    const observedCanonical = page.canonical_url ? safeLabel(page.canonical_url) : undefined;
    const canonicalState: GraphPageReport["canonical_state"] = observedCanonical
      ? observedCanonical === refs[i] ? "self" : "different"
      : examined ? canonicalInHtml(page.html!, refs[i]) : "unknown";
    const report: GraphPageReport = {
      page: i + 1, html_examined: examined,
      ...(page.status_code === undefined ? {} : { status_code: page.status_code }),
      robots_access: page.robots_allowed === undefined ? "unknown"
        : page.robots_allowed ? "allowed" : "disallowed",
      noindex_state: noindexState, canonical_state: canonicalState,
      links_observed: parsed?.links ?? 0,
      internal_links: parsed?.internal ?? 0, external_links: parsed?.external ?? 0,
      fragment_links: parsed?.fragments ?? 0, query_links_excluded: parsed?.query ?? 0,
      unsafe_links_excluded: parsed?.unsafe ?? 0,
      self_links: parsed?.self ?? 0, nofollow_internal: parsed?.nofollow ?? 0,
      sampled_targets: 0, unobserved_internal_targets: 0,
      incoming_sampled_sources: 0, depth_from_entry: null,
      potential_orphan_in_sample: false, extraction_limited: parsed?.limited ?? false,
    };
    reports.push(report);
    canTraverse.push(examined && page.robots_allowed !== false);
    const targetsHere = new Set<number>();
    const unobservedHere = new Set<string>();
    const edges: Array<{ target: number; nofollow: boolean }> = [];
    if (parsed) {
      for (const e of parsed.edges) {
        const index = byUrl.get(e.to);
        if (index === undefined) { unseen.add(e.to); unobservedHere.add(e.to); continue; }
        targetsHere.add(index);
        incoming[index].add(i);
        if (!e.nofollow) incomingFollowable[index].add(i);
        uniqueEdges.add(i + ":" + index);
        edges.push({ target: index, nofollow: e.nofollow });
      }
    }
    outgoing.push(edges);
    report.sampled_targets = targetsHere.size;
    report.unobserved_internal_targets = unobservedHere.size;
    review.internal_links_observed += parsed?.internal ?? 0;
    review.external_links_observed += parsed?.external ?? 0;
    review.nofollow_internal_links += parsed?.nofollow ?? 0;
    review.unsafe_or_query_links_excluded += (parsed?.unsafe ?? 0) + (parsed?.query ?? 0);
    if (report.extraction_limited) review.pages_with_truncated_links++;
    if (examined) review.html_pages_examined++;
    if (page.robots_allowed === undefined) review.robots_unknown_pages++;
    if (page.status_code === undefined) review.status_unknown_pages++;
  }
  review.unique_observed_sample_edges = uniqueEdges.size;
  review.distinct_unsampled_link_targets = unseen.size;
  for (let j = 0; j < refs.length; j++) {
    reports[j].incoming_sampled_sources = incoming[j].size;
    reports[j].potential_orphan_in_sample =
      reports[j].html_examined &&
      reports[j].robots_access !== "disallowed" &&
      !roots.has(j) && incoming[j].size === 0;
  }

  // BFS explores only observed HTML links; nofollow and explicitly disallowed
  // targets cannot establish a confident *sampled* navigational route.
  const queue: number[] = [];
  for (const root of roots) {
    if (!canTraverse[root]) continue;
    reports[root].depth_from_entry = 0;
    queue.push(root);
  }
  for (let p = 0; p < queue.length; p++) {
    const at = queue[p];
    if (!canTraverse[at]) continue;
    for (const edge of outgoing[at]) {
      if (edge.nofollow || input.pages[edge.target].robots_allowed === false ||
        !statusOK(input.pages[edge.target].status_code) ||
        reports[edge.target].depth_from_entry !== null) continue;
      reports[edge.target].depth_from_entry = reports[at].depth_from_entry! + 1;
      queue.push(edge.target);
    }
  }
  review.pages = reports;
  review.pages_reachable_within_sample = reports.filter((page) => page.depth_from_entry !== null).length;
  review.pages_unreachable_within_sample = reports.length - review.pages_reachable_within_sample;
  review.deepest_observed_sample_depth = Math.max(-1,
    ...reports.map((page) => page.depth_from_entry ?? -1)) < 0 ? null
      : Math.max(...reports.map((page) => page.depth_from_entry ?? -1));
  review.deep_pages_at_three_or_more =
    reports.filter((page) => (page.depth_from_entry ?? -1) >= 3).length;
  review.potential_orphans_within_sample =
    reports.filter((page) => page.potential_orphan_in_sample).length;

  const referenced = new Set(outgoing.flatMap((edges) => edges.map((e) => e.target)));
  const linkedIssues = (predicate: (n: GraphPageReport) => boolean): number =>
    [...referenced].filter((target) => predicate(reports[target])).length;
  review.linked_http_error_pages = linkedIssues((p) => p.status_code !== undefined &&
    p.status_code >= 400);
  review.linked_robots_blocked_pages = linkedIssues((p) => p.robots_access === "disallowed");
  review.linked_declared_noindex_pages = linkedIssues((p) => p.noindex_state === "declared");
  review.linked_noncanonical_pages = linkedIssues((p) => p.canonical_state === "different");

  function finding(code: GraphFindingCode, severity: GraphFinding["severity"],
    page: number, count: number, message: string, target_page?: number): void {
    if (!count) return;
    review.total_findings++;
    review.findings.push({
      code, severity, page, count, message,
      ...(target_page ? { target_page } : {}),
    });
  }
  finding("entry_not_sampled", "info", 0, review.entry_pages_missing,
    "At least one declared entry URL was not included in the page sample; depth for other pages may be unknown.");
  finding("entry_not_crawlable", "warning", 0,
    [...roots].filter((root) => !statusOK(input.pages[root].status_code) ||
      input.pages[root].robots_allowed === false).length,
    "At least one observed entry has an HTTP error or explicit robots disallow; it was not traversed.");
  finding("sitemap_pages_unobserved", "info", 0, review.sitemap_urls_without_page_sample,
    "Some supplied sitemap URLs have no sampled HTML; no orphan or HTTP-status conclusion is possible.");
  finding("unobserved_link_targets", "info", 0, unseen.size,
    "Observed same-origin links point beyond the supplied page set; those targets have not been verified.");
  finding("sampled_deep_page", "info", 0, review.deep_pages_at_three_or_more,
    "One or more sampled pages require three or more observed anchor steps from a supplied entry.");
  finding("linked_to_http_error", "warning", 0, review.linked_http_error_pages,
    "Observed links target sampled pages with supplied HTTP 4xx or 5xx error evidence.");
  finding("linked_to_robots_blocked", "warning", 0, review.linked_robots_blocked_pages,
    "Some observed links lead to pages reported robots-disallowed for the evaluated service or crawler.");
  finding("linked_to_noindex", "info", 0, review.linked_declared_noindex_pages,
    "Some observed links target sampled pages declaring noindex; this does not prove actual index status.");
  finding("linked_to_noncanonical", "info", 0, review.linked_noncanonical_pages,
    "Some observed links target pages declaring a different canonical preference.");
  for (const item of reports) {
    if (!item.html_examined) finding("page_html_unverified", "info", item.page, 1,
      "No usable static HTML was supplied for this page; its outgoing links are unknown.");
    if (item.extraction_limited) finding("link_sample_truncated", "info", item.page, 1,
      "The link extraction cap was reached; additional edges may exist.");
    if (item.potential_orphan_in_sample) finding("possible_orphan_in_sample", "info",
      item.page, 1, "No incoming links from other supplied pages were observed; this is not a verified whole-site orphan.");
    if (item.depth_from_entry === null) finding("sampled_page_unreachable", "info",
      item.page, 1, "No path from the observed entry pages was established within this sampled static graph.");
    if (item.depth_from_entry === null && incoming[item.page - 1].size > 0 &&
      incomingFollowable[item.page - 1].size === 0) {
      finding("nofollow_only_path", "info", item.page, 1,
        "This page only has sampled inbound links marked nofollow; those links are treated as discovery hints, not hard blocks.");
    }
    if (item.html_examined && item.internal_links === 0) finding("no_sampled_outgoing_links",
      "info", item.page, 1, "No usable same-origin anchor links were found in the inspected static HTML.");
    if (item.unsafe_links_excluded) finding("unsafe_links_excluded", "info",
      item.page, item.unsafe_links_excluded, "Some links were excluded for unsafe or unsupported URL syntax.");
    if (item.query_links_excluded) finding("query_links_excluded", "info",
      item.page, item.query_links_excluded, "Query-bearing URL variants are not conflated with clean path-only pages.");
    if (ignoredBasePages.has(item.page - 1)) finding("external_base_ignored", "info",
      item.page, 1, "Untrusted HTML base URL was ignored; relative links were not incorrectly attributed to this origin.");
  }
  review.findings.sort((a, b) => (a.severity === b.severity ? 0 :
    a.severity === "warning" ? -1 : 1) || a.page - b.page || a.code.localeCompare(b.code));
  if (review.total_findings > MAX_GRAPH_FINDINGS) {
    review.findings = review.findings.slice(0, MAX_GRAPH_FINDINGS);
    review.findings_truncated = true;
  }
  return review;
}
