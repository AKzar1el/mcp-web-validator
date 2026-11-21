/**
 * P1-14: bounded offline URL-variant comparison from caller-observed HTTP
 * responses. Intentionally no network, HTML parsing, DNS, Google or Node APIs.
 *
 * Scheme, apex/www, one trailing slash, ASCII path case, and query differences
 * are candidate review dimensions—not assertions of content equivalence.
 */
export const MAX_VARIANT_OBSERVATIONS = 12;
export const MAX_VARIANT_FINDINGS = 12;
export const MAX_VARIANT_URL_BYTES = 1_024;
export const MAX_VARIANT_CANONICALS = 3;
export const MAX_VARIANT_TOTAL_BYTES = 28_000;

export const VARIANT_DIMENSIONS = [
  "scheme", "www", "slash", "case", "query",
] as const;
export type VariantDimension = typeof VARIANT_DIMENSIONS[number];

export const VARIANT_RESPONSE_STATES = [
  "ok", "other_success", "redirect", "not_modified", "other",
] as const;
export type VariantResponseState = typeof VARIANT_RESPONSE_STATES[number];
export const VARIANT_TARGET_STATES = [
  "absent", "to_reference", "to_sampled_variant",
  "to_unobserved_family", "external", "unresolved",
] as const;
export type VariantTargetState = typeof VARIANT_TARGET_STATES[number];
export const VARIANT_CANONICAL_STATES = [
  "absent", "self", "to_reference", "to_sampled_variant",
  "to_unobserved_family", "external", "unresolved", "conflicting",
] as const;
export type VariantCanonicalState = typeof VARIANT_CANONICAL_STATES[number];
export const VARIANT_FINDING_CODES = [
  "reference_not_ok", "variant_ok_without_redirect",
  "matching_content_at_variant", "different_content_at_variant",
  "content_unverified", "query_semantics_unverified",
  "redirect_to_other_variant", "redirect_outside_family",
  "redirect_unresolved", "canonical_conflicting_on_page",
  "canonical_outside_family", "canonical_unresolved",
  "self_canonical_on_matching_variant", "canonical_disagrees_with_reference",
  "reference_observation_only", "partial_or_other_success",
  "non_success_variant",
] as const;
export type VariantFindingCode = typeof VARIANT_FINDING_CODES[number];

export interface UrlVariantObservation {
  url: string;
  status_code: number;
  method?: "GET" | "HEAD";
  location?: string;
  canonicals?: string[];
  content_sha256?: string;
}
export interface UrlVariantPageEvidence {
  page: number;
  is_reference: boolean;
  dimensions: VariantDimension[];
  status_code: number;
  method: "GET" | "HEAD" | "unspecified";
  response_state: VariantResponseState;
  redirect_state: VariantTargetState;
  redirect_to_https: boolean;
  canonical_state: VariantCanonicalState;
  canonical_declarations: number;
  fingerprint_supplied: boolean;
  content_matches_reference: boolean | null;
  has_query: boolean;
}
export interface UrlVariantFinding {
  page: number;
  severity: "warning" | "info";
  code: VariantFindingCode;
  message: string;
}
export interface UrlVariantReview {
  scope: "caller_supplied_url_variant_evidence_only";
  pages_sampled: number;
  reference_observed: boolean;
  reference_http_200: boolean;
  scheme_variants: number;
  www_variants: number;
  slash_variants: number;
  case_variants: number;
  query_variants: number;
  http_200_variants: number;
  redirects_to_reference: number;
  redirects_outside_family: number;
  unresolved_redirects: number;
  canonical_to_reference: number;
  conflicting_canonical_pages: number;
  matching_content_variants: number;
  different_content_variants: number;
  content_not_comparable_variants: number;
  coverage_limited: true;
  limitations: string[];
  pages: UrlVariantPageEvidence[];
  total_findings: number;
  findings: UrlVariantFinding[];
  findings_truncated: boolean;
  error?: string;
}

