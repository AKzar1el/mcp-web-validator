/**
 * P1-05 citation / dataset / freshness / methodology consistency.
 *
 * Pure comparisons of supplied static HTML observations and caller-supplied
 * evidence. Nothing here fetches a citation, validates scientific claims,
 * measures search ranking or treats an incomplete manifest as exhaustive.
 */
export const MAX_PROVENANCE_PAGES = 8;
export const MAX_PROVENANCE_SOURCES = 24;
export const MAX_PROVENANCE_DATASETS = 16;
export const MAX_PROVENANCE_METHODS = 16;
export const MAX_PROVENANCE_FINDINGS = 12;
export const MAX_PROVENANCE_HTML_BYTES = 200_000;
export const MAX_PROVENANCE_INPUT_BYTES = 1_000_000;
export const MAX_PROVENANCE_DECLARATIONS = 48;

export interface ReferenceEvidence {
  id: string;
  url: string;
}
export interface DatasetEvidence {
  id: string;
  version?: string;
  as_of?: string;
  max_age_days?: number;
  methodology_id?: string;
}
export interface MethodologyEvidence {
  id: string;
  url: string;
}
export interface ProvenanceManifest {
  /** The caller's reference date, not an independently checked wall clock. */
  as_of?: string;
  sources?: ReferenceEvidence[];
  datasets?: DatasetEvidence[];
  methodologies?: MethodologyEvidence[];
}
export interface CitationDeclaration {
  id?: string;
  url?: string;
}
export interface DatasetDeclaration {
  id?: string;
  version?: string;
  as_of?: string;
  methodology_id?: string;
}
export interface MethodologyDeclaration {
  id?: string;
  url?: string;
}
export interface ProvenanceObservation {
  url: string;
  citations: CitationDeclaration[];
  datasets: DatasetDeclaration[];
  methodologies: MethodologyDeclaration[];
  published_dates: string[];
  modified_dates: string[];
  invalid_dates: number;
  declarations_truncated: boolean;
  eligible: boolean;
}

export type ProvenanceCode =
  | "citation_id_target_conflict"
  | "citation_target_differs_from_supplied_evidence"
  | "citation_reference_unverified"
  | "dataset_version_conflict"
  | "dataset_as_of_conflict"
  | "dataset_reference_unverified"
  | "dataset_snapshot_in_future"
  | "dataset_freshness_window_exceeded"
  | "methodology_link_conflict"
  | "methodology_id_conflict"
  | "methodology_reference_unverified"
  | "invalid_date_declarations"
  | "published_dates_inconsistent"
  | "modified_dates_inconsistent"
  | "modified_before_published"
  | "publication_after_reference_date";

export interface ProvenanceFinding {
  code: ProvenanceCode;
  severity: "warning" | "info";
  evidence: "observed_html" | "supplied_manifest" | "reference_date";
  page_url: string;
  reference_id?: string;
  message: string;
}
export interface ProvenanceResult {
  scope: "supplied_static_html_and_evidence";
  pages_sampled: number;
  pages_eligible: number;
  citations_observed: number;
  datasets_observed: number;
  methodologies_observed: number;
  checked_declarations: number;
  consistent_declarations: number;
  conflicting_declarations: number;
  unverified_declarations: number;
  invalid_date_declarations: number;
  evidence_supplied: boolean;
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: ProvenanceFinding[];
  findings_truncated: boolean;
}

/** Strict safe labels for references, no query, fragment or credential leakage. */
export function safeProvenanceUrl(raw: string): string | undefined {
  if (!raw || raw.length > 512) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username ||
      url.password || url.search || url.hash || url.port || !url.hostname) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function safeProvenanceId(raw: string): string | undefined {
  return raw.length <= 64 && /^[a-zA-Z][a-zA-Z0-9._:-]*$/.test(raw) ? raw : undefined;
}
export function safeDatasetVersion(raw: string): string | undefined {
  return raw.length <= 64 && /^[a-zA-Z0-9][a-zA-Z0-9 ._+-]*$/.test(raw) ? raw : undefined;
}

/**
 * Calendar-valid YYYY-MM-DD or a timezone-qualified ISO timestamp. Dates from
 * timestamps are compared by UTC day to avoid local machine timezone drift.
 */
