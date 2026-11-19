/**
 * P1-09: bounded, evidence-only metadata consistency review.
 *
 * No document fetch, canonical selection, social preview rendering, browser
 * execution, or inference of Google search outcomes. Raw values are ephemeral.
 */
export const MAX_METADATA_PAGES = 8;
export const MAX_METADATA_HTML_BYTES = 180_000;
export const MAX_METADATA_TOTAL_BYTES = 900_000;
export const MAX_METADATA_VALUES = 12;
export const MAX_METADATA_FINDINGS = 12;

export const METADATA_FIELDS = [
  "title", "description", "canonical", "og:title", "og:description", "og:url",
  "twitter:title", "twitter:description", "robots", "googlebot",
] as const;
export type MetadataField = typeof METADATA_FIELDS[number];
export type MetadataFindingCode =
  | "duplicate_declaration" | "conflicting_declaration" | "unresolved_canonical"
  | "conflicting_robots_directives" | "title_social_difference"
  | "description_social_difference" | "canonical_social_url_difference"
  | "duplicate_title_across_pages" | "duplicate_description_across_pages"
  | "truncated_metadata_sample";
export type MetadataIssue = {
  code: MetadataFindingCode;
  severity: "warning" | "info";
  confidence: "observed" | "review";
  source_page: number;
  field: MetadataField;
  count: number;
  related_pages?: number[];
  message: string;
};
export interface MetadataObservation {
  url: string;
  values: Record<MetadataField, string[]>;
  base_href?: string;
  excluded_canonicals: number;
  extraction_limited: boolean;
}
export type MetadataPageReview = {
  page: number;
  fields_present: number;
  title_declarations: number;
  description_declarations: number;
  canonical_declarations: number;
  robots_declarations: number;
  duplicate_fields: number;
  conflicting_fields: number;
  unresolved_canonicals: number;
  cross_field_review_leads: number;
  extraction_limited: boolean;
};
export type MetadataReview = {
  scope: "caller_supplied_same_origin_metadata_only";
  pages_sampled: number;
  origin: string;
  duplicate_declaration_fields: number;
  conflicting_declaration_fields: number;
  unresolved_canonical_references: number;
  explicit_robots_conflicts: number;
  cross_field_review_leads: number;
  duplicate_title_groups: number;
  duplicate_description_groups: number;
  excluded_annotated_canonicals: number;
  pages: MetadataPageReview[];
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: MetadataIssue[];
  findings_truncated: boolean;
};