export function emptyUrlVariantReview(): UrlVariantReview {
  return {
    scope: "caller_supplied_url_variant_evidence_only",
    pages_sampled: 0, reference_observed: false, reference_http_200: false,
    scheme_variants: 0, www_variants: 0, slash_variants: 0,
    case_variants: 0, query_variants: 0, http_200_variants: 0,
    redirects_to_reference: 0, redirects_outside_family: 0,
    unresolved_redirects: 0, canonical_to_reference: 0,
    conflicting_canonical_pages: 0, matching_content_variants: 0,
    different_content_variants: 0, content_not_comparable_variants: 0,
    coverage_limited: true,
    limitations: ["The supplied URL variant response observations could not be compared within declared limits."],
    pages: [], total_findings: 0, findings: [], findings_truncated: false,
  };
}

const encoder = new TextEncoder();
function bytes(value: string): number {
  if (typeof value !== "string") throw new Error("Unsupported string input");
  return encoder.encode(value).byteLength;
}
function safeField(value: string): number {
  if (typeof value !== "string" || !value || bytes(value) > MAX_VARIANT_URL_BYTES ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error("Invalid or oversized URL variant evidence");
  }
  return bytes(value);
}

function suspiciousPath(value: string, allowRelativeSegments = false): boolean {
  const beforeQuery = value.split("?")[0];
  const path = beforeQuery.replace(/^https?:\/\/[^/]+/iu, "");
  return /\\/u.test(value) ||
    /%(?:2f|5c|2e)/iu.test(path) ||
    (!allowRelativeSegments && /(?:^|\/)\.{1,2}(?=\/|$)/u.test(path));
}

/**
 * Safe *label*: never permission to fetch. Optional query is allowed here
 * solely to distinguish query-bearing URLs; original values are never echoed.
 */
