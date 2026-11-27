/**
 * P1-11: bounded, offline review of caller-observed HTTP response metadata.
 * Pure module: shared by local stdio and hosted Worker, no fetch or Node APIs.
 */
export const MAX_HTTP_RESOURCES = 8;
export const MAX_HTTP_FINDINGS = 12;
export const MAX_HTTP_HEADER_VALUES = 8;
export const MAX_HTTP_HEADER_BYTES = 2_048;
export const MAX_HTTP_TOTAL_BYTES = 30_000;
const MAX_LINK_ITEMS_PER_RESOURCE = 32;
const encoder = new TextEncoder();

export const HTTP_MIME_CATEGORIES = [
  "html", "pdf", "image", "video", "audio", "text", "data", "binary", "unknown",
] as const;
export type HttpMimeCategory = typeof HTTP_MIME_CATEGORIES[number];
export const HTTP_CANONICAL_STATES = [
  "absent", "one", "repeated", "conflicting", "unresolved",
] as const;
export type HttpCanonicalState = typeof HTTP_CANONICAL_STATES[number];
export const HTTP_FINDING_CODES = [
  "explicit_noindex", "googlebot_noindex", "conflicting_robots",
  "explicit_noimageindex",
  "unresolved_canonical", "conflicting_canonical",
  "attachment_disposition", "non_success_response",
  "partial_http_response", "unknown_content_type", "html_in_non_html_review",
  "link_header_limited", "pdf_type_mismatch",
] as const;
export type HttpFindingCode = typeof HTTP_FINDING_CODES[number];

export interface HttpResourceObservation {
  url: string;
  status_code: number;
  method?: "HEAD" | "GET";
  content_type?: string;
  content_disposition?: string;
  x_robots_tag?: string[];
  link?: string[];
}

export interface HttpDirectiveFinding {
  code: HttpFindingCode;
  severity: "warning" | "info";
  resource: number;
  message: string;
}

export interface HttpResourceEvidence {
  resource: number;
  status_code: number;
  method: "HEAD" | "GET" | "unspecified";
  mime_category: HttpMimeCategory;
  non_html: boolean;
  x_robots_observed: boolean;
  explicit_noindex: boolean;
  googlebot_noindex: boolean;
  googlebot_noimageindex: boolean;
  conflicting_robots: boolean;
  canonical_declarations: number;
  canonical_valid_targets: number;
  canonical_state: HttpCanonicalState;
  attachment_declared: boolean;
  header_coverage_limited: boolean;
}

export interface HttpDirectiveReview {
  scope: "caller_supplied_http_headers_only";
  resources_sampled: number;
  non_html_resources: number;
  html_resources: number;
  unknown_mime_resources: number;
  non_success_resources: number;
  explicit_noindex_resources: number;
  googlebot_noindex_resources: number;
  googlebot_noimageindex_resources: number;
  conflicting_robots_resources: number;
  canonical_header_resources: number;
  conflicting_canonical_resources: number;
  unresolved_canonical_references: number;
  attachment_resources: number;
  coverage_limited: true;
  limitations: string[];
  resources: HttpResourceEvidence[];
  total_findings: number;
  findings: HttpDirectiveFinding[];
  findings_truncated: boolean;
  error?: string;
}

export function emptyHttpDirectiveReview(): HttpDirectiveReview {
  return {
    scope: "caller_supplied_http_headers_only", resources_sampled: 0,
    non_html_resources: 0, html_resources: 0, unknown_mime_resources: 0,
    non_success_resources: 0, explicit_noindex_resources: 0,
    googlebot_noindex_resources: 0, conflicting_robots_resources: 0,
    googlebot_noimageindex_resources: 0,
    canonical_header_resources: 0, conflicting_canonical_resources: 0,
    unresolved_canonical_references: 0, attachment_resources: 0,
    coverage_limited: true,
    limitations: ["The supplied HTTP response observations could not be reviewed within declared limits."],
    resources: [], total_findings: 0, findings: [], findings_truncated: false,
  };
}

/** Safe *offline label*, not permission to issue a network request. */
export function safeHttpResourceUrl(value: string): string | null {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash ||
      value.includes("?") || value.includes("#") ||
      url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}

