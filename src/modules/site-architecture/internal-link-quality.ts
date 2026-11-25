/**
 * P1-08: conservative internal-link and anchor-label quality review.
 *
 * The analyzed graph is strictly the caller-supplied same-origin HTML sample.
 * No network, source authentication, semantic topic classifier or ranking data.
 */
export const MAX_LINK_PAGES = 8;
export const MAX_LINK_HTML_BYTES = 160_000;
export const MAX_LINK_TOTAL_HTML_BYTES = 900_000;
export const MAX_LINKS_PER_PAGE = 160;
export const MAX_LINK_FINDINGS = 12;

export interface InternalLinkObservation {
  url: string;
  title: string;
  h1: string;
  main_present: boolean;
  navigation_links_excluded: number;
  extraction_limited: boolean;
  links: Array<{
    href: string;
    label: string;
    accessible: boolean;
    nofollow: boolean;
  }>;
}
export type InternalLinkFindingCode =
  | "accessible_anchor_missing" | "generic_anchor_text" | "repeated_anchor_multiple_targets"
  | "anchor_target_heading_low_overlap" | "nofollow_contextual_internal"
  | "no_sampled_contextual_internal_links" | "no_contextual_internal_links"
  | "sampled_target_unobserved" | "page_main_missing" | "link_sample_truncated";

export interface InternalLinkFinding {
  code: InternalLinkFindingCode;
  severity: "warning" | "info";
  confidence: "observed" | "review";
  source_page: number;
  target_page?: number;
  count: number;
  message: string;
}
export interface InternalLinkPageReview {
  page: number;
  main_present: boolean;
  internal_links: number;
  external_links: number;
  linked_sample_pages: number;
  unmatched_internal_links: number;
  missing_anchor_labels: number;
  generic_anchor_links: number;
  nofollow_internal_links: number;
  self_links: number;
  fragment_only_links: number;
  extraction_limited: boolean;
}
export interface InternalLinkReview {
  scope: "caller_supplied_same_origin_html_only";
  pages_sampled: number;
  pages_eligible: number;
  origin: string;
  internal_links_observed: number;
  external_links_observed: number;
  excluded_navigation_links: number;
  linked_sample_targets: number;
  unmatched_internal_links: number;
  missing_anchor_labels: number;
  generic_anchor_links: number;
  low_heading_overlap_links: number;
  ambiguous_anchor_target_groups: number;
  nofollow_internal_links: number;
  self_links: number;
  fragment_only_links: number;
  skipped_non_http_links: number;
  pages: InternalLinkPageReview[];
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: InternalLinkFinding[];
  findings_truncated: boolean;
}

export function emptyInternalLinkReview(): InternalLinkReview {
  return {
    scope: "caller_supplied_same_origin_html_only",
    pages_sampled: 0, pages_eligible: 0, origin: "",
    internal_links_observed: 0, external_links_observed: 0,
    excluded_navigation_links: 0, linked_sample_targets: 0,
    unmatched_internal_links: 0, missing_anchor_labels: 0,
    generic_anchor_links: 0, low_heading_overlap_links: 0,
    ambiguous_anchor_target_groups: 0, nofollow_internal_links: 0,
    self_links: 0, fragment_only_links: 0, skipped_non_http_links: 0,
    pages: [], coverage_limited: true,
    limitations: ["This bounded static same-origin link sample could not be compared."],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function safeLinkPageUrl(raw: string): string | undefined {
  if (!raw || raw.length > 512) return undefined;
  try {
    const value = new URL(raw);
    if (!["http:", "https:"].includes(value.protocol) || !value.hostname ||
      value.username || value.password || value.search || value.hash || value.port ||
      value.hostname.length > 180) return undefined;
    return value.href;
  } catch {
    return undefined;
  }
}

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "into", "is", "it", "of", "on", "or", "our", "the", "this", "to",
  "us", "with", "you", "your", "what", "why", "when", "where", "which",
]);
const genericLabels = new Set([
  "here", "click here", "read more", "learn more", "more", "more info",
  "more information", "details", "see more", "view more", "continue",
  "this link", "link", "visit", "go", "open", "read", "see details",
]);

function normalizeWords(raw: string): string[] {
  return (raw.normalize("NFKC").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 2 && word.length <= 35)
    .slice(0, 90);
}
function keyWords(raw: string): Set<string> {
  return new Set(normalizeWords(raw).filter((word) => !stopWords.has(word)));
}
function generic(label: string): boolean {
  return genericLabels.has(normalizeWords(label).join(" "));
}