export function safeVariantLabel(value: string): string | null {
  try {
    if (!/^https?:\/\//iu.test(value) || safeField(value) < 1 || value.includes("#") ||
      suspiciousPath(value)) return null;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseTarget(raw: string, base: string): URL | null {
  try {
    safeField(raw);
    // A *response* Location or canonical may be legitimately relative (../x).
    // Resolve it against that response URL; never apply this flexibility to
    // the sample's own absolute URL labels.
    if (raw.includes("#") || /\\/u.test(raw) || suspiciousPath(raw, true)) return null;
    const target = new URL(raw, base);
    if (!["http:", "https:"].includes(target.protocol) || !target.hostname ||
      target.username || target.password || target.port || target.hash) return null;
    return target;
  } catch {
    return null;
  }
}

function slashless(pathname: string): string {
  return pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
function asciiLower(pathname: string): string {
  return pathname.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}
function pathCandidate(a: URL, b: URL): boolean {
  // Not equality: server paths (including case and slash) may behave differently.
  return asciiLower(slashless(a.pathname)) === asciiLower(slashless(b.pathname));
}
function equivalentHostFamily(hostA: string, hostB: string): boolean {
  if (hostA === hostB) return true;
  const bareA = hostA.startsWith("www.") ? hostA.slice(4) : hostA;
  const bareB = hostB.startsWith("www.") ? hostB.slice(4) : hostB;
  return bareA === bareB && !bareA.startsWith("www.");
}
function facets(candidate: URL, reference: URL, hasQuery: boolean): VariantDimension[] {
  const out: VariantDimension[] = [];
  if (candidate.protocol !== reference.protocol) out.push("scheme");
  if (candidate.hostname !== reference.hostname) out.push("www");
  if (candidate.pathname !== reference.pathname &&
    candidate.pathname.endsWith("/") !== reference.pathname.endsWith("/")) out.push("slash");
  if (slashless(candidate.pathname) !== slashless(reference.pathname)) out.push("case");
  if (hasQuery) out.push("query");
  return out;
}

function responseState(status: number): VariantResponseState {
  if (status === 200) return "ok";
  if ([301, 302, 303, 307, 308].includes(status)) return "redirect";
  if (status === 304) return "not_modified";
  if (status >= 200 && status <= 299) return "other_success";
  return "other";
}

function targetState(
  target: URL | null, reference: URL, sampled: Set<string>, family: (url: URL) => boolean,
): VariantTargetState {
  if (!target) return "unresolved";
  if (target.href === reference.href) return "to_reference";
  if (sampled.has(target.href)) return "to_sampled_variant";
  if (family(target)) return "to_unobserved_family";
  return "external";
}

function canonicalState(
  declared: string[] | undefined, current: URL, reference: URL,
  sampled: Set<string>, family: (url: URL) => boolean,
): { state: VariantCanonicalState; count: number; targetKey?: string } {
  if (!declared?.length) return { state: "absent", count: 0 };
  const parsed = declared.map((raw) => parseTarget(raw, current.href));
  if (parsed.some((url) => url === null)) {
    return { state: "unresolved", count: declared.length };
  }
  const urls = parsed as URL[];
  const unique = new Set(urls.map((url) => url.href));
  if (unique.size !== 1) return { state: "conflicting", count: declared.length };
  const target = urls[0];
  if (target.href === current.href) return { state: "self", count: declared.length, targetKey: target.href };
  return {
    state: targetState(target, reference, sampled, family),
    count: declared.length,
    targetKey: target.href,
  };
}

/** Pure analysis of explicitly supplied observations; does not fetch URLs. */
export function analyzeUrlVariants(
  referenceUrl: string, observations: UrlVariantObservation[],
): UrlVariantReview {
  const referenceLabel = safeVariantLabel(referenceUrl);
  if (!referenceLabel || referenceUrl.includes("?")) {
    throw new Error("Reference must be a safe query-free absolute HTTP(S) URL label");
  }
  if (!Array.isArray(observations) || observations.length < 1 ||
    observations.length > MAX_VARIANT_OBSERVATIONS) {
    throw new Error("One to twelve observed URL variants are required");
  }
  const reference = new URL(referenceLabel);
  const family = (url: URL) => equivalentHostFamily(url.hostname, reference.hostname) &&
    pathCandidate(url, reference);
  let totalBytes = bytes(referenceUrl);
  const seen = new Set<string>();
  const validated: Array<{ observation: UrlVariantObservation; url: URL; hasQuery: boolean }> = [];
  for (const item of observations) {
    if (!item || typeof item !== "object") throw new Error("Invalid observed variant record");
    const label = safeVariantLabel(item.url);
    if (!label) throw new Error("URL variant label is unsafe");
    const url = new URL(label);
    if (!family(url) || seen.has(label)) {
      throw new Error("Observations must be distinct same-family URL variants of one reference path");
    }
    if (!Number.isSafeInteger(item.status_code) || item.status_code < 100 || item.status_code > 599 ||
      (item.method !== undefined && !["GET", "HEAD"].includes(item.method))) {
      throw new Error("Invalid observed HTTP status/method");
    }
    totalBytes += bytes(item.url);
    if (item.location !== undefined) totalBytes += safeField(item.location);
    if (item.canonicals !== undefined) {
      if (!Array.isArray(item.canonicals) || item.canonicals.length > MAX_VARIANT_CANONICALS) {
        throw new Error("Too many canonical declarations");
      }
      for (const canonical of item.canonicals) totalBytes += safeField(canonical);
    }
    if (item.content_sha256 !== undefined) {
      if (typeof item.content_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/iu.test(item.content_sha256) ||
        item.status_code !== 200 || item.method === "HEAD") {
        throw new Error("A SHA-256 body fingerprint requires an observed 200 response with a body");
      }
      totalBytes += bytes(item.content_sha256);
    }
    if (totalBytes > MAX_VARIANT_TOTAL_BYTES) {
      throw new Error("Supplied URL variant observations exceed the aggregate size cap");
    }
    seen.add(label);
    validated.push({ observation: item, url, hasQuery: item.url.includes("?") });
  }
  const ref = validated.find((record) => record.url.href === reference.href);
  if (!ref) throw new Error("The exact reference URL must be included among observations");
  const referenceDigest = ref.observation.status_code === 200
    ? ref.observation.content_sha256?.toLowerCase() : undefined;

  const result = emptyUrlVariantReview();
  result.pages_sampled = validated.length;
  result.reference_observed = true;
  result.reference_http_200 = ref.observation.status_code === 200;
  result.limitations = [
    "Only caller-supplied response status, Location and canonical declarations were compared; no HTTP request, redirect chain, rendered HTML, robots/sitemap, server configuration or Google-selected canonical was checked.",
    "The reference URL and same-path scheme/www/slash/ASCII-case/query changes are only candidate variants; path case and query parameters can legitimately identify distinct content. Hostnames prefixed with www are not assumed to share a server.",
    "Optional SHA-256 fingerprints are unverified caller-provided exact-body digests (HTTP 200 only); a hash match indicates byte identity only, not indexing, canonicalization, SEO duplication or page equivalence beyond the observed sample.",
    "At most twelve unique observations and twelve fixed findings are returned. Unobserved variants, cross-origin redirects, actual response bodies and URL query contents are not inferred, fetched or echoed.",
  ];
  const findings: UrlVariantFinding[] = [];
  const canonicalKeys: Array<{ page: number; target: string; matching: boolean }> = [];
  const add = (page: number, code: VariantFindingCode,
    severity: "warning" | "info", message: string) => {
    findings.push({ page, code, severity, message });
  };

  validated.forEach((record, index) => {
    const page = index + 1;
    const observed = record.observation;
    const isReference = record.url.href === reference.href;
    const dimensions = isReference ? [] : facets(record.url, reference, record.hasQuery);
    const state = responseState(observed.status_code);
    const redirectTarget = state === "redirect" && observed.location !== undefined
      ? parseTarget(observed.location, record.url.href) : null;
    const redirectState: VariantTargetState = state !== "redirect" ? "absent" :
      targetState(redirectTarget, reference, seen, family);
    const canonical = canonicalState(observed.canonicals, record.url, reference, seen, family);
    const fingerprintSupplied = observed.content_sha256 !== undefined;
    const comparable = !isReference && observed.status_code === 200 &&
      referenceDigest !== undefined && fingerprintSupplied;
    const match: boolean | null = comparable
      ? referenceDigest === observed.content_sha256?.toLowerCase() : null;
    const evidence: UrlVariantPageEvidence = {
      page, is_reference: isReference, dimensions, status_code: observed.status_code,
      method: observed.method ?? "unspecified", response_state: state,
      redirect_state: redirectState,
      redirect_to_https: Boolean(redirectTarget && redirectTarget.protocol === "https:" &&
        record.url.protocol === "http:"),
      canonical_state: canonical.state, canonical_declarations: canonical.count,
      fingerprint_supplied: fingerprintSupplied,
      content_matches_reference: match,
      has_query: record.hasQuery,
    };
    result.pages.push(evidence);
    for (const dimension of dimensions) {
      if (dimension === "scheme") result.scheme_variants++;
      if (dimension === "www") result.www_variants++;
      if (dimension === "slash") result.slash_variants++;
      if (dimension === "case") result.case_variants++;
      if (dimension === "query") result.query_variants++;
    }
    if (isReference && state !== "ok") {
      add(page, "reference_not_ok", "warning",
        "The supplied reference URL did not return a complete HTTP 200; variant body comparison may be unavailable.");
    }
    if (dimensions.includes("query")) {
      add(page, "query_semantics_unverified", "info",
        "Query parameters may change page content; the sample does not establish that query and query-free URLs are equivalent.");
    }
    if (!isReference && state === "ok") {
      result.http_200_variants++;
      add(page, "variant_ok_without_redirect", "info",
        "This candidate URL variant returned a supplied HTTP 200 rather than a redirect; that alone is not an SEO defect.");
      if (match === true) {
        result.matching_content_variants++;
        add(page, "matching_content_at_variant", "warning",
          "The variant and supplied reference have identical caller-reported SHA-256 bodies and both returned HTTP 200; review duplicate URL consolidation.");
      } else if (match === false) {
        result.different_content_variants++;
        add(page, "different_content_at_variant", "info",
          "The variant and reference body digests differ; case-sensitive paths or query variants may intentionally serve different content.");
      } else {
        result.content_not_comparable_variants++;
        add(page, "content_unverified", "info",
          "No comparable pair of HTTP 200 body fingerprints was supplied; duplicate content cannot be inferred.");
      }
    } else if (!isReference && state === "other_success") {
      add(page, "partial_or_other_success", "info",
        "The candidate variant returned a non-200 success response; full body equivalence was not established.");
    } else if (!isReference && state === "other") {
      add(page, "non_success_variant", "info",
        "The supplied variant response was not a full 200 or recognized redirect; check its status semantics.");
    }
    if (redirectState === "to_reference") result.redirects_to_reference++;
    if (redirectState === "external") {
      result.redirects_outside_family++;
      add(page, "redirect_outside_family", "warning",
        "The supplied one-step Location redirects outside the reference family; intent and final destination remain unverified.");
    } else if (redirectState === "to_sampled_variant" ||
      redirectState === "to_unobserved_family") {
      add(page, "redirect_to_other_variant", "info",
        "The one-step Location points to a different family variant, not directly to the chosen reference; redirects were not followed.");
    } else if (redirectState === "unresolved") {
      result.unresolved_redirects++;
      add(page, "redirect_unresolved", "warning",
        "The supplied redirect lacks a valid safely resolvable HTTP(S) Location; no destination was verified.");
    }
    if (canonical.state === "to_reference") result.canonical_to_reference++;
    if (canonical.state === "conflicting") {
      result.conflicting_canonical_pages++;
      add(page, "canonical_conflicting_on_page", "warning",
        "The same sampled response declared multiple distinct canonical targets; a single preferred declaration could not be determined.");
    } else if (canonical.state === "external") {
      add(page, "canonical_outside_family", "info",
        "A canonical declaration points outside the reference variant family; this may be intentional but requires review.");
    } else if (canonical.state === "unresolved") {
      add(page, "canonical_unresolved", "info",
        "A canonical target was invalid, credential-bearing or otherwise unresolved; the original declaration is not returned.");
    }
    if (!isReference && match === true && canonical.state === "self") {
      add(page, "self_canonical_on_matching_variant", "warning",
        "A byte-identical HTTP 200 variant declares itself canonical rather than the supplied reference; review canonical consistency.");
    }
    if (canonical.targetKey && state === "ok") {
      canonicalKeys.push({
        page, target: canonical.targetKey,
        matching: isReference ? Boolean(referenceDigest) : match === true,
      });
    }
  });
  if (referenceDigest) {
    const group = canonicalKeys.filter((item) => item.matching);
    const distinct = new Set(group.map((item) => item.target));
    if (distinct.size > 1) {
      add(group[0].page, "canonical_disagrees_with_reference", "warning",
        "Byte-identical sampled HTTP 200 pages declare different canonical targets; consolidate or verify intentional signals.");
    }
  }
  if (validated.length === 1) {
    add(1, "reference_observation_only", "info",
      "Only the reference URL was observed; no HTTP, www, slash, case or query variants were tested.");
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 :
    a.severity === "warning" ? -1 : 1) || a.page - b.page || a.code.localeCompare(b.code));
  result.total_findings = findings.length;
  result.findings = findings.slice(0, MAX_VARIANT_FINDINGS);
  result.findings_truncated = findings.length > MAX_VARIANT_FINDINGS;
  return result;
}