function checkHeader(value: string | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || /[\r\n\u0000]/u.test(value)) throw new Error("Invalid observed response header");
  const bytes = encoder.encode(value).byteLength;
  if (bytes > MAX_HTTP_HEADER_BYTES) throw new Error("HTTP header observation exceeds the byte cap");
  return bytes;
}

function headerList(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_HTTP_HEADER_VALUES) {
    throw new Error("Too many observed response headers");
  }
  return value;
}

function mimeCategory(header: string | undefined): HttpMimeCategory {
  const mime = (header ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!mime) return "unknown";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/pdf") return "pdf";
  if (/^image\/[a-z0-9.+-]+$/u.test(mime)) return "image";
  if (/^video\/[a-z0-9.+-]+$/u.test(mime)) return "video";
  if (/^audio\/[a-z0-9.+-]+$/u.test(mime)) return "audio";
  if (/^(application\/(?:json|xml|ld\+json|[^/]+\+(?:json|xml))|text\/(?:xml|csv))$/u.test(mime)) return "data";
  if (/^text\/[a-z0-9.+-]+$/u.test(mime)) return "text";
  if (/^(?:application|font|model)\/[a-z0-9.+-]+$/u.test(mime)) return "binary";
  return "unknown";
}

type RobotSet = {
  index: boolean; noindex: boolean; noimageindex: boolean;
  follow: boolean; nofollow: boolean;
};
const emptyRules = (): RobotSet => ({
  index: false, noindex: false, noimageindex: false, follow: false, nofollow: false,
});
const directiveKeys = new Set([
  "index", "noindex", "follow", "nofollow", "all", "none", "noarchive",
  "nosnippet", "noimageindex", "notranslate", "max-snippet", "max-image-preview",
  "max-video-preview", "unavailable_after", "indexifembedded",
]);

function parseRobotHeaders(values: string[]): {
  observed: boolean;
  noindex: boolean;
  googlebotNoindex: boolean;
  googlebotNoimageindex: boolean;
  conflict: boolean;
} {
  const generic = emptyRules(), bot = emptyRules();
  // Keep distinct crawler names separate; the empty key is the unscoped header.
  const groups = new Map<string, RobotSet>([["", generic], ["googlebot", bot]]);
  let observed = false;
  for (const header of values) {
    if (!header.trim()) continue;
    observed = true;
    let scope = "";
    for (const rawSegment of header.split(",")) {
      let token = rawSegment.trim().toLowerCase();
      const prefix = /^([a-z][a-z0-9_-]{0,39}):\s*(.*)$/u.exec(token);
      if (prefix && !directiveKeys.has(prefix[1])) {
        scope = prefix[1];
        token = prefix[2].trim();
      }
      const rule = token.split(/\s/u, 1)[0];
      let group = groups.get(scope);
      if (!group) {
        group = emptyRules();
        groups.set(scope, group);
      }
      if (rule === "noindex" || rule === "none") group.noindex = true;
      if (rule === "noimageindex") group.noimageindex = true;
      if (rule === "index" || rule === "all") group.index = true;
      if (rule === "nofollow" || rule === "none") group.nofollow = true;
      if (rule === "follow" || rule === "all") group.follow = true;
    }
  }
  const internalConflict = Array.from(groups.values()).some((rules) =>
    (rules.index && rules.noindex) || (rules.follow && rules.nofollow));
  const crossScopeConflict = (generic.index && bot.noindex) || (generic.noindex && bot.index)
    || (generic.follow && bot.nofollow) || (generic.nofollow && bot.follow);
  return {
    observed,
    noindex: generic.noindex,
    googlebotNoindex: generic.noindex || bot.noindex,
    googlebotNoimageindex: generic.noimageindex || bot.noimageindex,
    conflict: internalConflict || crossScopeConflict,
  };
}