/** Path-only comparison: never dereference the input URL, guess redirects, or merge query variants. */
function resolveHref(raw: string, base: URL): {
  target: URL; fragmentOnly: boolean; query: boolean;
} | undefined {
  if (!raw || raw.length > 1024) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const target = new URL(trimmed, base);
    if (!["http:", "https:"].includes(target.protocol) || !target.hostname ||
      target.username || target.password || target.port) return undefined;
    const fragmentOnly = trimmed.startsWith("#");
    const query = Boolean(target.search);
    target.hash = "";
    target.search = "";
    return { target, fragmentOnly, query };
  } catch {
    return undefined;
  }
}

export function reviewInternalLinks(observations: readonly InternalLinkObservation[]): InternalLinkReview {
  if (observations.length < 1 || observations.length > MAX_LINK_PAGES) {
    throw new Error("Supply one to eight static page observations.");
  }
  const urls = observations.map((item) => safeLinkPageUrl(item.url));
  if (urls.some((url) => !url)) throw new Error("All input page URL labels must be safe HTTP(S) URLs.");
  const references = urls.map((url) => new URL(url!));
  const site = references[0].origin;
  if (references.some((url) => url.origin !== site)) {
    throw new Error("All supplied pages must share the same exact origin.");
  }
  if (new Set(urls).size !== urls.length) {
    throw new Error("Supplied page URL labels must be unique.");
  }
  const pathIndex = new Map<string, number>(references.map((url, index) => [url.pathname, index]));
  let totalInternal = 0, totalExternal = 0, totalExcluded = 0;
  let totalUnmatched = 0, totalMissing = 0, totalGeneric = 0, totalNofollow = 0;
  let totalSelf = 0, totalFragments = 0, totalSkipped = 0, lowOverlap = 0, ambiguous = 0;
  let anyTruncated = false;
  const findings: InternalLinkFinding[] = [];
  const linked = new Set<number>();
  const reports: InternalLinkPageReview[] = [];
  const targetWords = observations.map((item) => keyWords(item.title + " " + item.h1));
  function report(code: InternalLinkFindingCode, severity: "warning" | "info",
    source_page: number, count: number, message: string,
    confidence: "observed" | "review" = "review", target_page?: number) {
    findings.push({
      code, severity, confidence, source_page, count,
      ...(target_page === undefined ? {} : { target_page }),
      message,
    });
  }

  for (const [index, page] of observations.entries()) {
    const source_page = index + 1;
    const base = references[index];
    const stats: InternalLinkPageReview = {
      page: source_page, main_present: page.main_present, internal_links: 0,
      external_links: 0, linked_sample_pages: 0, unmatched_internal_links: 0,
      missing_anchor_labels: 0, generic_anchor_links: 0,
      nofollow_internal_links: 0, self_links: 0, fragment_only_links: 0,
      extraction_limited: page.extraction_limited,
    };
    const linkedHere = new Set<number>();
    const labelsToTargets = new Map<string, Set<string>>();
    let lowHere = 0;
    totalExcluded += Math.min(page.navigation_links_excluded, MAX_LINKS_PER_PAGE);
    if (page.links.length > MAX_LINKS_PER_PAGE) {
      anyTruncated = true;
    }
    if (page.extraction_limited) anyTruncated = true;
    for (const link of page.links.slice(0, MAX_LINKS_PER_PAGE)) {
      const resolved = resolveHref(link.href, base);
      if (!resolved) {
        totalSkipped += 1;
        continue;
      }
      if (resolved.target.origin !== site) {
        stats.external_links += 1;
        totalExternal += 1;
        continue;
      }
      if (resolved.fragmentOnly) {
        stats.fragment_only_links += 1;
        totalFragments += 1;
        continue;
      }
      stats.internal_links += 1;
      totalInternal += 1;
      const self = !resolved.query && resolved.target.pathname === base.pathname;
      if (self) {
        stats.self_links += 1;
        totalSelf += 1;
      }
      if (link.nofollow) {
        stats.nofollow_internal_links += 1;
        totalNofollow += 1;
      }
      if (!link.accessible || !link.label.trim()) {
        stats.missing_anchor_labels += 1;
        totalMissing += 1;
      } else if (generic(link.label)) {
        stats.generic_anchor_links += 1;
        totalGeneric += 1;
      }
      const targetIndex = resolved.query ? undefined : pathIndex.get(resolved.target.pathname);
      if (targetIndex === undefined) {
        stats.unmatched_internal_links += 1;
        totalUnmatched += 1;
        continue;
      }
      if (!self) {
        linkedHere.add(targetIndex);
        linked.add(targetIndex);
      }
      if (!link.accessible || !link.label.trim()) continue;
      const normalized = normalizeWords(link.label).join(" ");
      // Non-empty reusable anchors to multiple distinct targets can be
      // ambiguous without surrounding context; this is only a review lead.
      if (normalized) {
        const targets = labelsToTargets.get(normalized) ?? new Set<string>();
        targets.add(resolved.target.pathname);
        labelsToTargets.set(normalized, targets);
      }
      const anchorWords = keyWords(link.label);
      const destinationWords = targetWords[targetIndex];
      // Small one-word link labels and unknown targets cannot be meaningfully
      // scored; zero overlap here is not proof of topical irrelevance.
      if (!self && !generic(link.label) && anchorWords.size >= 2 &&
        destinationWords.size >= 2 &&
        ![...anchorWords].some((term) => destinationWords.has(term))) {
        lowHere += 1;
        lowOverlap += 1;
      }
    }
    stats.linked_sample_pages = linkedHere.size;
    if (stats.missing_anchor_labels) report("accessible_anchor_missing", "warning", source_page,
      stats.missing_anchor_labels, "Some same-origin main-content links have no observed accessible name; review labels, image alternatives and nearby context.", "observed");
    if (stats.generic_anchor_links) report("generic_anchor_text", "info", source_page,
      stats.generic_anchor_links, "One or more contextual links use a generic English-only label such as 'read more'; review their accessible names in context.");
    const ambiguousGroups = [...labelsToTargets.values()].filter((values) => values.size >= 2).length;
    ambiguous += ambiguousGroups;
    if (ambiguousGroups) report("repeated_anchor_multiple_targets", "info", source_page,
      ambiguousGroups, "The same normalized anchor label points to several different supplied targets; confirm that destination differences are clear to readers.");
    if (lowHere) report("anchor_target_heading_low_overlap", "info", source_page,
      lowHere, "Some descriptive anchor labels share no exact content tokens with the sampled target title or first main heading; synonym and semantic relevance were not assessed.");
    if (stats.nofollow_internal_links) report("nofollow_contextual_internal", "info", source_page,
      stats.nofollow_internal_links, "One or more same-origin contextual links declare rel=nofollow; confirm this is intentional.", "observed");
    if (page.main_present && stats.internal_links === 0) {
      report("no_contextual_internal_links", "info", source_page, 1,
        "No same-origin contextual links were observed in this page's main content; navigation links were intentionally excluded.");
    } else if (page.main_present && stats.internal_links > 0 && linkedHere.size === 0 &&
      observations.length > 1 && stats.unmatched_internal_links > 0) {
      report("no_sampled_contextual_internal_links", "info", source_page, 1,
        "This page's observed internal main links do not reach another supplied page; unknown targets were not crawled or judged broken.");
    }
    if (stats.unmatched_internal_links) report("sampled_target_unobserved", "info", source_page,
      stats.unmatched_internal_links, "Some same-origin link targets are outside this supplied page set or use query variants; their status and relevance remain unverified.");
    if (!page.main_present) report("page_main_missing", "info", source_page, 1,
      "No explicit main/article region was found; body fallback may include extra site chrome.");
    if (page.extraction_limited) report("link_sample_truncated", "info", source_page, 1,
      "This page reached a bounded extraction cap; further links were not inspected.");
    reports.push(stats);
  }
  const priority = { warning: 0, info: 1 };
  findings.sort((a, b) => priority[a.severity] - priority[b.severity] ||
    a.source_page - b.source_page || a.code.localeCompare(b.code));
  return {
    scope: "caller_supplied_same_origin_html_only",
    pages_sampled: observations.length,
    pages_eligible: observations.length,
    origin: site,
    internal_links_observed: totalInternal, external_links_observed: totalExternal,
    excluded_navigation_links: totalExcluded, linked_sample_targets: linked.size,
    unmatched_internal_links: totalUnmatched,
    missing_anchor_labels: totalMissing, generic_anchor_links: totalGeneric,
    low_heading_overlap_links: lowOverlap,
    ambiguous_anchor_target_groups: ambiguous,
    nofollow_internal_links: totalNofollow,
    self_links: totalSelf, fragment_only_links: totalFragments,
    skipped_non_http_links: totalSkipped,
    pages: reports,
    coverage_limited: true,
    limitations: [
      "Only caller-supplied same-origin static HTML and main-content links are compared. Unknown links are not fetched, verified, ranked or assumed broken.",
      "Anchor quality uses visible/accessibility labels, exact English generic phrases and lexical title/H1 overlap only; this is not semantic relevance, PageRank, or Google search guidance.",
      "Navigation/header/footer/hidden links are excluded; links to unsupplied targets, redirects, rel canonical, dynamic JavaScript and query-variant target content remain unverified.",
      ...(anyTruncated ? ["At least one HTML/link extraction cap was reached, so some main-content links may be missing."] : []),
    ],
    total_findings: findings.length,
    findings: findings.slice(0, MAX_LINK_FINDINGS),
    findings_truncated: findings.length > MAX_LINK_FINDINGS,
  };
}