export function safeMetadataLabel(raw: string): string | undefined {
  if (!raw || raw.length > 512) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.search || url.hash || url.port || url.hostname.length > 180) return;
    return url.href;
  } catch {
    return undefined;
  }
}
function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
}
function normalizedUrl(value: string, base: string): string | undefined {
  if (!value || value.length > 1024) return undefined;
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
function robotsTokens(raw: string): string[] {
  return raw.toLocaleLowerCase("en").split(",")
    .map((piece) => piece.trim().replace(/\s*:\s*/gu, ":").replace(/\s+/gu, " "))
    .filter(Boolean)
    .flatMap((piece) => piece === "none" ? ["noindex", "nofollow"]
      : piece === "all" ? ["index", "follow"] : [piece]);
}
function robotsParts(raw: string): Set<string> {
  return new Set(robotsTokens(raw).map((token) => token.split(/[:\s]/u)[0]));
}
function normalizedRobots(raw: string): string {
  return [...new Set(robotsTokens(raw))].sort().join(",");
}
function robotsDeclarationConflict(rawValues: readonly string[]): boolean {
  const tokens = new Set(rawValues.flatMap(robotsTokens));
  const parts = new Set([...tokens].map((token) => token.split(/[:\s]/u)[0]));
  if ((parts.has("index") && parts.has("noindex")) ||
      (parts.has("follow") && parts.has("nofollow"))) return true;
  const byDirective = new Map<string, string>();
  for (const token of tokens) {
    const key = token.split(/[:\s]/u)[0];
    const existing = byDirective.get(key);
    if (existing && existing !== token) return true;
    byDirective.set(key, token);
  }
  return false;
}

export function emptyMetadataReview(): MetadataReview {
  return {
    scope: "caller_supplied_same_origin_metadata_only",
    pages_sampled: 0, origin: "", duplicate_declaration_fields: 0,
    conflicting_declaration_fields: 0, unresolved_canonical_references: 0,
    explicit_robots_conflicts: 0, cross_field_review_leads: 0,
    duplicate_title_groups: 0, duplicate_description_groups: 0,
    excluded_annotated_canonicals: 0, pages: [], coverage_limited: true,
    limitations: ["The supplied metadata sample could not be compared within its limits."],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function analyzeMetadataConsistency(observations: readonly MetadataObservation[]): MetadataReview {
  if (!observations.length || observations.length > MAX_METADATA_PAGES) {
    throw new Error("Supply one to eight metadata observations.");
  }
  const pages = observations.map((observation) => safeMetadataLabel(observation.url));
  if (pages.some((url) => !url) || new Set(pages).size !== pages.length) {
    throw new Error("Page labels must be distinct safe HTTP(S) URLs.");
  }
  const origin = new URL(pages[0]!).origin;
  if (pages.some((url) => new URL(url!).origin !== origin)) {
    throw new Error("All supplied page URLs must share one exact origin.");
  }
  const findings: MetadataIssue[] = [];
  const pageSummaries: MetadataPageReview[] = [];
  const identities: string[] = [];
  let duplicates = 0, conflicts = 0, unresolved = 0, robotsConflicts = 0;
  let crossField = 0, excluded = 0;
  let extractionLimited = false;

  function add(code: MetadataFindingCode, severity: MetadataIssue["severity"],
    page: number, field: MetadataField, count: number, message: string,
    confidence: MetadataIssue["confidence"] = "review", related_pages?: number[]) {
    findings.push({
      code, severity, confidence, source_page: page, field, count, message,
      ...(related_pages?.length ? { related_pages: related_pages.slice(0, MAX_METADATA_PAGES - 1) } : {}),
    });
  }
  for (const [i, sample] of observations.entries()) {
    const page = i + 1;
    const input = sample.values;
    const stats: MetadataPageReview = {
      page, fields_present: 0,
      title_declarations: input.title.length,
      description_declarations: input.description.length,
      canonical_declarations: input.canonical.length,
      robots_declarations: input.robots.length + input.googlebot.length,
      duplicate_fields: 0, conflicting_fields: 0,
      unresolved_canonicals: 0, cross_field_review_leads: 0,
      extraction_limited: sample.extraction_limited,
    };
    excluded += sample.excluded_canonicals;
    let base = pages[i]!;
    if (sample.base_href) {
      const resolved = normalizedUrl(sample.base_href, base);
      // Relative canonicals with an unresolvable <base> are never compared
      // against the document URL as if the override did not exist.
      base = resolved ?? "";
      if (!resolved) extractionLimited = true;
    }
    const canonicalTargets: string[] = [];
    for (const raw of input.canonical.slice(0, MAX_METADATA_VALUES)) {
      const parsed = base ? normalizedUrl(raw, base) : undefined;
      if (parsed) canonicalTargets.push(parsed);
      else {
        unresolved += 1;
        stats.unresolved_canonicals += 1;
      }
    }
    if (stats.unresolved_canonicals) add("unresolved_canonical", "info", page,
      "canonical", stats.unresolved_canonicals,
      "An explicit canonical preference could not be compared safely; invalid, fragment-bearing, credentialed or unresolved URLs remain unverified.");

    const norm: Partial<Record<MetadataField, string[]>> = {};
    for (const field of METADATA_FIELDS) {
      const original = input[field].slice(0, MAX_METADATA_VALUES);
      if (original.length) stats.fields_present += 1;
      const values = field === "canonical" ? canonicalTargets
        : field === "og:url" ? original.map((value) => normalizedUrl(value, pages[i]!) ?? "").filter(Boolean)
        : field === "robots" || field === "googlebot" ? original.map(normalizedRobots)
        : original.map(normalizedText);
      norm[field] = values;
      if (values.length < 2) continue;
      const distinct = new Set(values);
      if (distinct.size > 1) {
        // Complementary robots declarations (e.g. separate noindex and
        // nofollow tags) are not contradictory just because text differs.
        if ((field === "robots" || field === "googlebot") &&
            !robotsDeclarationConflict(original)) continue;
        conflicts += 1;
        stats.conflicting_fields += 1;
        add("conflicting_declaration", "warning", page, field, values.length,
          "Multiple nonidentical declarations for the same metadata field were observed in the supplied HTML; review which value is intended.", "observed");
      } else {
        duplicates += 1;
        stats.duplicate_fields += 1;
        add("duplicate_declaration", "info", page, field, values.length,
          "The same metadata field is declared repeatedly with equivalent normalized values; this may be redundant but is not necessarily an SEO error.", "observed");
      }
    }
    const allRobots = input.robots.map(robotsParts);
    const allGooglebot = input.googlebot.map(robotsParts);
    const generic = new Set(allRobots.flatMap((v) => [...v]));
    const specific = new Set(allGooglebot.flatMap((v) => [...v]));
    // Check all declarations for each agent, not just contradictions within
    // a single comma-delimited meta tag.
    const contradicts = (parts: Set<string>) =>
      (parts.has("index") && parts.has("noindex")) ||
      (parts.has("follow") && parts.has("nofollow"));
    const contradictions = contradicts(generic) || contradicts(specific);
    // Generic directives can apply to Googlebot, but a more restrictive
    // directive or agent-specific instruction may intentionally override.
    const crossAgent = (generic.has("index") && specific.has("noindex")) ||
      (generic.has("noindex") && specific.has("index")) ||
      (generic.has("follow") && specific.has("nofollow")) ||
      (generic.has("nofollow") && specific.has("follow"));
    if (contradictions || crossAgent) {
      robotsConflicts += 1;
      add("conflicting_robots_directives", "info", page, "robots", 1,
        "Potentially incompatible explicit robots directives were found; agent specificity and most-restrictive behavior need review.");
    }
    function compare(fieldA: MetadataField, fieldB: MetadataField, message: string,
      code: MetadataFindingCode) {
      const left = norm[fieldA] ?? [];
      const right = norm[fieldB] ?? [];
      // Conflicting multi-valued metadata has its own finding and does not
      // authorize selecting a first value for a secondary comparison.
      if (left.length !== 1 || right.length !== 1 || !left[0] || !right[0]) return;
      if (left[0] !== right[0]) {
        crossField += 1;
        stats.cross_field_review_leads += 1;
        add(code, "info", page, fieldB, 1, message);
      }
    }
    compare("title", "og:title",
      "The title and Open Graph title differ as normalized text; social titles can intentionally differ from search titles.",
      "title_social_difference");
    compare("description", "og:description",
      "The meta description and Open Graph description differ; social and search snippets can legitimately be tailored.",
      "description_social_difference");
    compare(input["og:title"].length ? "og:title" : "title", "twitter:title",
      "The Twitter title differs from the available Open Graph or page title; social presentation can intentionally differ.",
      "title_social_difference");
    compare(input["og:description"].length ? "og:description" : "description", "twitter:description",
      "The Twitter description differs from the available Open Graph or meta description; social presentation can intentionally differ.",
      "description_social_difference");
    // An invalid second declaration does not make the remaining canonical
    // an unambiguous preference. Do not silently select a "surviving" value.
    const unambiguousCanonical = input.canonical.length === 1 && canonicalTargets.length === 1
      ? canonicalTargets[0] : undefined;
    const ogUrl = input["og:url"].length === 1 ? normalizedUrl(input["og:url"][0], pages[i]!) : undefined;
    if (unambiguousCanonical && ogUrl && unambiguousCanonical !== ogUrl) {
      crossField += 1;
      stats.cross_field_review_leads += 1;
      add("canonical_social_url_difference", "info", page, "og:url", 1,
        "The declared canonical preference and Open Graph URL point to different URLs; social URL selection and Google canonicalization are separate mechanisms.");
    }
    identities.push(unambiguousCanonical ?? pages[i]!);
    if (sample.extraction_limited || input.canonical.length > MAX_METADATA_VALUES) {
      extractionLimited = true;
      add("truncated_metadata_sample", "info", page, "title", 1,
        "The static metadata declaration sample reached an extraction cap; further values are unverified.");
    }
    pageSummaries.push(stats);
  }

  function duplicatesAcross(field: "title" | "description", code: MetadataFindingCode): number {
    const groups = new Map<string, number[]>();
    for (const [i, sample] of observations.entries()) {
      const raw = sample.values[field];
      if (raw.length !== 1) continue;
      const value = normalizedText(raw[0]);
      if (!value) continue;
      const pages = groups.get(value) ?? [];
      pages.push(i);
      groups.set(value, pages);
    }
    let count = 0;
    for (const group of groups.values()) {
      if (group.length < 2 || new Set(group.map((index) => identities[index])).size < 2) continue;
      count += 1;
      add(code, "info", group[0] + 1, field, group.length,
        "Different sampled pages with distinct declared canonical preferences or URL labels share equivalent metadata text; this can be intentional for variants and is only a review lead.",
        "review", group.slice(1).map((value) => value + 1));
    }
    return count;
  }
  const duplicateTitleGroups = duplicatesAcross("title", "duplicate_title_across_pages");
  const duplicateDescriptionGroups = duplicatesAcross("description", "duplicate_description_across_pages");
  const rank = { warning: 0, info: 1 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] ||
    a.source_page - b.source_page || a.code.localeCompare(b.code) || a.field.localeCompare(b.field));
  return {
    scope: "caller_supplied_same_origin_metadata_only",
    pages_sampled: observations.length,
    origin,
    duplicate_declaration_fields: duplicates,
    conflicting_declaration_fields: conflicts,
    unresolved_canonical_references: unresolved,
    explicit_robots_conflicts: robotsConflicts,
    cross_field_review_leads: crossField,
    duplicate_title_groups: duplicateTitleGroups,
    duplicate_description_groups: duplicateDescriptionGroups,
    excluded_annotated_canonicals: excluded,
    pages: pageSummaries,
    coverage_limited: true,
    limitations: [
      "Only caller-supplied same-origin static HTML metadata was compared; no web requests, redirects, HTTP headers, rendered content, Google-selected canonicals, search results, or indexing data were inspected.",
      "Conflicting declarations are on-page evidence; differences between search and social metadata, repeated titles/descriptions, and robots hints are contextual review leads, not automatic SEO violations.",
      "Canonical preferences are hints, not verified selected canonicals. Canonical chains/cycles and live indexability remain the existing independent graph/status tools' responsibility.",
      ...(extractionLimited || excluded
        ? ["Some declarations were excluded or capped, including annotated canonicals; omitted metadata is unverified."] : []),
    ],
    total_findings: findings.length,
    findings: findings.slice(0, MAX_METADATA_FINDINGS),
    findings_truncated: findings.length > MAX_METADATA_FINDINGS,
  };
}