/** Delimit a Link HTTP field outside URI angle brackets and quoted strings. */
function splitHeader(value: string, delimiter: "," | ";", protectAngles = false): string[] {
  const result: string[] = [];
  let inQuotes = false, escaped = false, inAngle = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inQuotes) { escaped = true; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && protectAngles && ch === "<") { inAngle = true; continue; }
    if (!inQuotes && protectAngles && ch === ">") { inAngle = false; continue; }
    if (ch === delimiter && !inQuotes && !inAngle) {
      result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function parseCanonicalHeaders(values: string[]): {
  total: number;
  valid: number;
  unresolved: number;
  distinct: number;
  limited: boolean;
} {
  let total = 0, valid = 0, unresolved = 0, limited = false, checkedItems = 0;
  const distinct = new Set<string>();
  for (const header of values) {
    for (const item of splitHeader(header, ",", true)) {
      if (++checkedItems > MAX_LINK_ITEMS_PER_RESOURCE) { limited = true; break; }
      const match = /^<([^>]*)>\s*(.*)$/u.exec(item);
      // Parse Link parameters, without treating commas inside quotes as separators.
      const suffix = match?.[2] ?? item;
      // After a Link URI, only semicolon-delimited parameters are valid.
      if (match && suffix && !suffix.startsWith(";")) continue;
      const params = splitHeader(suffix, ";").slice(match ? 1 : 0);
      let relation: string | undefined;
      for (const param of params) {
        const parsed = /^rel\s*=\s*(?:"((?:\\.|[^"])*)"|([^\s;]+))/iu.exec(param);
        if (parsed && relation === undefined) relation = (parsed[1] ?? parsed[2]).replace(/\\(.)/gu, "$1");
      }
      if (!relation?.toLowerCase().split(/\s+/u).includes("canonical")) continue;
      total++;
      if (!match) { unresolved++; continue; }
      try {
        const target = new URL(match[1]);
        if (!["http:", "https:"].includes(target.protocol) || !target.hostname ||
          target.username || target.password || target.hash ||
          target.port) {
          unresolved++;
          continue;
        }
        valid++;
        distinct.add(target.href);
      } catch {
        unresolved++;
      }
    }
    if (limited) break;
  }
  return { total, valid, unresolved, distinct: distinct.size, limited };
}