export function normalizedEvidenceDate(raw: string): string | undefined {
  if (raw.length > 48) return undefined;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    const timestamp = new Date(Date.UTC(year, month - 1, date));
    // Date.UTC treats years 00-99 specially. Use explicit full UTC year.
    timestamp.setUTCFullYear(year);
    if (timestamp.getUTCFullYear() !== year ||
      timestamp.getUTCMonth() + 1 !== month || timestamp.getUTCDate() !== date) return undefined;
    return day[0];
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return undefined;
  }
  // Reject impossible calendar days and time/offset fields, not Date.parse's
  // permissive overflow normalization.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw)!;
  if (!normalizedEvidenceDate(match.slice(1, 4).join("-")) ||
    Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return undefined;
  const zone = raw.endsWith("Z") ? undefined : /([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (zone && (Number(zone[2]) > 23 || Number(zone[3]) > 59)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined;
}

function uniqueDateValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => normalizedEvidenceDate(value) !== undefined)
    .map((value) => normalizedEvidenceDate(value)!))].sort();
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") -
    Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/**
 * Supports incomplete evidence. An unknown identifier remains unverified;
 * disagreement against an explicitly supplied entry is a disagreement with
 * that entry, not proof that the underlying publication is untruthful.
 */
export function analyzeProvenance(
  observations: readonly ProvenanceObservation[],
  manifest: ProvenanceManifest = {},
  options: { sampledPages?: number; coverageLimited?: boolean } = {},
): ProvenanceResult {
  if (observations.length > MAX_PROVENANCE_PAGES) {
    throw new Error("Provenance comparison accepts at most eight page observations.");
  }
  const pagesSampled = options.sampledPages ?? observations.length;
  if (!Number.isSafeInteger(pagesSampled) ||
    pagesSampled < observations.length || pagesSampled > MAX_PROVENANCE_PAGES) {
    throw new Error("sampledPages must be between observed pages and eight.");
  }
  if ((manifest.sources?.length ?? 0) > MAX_PROVENANCE_SOURCES ||
    (manifest.datasets?.length ?? 0) > MAX_PROVENANCE_DATASETS ||
    (manifest.methodologies?.length ?? 0) > MAX_PROVENANCE_METHODS) {
    throw new Error("Supplied evidence exceeds the bounded manifest limits.");
  }
  for (const [kind, entries] of [
    ["sources", manifest.sources ?? []],
    ["datasets", manifest.datasets ?? []],
    ["methodologies", manifest.methodologies ?? []],
  ] as const) {
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Duplicate " + kind + " IDs make the supplied evidence ambiguous.");
    }
  }
  const referenceDate = manifest.as_of ? normalizedEvidenceDate(manifest.as_of) : undefined;
  if (manifest.as_of && !referenceDate) throw new Error("Manifest as_of must be a valid date.");
  for (const ds of manifest.datasets ?? []) {
    if (ds.as_of && !normalizedEvidenceDate(ds.as_of)) {
      throw new Error("Dataset evidence as_of must be a valid date.");
    }
  }
  const sources = new Map((manifest.sources ?? []).map((value) => [value.id, value]));
  const datasets = new Map((manifest.datasets ?? []).map((value) => [value.id, value]));
  const methods = new Map((manifest.methodologies ?? []).map((value) => [value.id, value]));
  const provided = sources.size + datasets.size + methods.size > 0;
  const findings: ProvenanceFinding[] = [];
  let seenCount = 0;
  let checked = 0;
  let consistent = 0;
  let conflicts = 0;
  let unverified = 0;
  let citationTotal = 0;
  let datasetTotal = 0;
  let methodTotal = 0;
  let badDates = 0;
  const eligible = new Map<string, ProvenanceObservation>();
  for (const item of observations) {
    const url = safeProvenanceUrl(item.url);
    if (url && item.eligible && !eligible.has(url)) eligible.set(url, item);
  }
  function report(code: ProvenanceCode, severity: ProvenanceFinding["severity"],
    evidence: ProvenanceFinding["evidence"], page: string, message: string,
    ref?: string) {
    const finding: ProvenanceFinding = {
      code, severity, evidence, page_url: page,
      ...(ref && safeProvenanceId(ref) ? { reference_id: ref } : {}),
      message,
    };
    findings.push(finding);
  }
  // One id intentionally pointing to two sanitized URLs is directly
  // inconsistent even when the optional manifest is absent.
  const observedSourceTargets = new Map<string, string>();
  for (const [pageUrl, page] of eligible) {
    seenCount += 1;
    citationTotal += page.citations.length;
    datasetTotal += page.datasets.length;
    methodTotal += page.methodologies.length;
    badDates += page.invalid_dates;
    if (page.invalid_dates) {
      checked += page.invalid_dates;
      conflicts += page.invalid_dates;
      report("invalid_date_declarations", "warning", "observed_html", pageUrl,
        "One or more explicit publication, modification or dataset date declarations are not valid ISO calendar dates.");
    }
    if (page.declarations_truncated) {
      unverified += 1;
    }
    const published = uniqueDateValues(page.published_dates);
    const modified = uniqueDateValues(page.modified_dates);
    if (published.length > 1) {
      checked += 1;
      conflicts += 1;
      report("published_dates_inconsistent", "warning", "observed_html", pageUrl,
        "This page declares different publication dates in its explicit structured signals.");
    }
    if (modified.length > 1) {
      checked += 1;
      conflicts += 1;
      report("modified_dates_inconsistent", "warning", "observed_html", pageUrl,
        "This page declares different modification dates in its explicit structured signals.");
    }
    if (published.length === 1 && modified.length === 1) {
      checked += 1;
      if (modified[0] < published[0]) {
        conflicts += 1;
        report("modified_before_published", "warning", "observed_html", pageUrl,
          "The declared modification date precedes the publication date.");
      } else consistent += 1;
    }
    if (referenceDate) {
      for (const date of [...published, ...modified]) {
        checked += 1;
        if (date > referenceDate) {
          conflicts += 1;
          report("publication_after_reference_date", "warning", "reference_date", pageUrl,
            "An explicit publication or modification date is later than the caller-supplied reference day.");
        } else consistent += 1;
      }
    }
    for (const cite of page.citations) {
      const id = cite.id && safeProvenanceId(cite.id);
      const target = cite.url && safeProvenanceUrl(cite.url);
      const source = id && sources.get(id);
      if (id && target) {
        const previous = observedSourceTargets.get(id);
        if (previous && previous !== target) {
          checked += 1;
          conflicts += 1;
          report("citation_id_target_conflict", "warning", "observed_html", pageUrl,
            "The same citation ID is assigned different safe target URLs in the compared page sample.", id);
        } else if (!previous) observedSourceTargets.set(id, target);
      }
      checked += 1;
      if (source && target) {
        const declared = safeProvenanceUrl(source.url);
        if (declared && target === declared) consistent += 1;
        else if (declared) {
          conflicts += 1;
          report("citation_target_differs_from_supplied_evidence", "warning",
            "supplied_manifest", pageUrl, "The citation target differs from the URL for this ID in the supplied evidence.", id);
        } else {
          unverified += 1;
          report("citation_reference_unverified", "info", "supplied_manifest", pageUrl,
            "The supplied source URL cannot be compared safely.", id);
        }
      } else if (target && !id && [...sources.values()].some((item) => safeProvenanceUrl(item.url) === target)) {
        consistent += 1;
      } else {
        unverified += 1;
        report("citation_reference_unverified", "info", "supplied_manifest", pageUrl,
          "This citation has no matching safe target or entry in the optional supplied source evidence.", id || undefined);
      }
    }
    for (const claim of page.datasets) {
      const id = claim.id && safeProvenanceId(claim.id);
      const evidence = id ? datasets.get(id) : undefined;
      if (!id || !evidence) {
        checked += 1;
        unverified += 1;
        report("dataset_reference_unverified", "info", "supplied_manifest", pageUrl,
          "This dataset claim has no matching identifier in the optional supplied dataset evidence.", id || undefined);
        continue;
      }
      if (claim.version) {
        checked += 1;
        if (!evidence.version) unverified += 1;
        else if (evidence.version === claim.version) consistent += 1;
        else {
          conflicts += 1;
          report("dataset_version_conflict", "warning", "supplied_manifest", pageUrl,
            "The claimed dataset version differs from the version supplied for the same dataset ID.", id);
        }
      }
      if (claim.as_of) {
        checked += 1;
        const observed = normalizedEvidenceDate(claim.as_of);
        const declared = evidence.as_of && normalizedEvidenceDate(evidence.as_of);
        if (!observed) {
          // Already counted as an invalid date by the extractor.
          unverified += 1;
        } else if (declared) {
          if (observed === declared) consistent += 1;
          else {
            conflicts += 1;
            report("dataset_as_of_conflict", "warning", "supplied_manifest", pageUrl,
              "The claimed dataset snapshot day differs from the supplied snapshot day for that ID.", id);
          }
        } else unverified += 1;
        if (observed && referenceDate) {
          checked += 1;
          if (observed > referenceDate) {
            conflicts += 1;
            report("dataset_snapshot_in_future", "warning", "reference_date", pageUrl,
              "The claimed snapshot date is later than the caller-supplied reference day.", id);
          } else consistent += 1;
          if (evidence.max_age_days !== undefined && observed <= referenceDate) {
            checked += 1;
            if (daysBetween(observed, referenceDate) > evidence.max_age_days) {
              conflicts += 1;
              report("dataset_freshness_window_exceeded", "warning", "supplied_manifest", pageUrl,
                "The snapshot age exceeds the explicitly supplied freshness window; review whether a newer release exists.", id);
            } else consistent += 1;
          }
        }
      }
      if (claim.methodology_id) {
        checked += 1;
        if (!evidence.methodology_id) unverified += 1;
        else if (evidence.methodology_id === claim.methodology_id) consistent += 1;
        else {
          conflicts += 1;
          report("methodology_id_conflict", "warning", "supplied_manifest", pageUrl,
            "The claimed methodology ID differs from the methodology ID supplied for this dataset.", id);
        }
      }
      if (!claim.version && !claim.as_of && !claim.methodology_id) {
        checked += 1;
        unverified += 1;
      }
    }
    for (const method of page.methodologies) {
      const id = method.id && safeProvenanceId(method.id);
      const supplied = id ? methods.get(id) : undefined;
      checked += 1;
      if (supplied && method.url) {
        const actual = safeProvenanceUrl(method.url);
        const expected = safeProvenanceUrl(supplied.url);
        if (actual && expected) {
          if (actual === expected) consistent += 1;
          else {
            conflicts += 1;
            report("methodology_link_conflict", "warning", "supplied_manifest", pageUrl,
              "The methodology URL differs from the URL supplied for this methodology ID.", id);
          }
        } else unverified += 1;
      } else {
        unverified += 1;
        report("methodology_reference_unverified", "info", "supplied_manifest", pageUrl,
          "No comparable methodology URL was supplied for this explicit methodology reference.", id || undefined);
      }
    }
  }
  // Prefer observed contradictions over the potentially numerous informative
  // unresolved references. Keep deterministic ordering and true total counts.
  findings.sort((a, b) =>
    (a.severity === "warning" ? 0 : 1) - (b.severity === "warning" ? 0 : 1) ||
    a.code.localeCompare(b.code) || a.page_url.localeCompare(b.page_url) ||
    (a.reference_id ?? "").localeCompare(b.reference_id ?? ""));
  const extractionLimited = [...eligible.values()].some((page) => page.declarations_truncated);
  const incomplete = pagesSampled !== eligible.size || extractionLimited ||
    Boolean(options.coverageLimited) || !provided || unverified > 0;
  return {
    scope: "supplied_static_html_and_evidence",
    pages_sampled: pagesSampled, pages_eligible: eligible.size,
    citations_observed: citationTotal,
    datasets_observed: datasetTotal,
    methodologies_observed: methodTotal,
    checked_declarations: checked,
    consistent_declarations: consistent,
    conflicting_declarations: conflicts,
    unverified_declarations: unverified,
    invalid_date_declarations: badDates,
    evidence_supplied: provided,
    coverage_limited: incomplete,
    limitations: [
      "Only supplied static HTML and optional caller-supplied evidence are compared; source URLs, DOI resolution, factual accuracy and current datasets are not independently fetched or verified.",
      "A matched reference ID/URL verifies agreement with the supplied manifest, not authenticity, licensing, scientific correctness, freshness in the real world or Google search decisions.",
      ...(!provided ? ["No source/dataset/methodology manifest was supplied; unsupported references remain unverified."] : []),
      ...(extractionLimited || pagesSampled !== eligible.size || options.coverageLimited
        ? ["The input or extraction sample is incomplete; findings must not be interpreted as site-wide coverage."] : []),
    ],
    total_findings: findings.length,
    findings: findings.slice(0, MAX_PROVENANCE_FINDINGS),
    findings_truncated: findings.length > MAX_PROVENANCE_FINDINGS,
  };
}