export function analyzeHttpDirectives(items: HttpResourceObservation[]): HttpDirectiveReview {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_HTTP_RESOURCES) {
    throw new Error("Provide between one and eight HTTP observations");
  }
  let bytes = 0, origin: string | undefined;
  const urls = new Set<string>();
  for (const item of items) {
    const safe = safeHttpResourceUrl(item.url);
    if (!safe) throw new Error("Use safe, query-free HTTP(S) resource labels");
    const url = new URL(safe);
    if (origin !== undefined && url.origin !== origin) {
      throw new Error("HTTP observations must belong to a single origin");
    }
    origin = url.origin;
    if (urls.has(safe)) throw new Error("Duplicate HTTP resource label");
    urls.add(safe);
    if (!Number.isInteger(item.status_code) || item.status_code < 100 || item.status_code > 599) {
      throw new Error("Invalid observed HTTP status");
    }
    if (item.method !== undefined && !["HEAD", "GET"].includes(item.method)) {
      throw new Error("Invalid observed HTTP method");
    }
    bytes += checkHeader(item.content_type) + checkHeader(item.content_disposition);
    for (const header of [...headerList(item.x_robots_tag), ...headerList(item.link)]) {
      bytes += checkHeader(header);
    }
    if (bytes > MAX_HTTP_TOTAL_BYTES) throw new Error("HTTP header sample exceeds the combined byte cap");
  }

  const out = emptyHttpDirectiveReview();
  out.resources_sampled = items.length;
  out.limitations = [
    "Only caller-supplied HTTP response metadata was examined; there was no HEAD/GET request, binary download, crawling, robots.txt inspection, or live Google indexing verification.",
    "HEAD response headers may differ from GET. A missing X-Robots-Tag does not prove indexability; a declared directive does not prove crawlers saw or honored it.",
    "HTTP Link rel=canonical is a declaration, not Google-selected canonical. Non-success, partial, HTML or unknown MIME responses may not represent final non-HTML documents.",
  ];
  const allFindings: HttpDirectiveFinding[] = [];
  function add(code: HttpFindingCode, severity: "warning" | "info", index: number, message: string) {
    allFindings.push({ code, severity, resource: index, message });
  }

  items.forEach((item, n) => {
    const index = n + 1;
    const mime = mimeCategory(item.content_type);
    const isNonHtml = mime !== "html" && mime !== "unknown";
    const robots = parseRobotHeaders(item.x_robots_tag ?? []);
    const canonicals = parseCanonicalHeaders(item.link ?? []);
    const attachment = /^\s*attachment\s*(?:;|$)/iu.test(item.content_disposition ?? "");
    const nonSuccess = item.status_code < 200 || item.status_code >= 300;
    const canonicalState: HttpCanonicalState = canonicals.distinct > 1 ? "conflicting"
      : canonicals.unresolved > 0 || canonicals.limited ? "unresolved"
      : canonicals.total === 0 ? "absent"
      : canonicals.total === 1 ? "one" : "repeated";
    const evidence: HttpResourceEvidence = {
      resource: index, status_code: item.status_code, method: item.method ?? "unspecified",
      mime_category: mime, non_html: isNonHtml,
      x_robots_observed: robots.observed,
      explicit_noindex: robots.noindex, googlebot_noindex: robots.googlebotNoindex,
      googlebot_noimageindex: robots.googlebotNoimageindex,
      conflicting_robots: robots.conflict,
      canonical_declarations: canonicals.total, canonical_valid_targets: canonicals.valid,
      canonical_state: canonicalState,
      attachment_declared: attachment, header_coverage_limited: canonicals.limited,
    };
    out.resources.push(evidence);
    if (isNonHtml) out.non_html_resources++;
    if (mime === "html") out.html_resources++;
    if (mime === "unknown") out.unknown_mime_resources++;
    if (nonSuccess) out.non_success_resources++;
    if (robots.noindex) out.explicit_noindex_resources++;
    if (robots.googlebotNoindex) out.googlebot_noindex_resources++;
    if (robots.googlebotNoimageindex) out.googlebot_noimageindex_resources++;
    if (robots.conflict) out.conflicting_robots_resources++;
    if (canonicals.total > 0) out.canonical_header_resources++;
    if (canonicalState === "conflicting") out.conflicting_canonical_resources++;
    out.unresolved_canonical_references += canonicals.unresolved;
    if (attachment) out.attachment_resources++;

    if (robots.conflict) add("conflicting_robots", "warning", index,
      "Conflicting indexing or following directives were declared for an overlapping crawler scope; review the effective restrictive policy.");
    if (canonicalState === "conflicting") add("conflicting_canonical", "warning", index,
      "Distinct HTTP canonical targets were declared; review which one is intended.");
    if (canonicals.unresolved) add("unresolved_canonical", "warning", index,
      "An HTTP Link canonical target is invalid, non-absolute, credential-bearing, or unsupported.");
    if (canonicals.limited) add("link_header_limited", "info", index,
      "The Link header item cap was reached; additional declarations were not analyzed.");
    if (robots.noindex) add("explicit_noindex", "info", index,
      "An unscoped HTTP noindex directive was supplied; this alone does not establish Google indexing state.");
    else if (robots.googlebotNoindex) add("googlebot_noindex", "info", index,
      "A Googlebot-specific HTTP noindex directive was supplied; live crawler application remains unverified.");
    if (robots.googlebotNoimageindex) add("explicit_noimageindex", "info", index,
      "A Googlebot-applicable noimageindex declaration was supplied; actual image indexing behavior remains unverified.");
    if (attachment) add("attachment_disposition", "info", index,
      "The response declares Content-Disposition attachment; this is not by itself an indexing rule.");
    if (nonSuccess) add("non_success_response", "info", index,
      "This observation has a non-2xx status; it may not describe a final accessible document.");
    if (item.status_code === 206) add("partial_http_response", "info", index,
      "HTTP 206 represents a partial response; full-resource behavior is not established.");
    if (mime === "unknown") add("unknown_content_type", "info", index,
      "No recognized MIME category was supplied; document type and indexability are unverified.");
    if (mime === "html") add("html_in_non_html_review", "info", index,
      "An HTML content type was supplied; inspect HTML-specific indexing signals separately.");
    if (new URL(item.url).pathname.toLowerCase().endsWith(".pdf") && mime === "html") {
      add("pdf_type_mismatch", "info", index,
        "A .pdf path was observed with an HTML content type; verify the intended response format.");
    }
  });

  allFindings.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1)
    || a.resource - b.resource || a.code.localeCompare(b.code));
  out.total_findings = allFindings.length;
  out.findings = allFindings.slice(0, MAX_HTTP_FINDINGS);
  out.findings_truncated = allFindings.length > MAX_HTTP_FINDINGS;
  return out;
}
