/**
 * P1-13: bounded, offline HTTPS and security evidence from caller-observed
 * HTTP response headers and optional static HTML. Shared by local/Worker.
 * No requests, TLS handshake, certificate inspection or browser execution.
 */
import { load } from "cheerio";
import { safeHttpResourceUrl } from "./non-html-directives.js";

export const MAX_SECURITY_PAGES = 8;
export const MAX_SECURITY_FINDINGS = 12;
export const MAX_SECURITY_HEADER_BYTES = 2_048;
export const MAX_SECURITY_HEADER_VALUES = 4;
export const MAX_SECURITY_HEADER_TOTAL_BYTES = 24_000;
export const MAX_SECURITY_HTML_BYTES = 120_000;
export const MAX_SECURITY_TOTAL_HTML_BYTES = 300_000;
export const MAX_SECURITY_DOM_ELEMENTS = 400;
export const MAX_SECURITY_RESOURCE_DECLARATIONS = 160;

export const SECURITY_HSTS_STATES = [
  "absent", "enabled", "disabled", "invalid", "conflicting", "http_ignored",
] as const;
export type HstsState = typeof SECURITY_HSTS_STATES[number];
export const SECURITY_CSP_STATES = [
  "absent", "enforced", "report_only", "both", "meta_only",
] as const;
export type CspState = typeof SECURITY_CSP_STATES[number];
export const SECURITY_FINDING_CODES = [
  "http_success_without_redirect", "http_redirect_not_https", "http_redirect_unresolved",
  "hsts_missing_observation", "hsts_disabled", "hsts_invalid", "hsts_conflicting",
  "hsts_http_ignored", "csp_report_only", "csp_unobserved",
  "weak_referrer_policy", "nosniff_unobserved", "frame_protection_unobserved",
  "mixed_blockable", "mixed_upgradable_candidate", "insecure_form_action",
  "insecure_base_href", "html_sampling_limited", "non_success_response",
] as const;
export type SecurityFindingCode = typeof SECURITY_FINDING_CODES[number];

export interface SecurityPageObservation {
  url: string;
  status_code: number;
  location?: string;
  strict_transport_security?: string[];
  content_security_policy?: string[];
  content_security_policy_report_only?: string[];
  referrer_policy?: string;
  x_content_type_options?: string;
  x_frame_options?: string;
  htmlContent?: string;
}
export interface SecurityPageEvidence {
  page: number;
  scheme: "http" | "https";
  status_code: number;
  https_redirect_declared: boolean;
  insecure_redirect_declared: boolean;
  unresolved_redirect: boolean;
  hsts_state: HstsState;
  hsts_include_subdomains: boolean;
  hsts_preload_declared: boolean;
  csp_state: CspState;
  csp_upgrade_insecure_requests: boolean;
  referrer_policy_observed: boolean;
  weak_referrer_policy: boolean;
  nosniff_observed: boolean;
  frame_protection_observed: boolean;
  html_supplied: boolean;
  mixed_blockable_declarations: number;
  mixed_upgradable_declarations: number;
  insecure_form_actions: number;
  mixed_ip_host_declarations: number;
  insecure_base_href: boolean;
  declarations_truncated: boolean;
}
export interface SecurityFinding {
  page: number;
  code: SecurityFindingCode;
  severity: "warning" | "info";
  message: string;
}
export interface HttpsSecurityReview {
  scope: "caller_supplied_https_security_evidence_only";
  pages_sampled: number;
  http_observations: number;
  https_observations: number;
  https_redirect_declarations: number;
  http_without_secure_redirect: number;
  https_without_hsts_observation: number;
  hsts_disabled_or_invalid: number;
  enforced_csp_observations: number;
  report_only_csp_observations: number;
  mixed_blockable_declarations: number;
  mixed_upgradable_declarations: number;
  insecure_form_actions: number;
  pages_with_truncated_html: number;
  coverage_limited: true;
  limitations: string[];
  pages: SecurityPageEvidence[];
  total_findings: number;
  findings: SecurityFinding[];
  findings_truncated: boolean;
  error?: string;
}

export function emptyHttpsSecurityReview(): HttpsSecurityReview {
  return {
    scope: "caller_supplied_https_security_evidence_only",
    pages_sampled: 0, http_observations: 0, https_observations: 0,
    https_redirect_declarations: 0, http_without_secure_redirect: 0,
    https_without_hsts_observation: 0, hsts_disabled_or_invalid: 0,
    enforced_csp_observations: 0, report_only_csp_observations: 0,
    mixed_blockable_declarations: 0, mixed_upgradable_declarations: 0,
    insecure_form_actions: 0, pages_with_truncated_html: 0,
    coverage_limited: true,
    limitations: ["The supplied HTTP/HTML observations could not be reviewed within the evidence limits."],
    pages: [], total_findings: 0, findings: [], findings_truncated: false,
  };
}

const MAX_TEXT_BYTES = new TextEncoder();
function headerBytes(value: string | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || /[\r\n\u0000]/u.test(value) ||
    MAX_TEXT_BYTES.encode(value).byteLength > MAX_SECURITY_HEADER_BYTES) {
    throw new Error("Unsupported or oversized observed HTTP header value");
  }
  return MAX_TEXT_BYTES.encode(value).byteLength;
}
function headersBytes(values: string[] | undefined): number {
  if (values === undefined) return 0;
  if (!Array.isArray(values) || values.length > MAX_SECURITY_HEADER_VALUES) {
    throw new Error("Too many repeated header observations");
  }
  return values.reduce((total, value) => total + headerBytes(value), 0);
}

function parseHsts(values: string[]): {
  state: "enabled" | "disabled" | "invalid" | "conflicting";
  includeSubdomains: boolean; preload: boolean;
} {
  const policies: Array<{ maxAge: string; includeSubdomains: boolean; preload: boolean } | null> = [];
  for (const raw of values) {
    const sections = raw.split(";").map((s) => s.trim()).filter(Boolean);
    const ages = sections
      .map((part) => /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/iu.exec(part))
      .filter((match) => Boolean(match));
    const declaredAges = sections.filter((part) => /^max-age\b/iu.test(part));
    if (ages.length !== 1 || declaredAges.length !== 1) {
      policies.push(null);
      continue;
    }
    const age = ages[0]![1] || ages[0]![2];
    const normalized = String(BigInt(age));
    const includeSubdomains = sections.some((part) => /^includeSubDomains$/iu.test(part));
    const preload = sections.some((part) => /^preload$/iu.test(part));
    policies.push({ maxAge: normalized, includeSubdomains, preload });
  }
  if (policies.some((policy) => policy === null)) {
    return { state: "invalid", includeSubdomains: false, preload: false };
  }
  const normalized = policies as Exclude<typeof policies[number], null>[];
  const unique = new Set(normalized.map((policy) =>
    policy.maxAge + "/" + policy.includeSubdomains + "/" + policy.preload));
  if (unique.size > 1) return { state: "conflicting", includeSubdomains: false, preload: false };
  return {
    state: normalized[0].maxAge === "0" ? "disabled" : "enabled",
    includeSubdomains: normalized[0].includeSubdomains,
    preload: normalized[0].preload,
  };
}

function hasCspDirective(values: string[], directive: string): boolean {
  return values.some((value) => value.split(";").some((part) =>
    part.trim().split(/\s+/u)[0]?.toLowerCase() === directive));
}
function isHttpIpHost(url: URL): boolean {
  return url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname);
}
function insecureUrl(value: string, base: string): URL | undefined {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const result = new URL(value.trim(), base);
    return result.protocol === "http:" && result.hostname ? result : undefined;
  } catch {
    return undefined;
  }
}

interface StaticDeclarations {
  blockable: number;
  upgradable: number;
  forms: number;
  ipHosts: number;
  insecureBase: boolean;
  truncated: boolean;
  metaCsp: string[];
}
/**
 * Only static HTML declarations. Excludes JS-computed requests, dynamic CSS,
 * browser upgrades and enforcement. URL contents are never returned.
 */
function inspectStaticHtml(html: string, pageUrl: string): StaticDeclarations {
  const result: StaticDeclarations = {
    blockable: 0, upgradable: 0, forms: 0,
    ipHosts: 0, insecureBase: false, truncated: false, metaCsp: [],
  };
  const $ = load(html);
  const meta = $("head meta[http-equiv]").toArray();
  for (const element of meta.slice(0, 12)) {
    if (($(element).attr("http-equiv") || "").toLowerCase() === "content-security-policy") {
      const content = $(element).attr("content");
      if (content) result.metaCsp.push(content.slice(0, MAX_SECURITY_HEADER_BYTES));
    }
  }
  const baseTag = $("head base[href]").first().attr("href");
  let effectiveBase = pageUrl;
  if (baseTag) {
    try {
      const base = new URL(baseTag.trim(), pageUrl);
      if (base.protocol === "http:" || base.protocol === "https:") {
        effectiveBase = base.href;
        result.insecureBase = base.protocol === "http:";
      }
    } catch {
      // A malformed base does not establish a different origin.
    }
  }
  const nodes = $("html *").toArray();
  if (nodes.length > MAX_SECURITY_DOM_ELEMENTS) result.truncated = true;
  let declarations = 0;
  function add(raw: string | undefined, mode: "blockable" | "upgradable" | "form"): void {
    if (raw === undefined || declarations >= MAX_SECURITY_RESOURCE_DECLARATIONS) {
      if (raw !== undefined) result.truncated = true;
      return;
    }
    declarations++;
    const target = insecureUrl(raw, effectiveBase);
    if (!target) return;
    if (mode === "form") result.forms++;
    else if (mode === "blockable" || isHttpIpHost(target)) {
      result.blockable++;
      if (mode === "upgradable") result.ipHosts++;
    } else result.upgradable++;
  }
  function srcset(raw: string | undefined) {
    if (!raw) return;
    // Only URL tokens from ordinary static srcset candidates are inspected.
    // Data URLs and advanced CSS image-set parsing are not claimed as complete.
    for (const candidate of raw.split(",").slice(0, MAX_SECURITY_RESOURCE_DECLARATIONS + 1)) {
      const value = candidate.trim().split(/\s+/u)[0];
      if (value) add(value, "blockable");
      if (declarations >= MAX_SECURITY_RESOURCE_DECLARATIONS) break;
    }
    if (raw.split(",").length > MAX_SECURITY_RESOURCE_DECLARATIONS) result.truncated = true;
  }
  function css(raw: string | undefined) {
    if (!raw) return;
    const urls = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/giu;
    let match: RegExpExecArray | null;
    while ((match = urls.exec(raw))) {
      add(match[1] ?? match[2] ?? match[3], "blockable");
      if (declarations >= MAX_SECURITY_RESOURCE_DECLARATIONS) break;
    }
    const imports = /@import\s+["'](https?:[^"'\s]+)["']/giu;
    while ((match = imports.exec(raw))) {
      add(match[1], "blockable");
      if (declarations >= MAX_SECURITY_RESOURCE_DECLARATIONS) break;
    }
  }
  for (const element of nodes.slice(0, MAX_SECURITY_DOM_ELEMENTS)) {
    if (declarations >= MAX_SECURITY_RESOURCE_DECLARATIONS) {
      result.truncated = true; break;
    }
    const tag = ("tagName" in element ? String(element.tagName).toLowerCase() : "");
    const node = $(element);
    if (node.closest("template").length > 0) continue;
    if (tag === "form") add(node.attr("action"), "form");
    else if (tag === "button" || tag === "input") add(node.attr("formaction"), "form");
    else if (tag === "script" || tag === "iframe" || tag === "frame" ||
      tag === "embed" || tag === "track") add(node.attr("src"), "blockable");
    else if (tag === "object") add(node.attr("data"), "blockable");
    else if (tag === "link") {
      const rel = (node.attr("rel") || "").toLowerCase().split(/\s+/u);
      if (rel.some((item) => ["stylesheet", "preload", "modulepreload", "icon", "manifest"].includes(item))) {
        add(node.attr("href"), "blockable");
      }
    } else if (tag === "img") {
      add(node.attr("src"), "upgradable");
      srcset(node.attr("srcset"));
    } else if (tag === "audio" || tag === "video") {
      add(node.attr("src"), "upgradable");
      if (tag === "video") add(node.attr("poster"), "upgradable");
    } else if (tag === "source") {
      if (node.parent().is("audio,video")) add(node.attr("src"), "upgradable");
      srcset(node.attr("srcset"));
    }
    if (tag === "style") css(node.html() ?? undefined);
    css(node.attr("style"));
  }
  return result;
}

/** Audit supplied observations; no network or filesystem effects, no echoed inputs. */
export function analyzeHttpsSecurity(pages: SecurityPageObservation[]): HttpsSecurityReview {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_SECURITY_PAGES) {
    throw new Error("One to eight supplied HTTP security observations are required");
  }
  let totalHeaders = 0;
  let totalHtml = 0;
  let host: string | undefined;
  const urls = new Set<string>();
  const review = emptyHttpsSecurityReview();
  const all: SecurityFinding[] = [];
  review.limitations = [
    "Only caller-supplied response/header and static HTML observations are evaluated; no TLS handshake, redirect following, certificate chain, DNS, server request, browser enforcement or actual security posture is verified.",
    "A missing header here does not prove it is absent in production, nor does one observed HSTS header establish browser preload/state, subdomain coverage or preload-list inclusion.",
    "Insecure resource declarations are static review leads: browsers may upgrade or block them; external CSS/JS, dynamically generated requests, full srcset/CSS parsing, runtime form submission and cross-viewport behavior are not inspected.",
    "At most 8 same-host pages, 400 HTML elements and 160 resource candidates per page are sampled, with 12 prioritized findings; no raw headers, paths, HTML, credentials or URL tokens are returned.",
  ];
  function finding(page: number, code: SecurityFindingCode, severity: "warning" | "info", message: string) {
    all.push({ page, code, severity, message });
  }
  pages.forEach((record, index) => {
    const page = index + 1;
    const safe = safeHttpResourceUrl(record.url);
    if (!safe) throw new Error("Unsafe HTTP(S) observation URL label");
    const current = new URL(safe);
    if (host === undefined) host = current.hostname;
    if (current.hostname !== host || urls.has(safe)) {
      throw new Error("All HTTP security observations must have the same host and unique URL labels");
    }
    urls.add(safe);
    if (!Number.isSafeInteger(record.status_code) || record.status_code < 100 || record.status_code > 599) {
      throw new Error("Unsupported HTTP response status");
    }
    totalHeaders += headerBytes(record.location)
      + headerBytes(record.referrer_policy)
      + headerBytes(record.x_content_type_options)
      + headerBytes(record.x_frame_options)
      + headersBytes(record.strict_transport_security)
      + headersBytes(record.content_security_policy)
      + headersBytes(record.content_security_policy_report_only);
    if (totalHeaders > MAX_SECURITY_HEADER_TOTAL_BYTES) {
      throw new Error("Aggregate HTTP header observation byte limit exceeded");
    }
    if (record.htmlContent !== undefined) {
      if (typeof record.htmlContent !== "string" || !record.htmlContent.trim()) {
        throw new Error("Supplied HTML must be nonempty when present");
      }
      const bytes = MAX_TEXT_BYTES.encode(record.htmlContent).byteLength;
      totalHtml += bytes;
      if (bytes > MAX_SECURITY_HTML_BYTES || totalHtml > MAX_SECURITY_TOTAL_HTML_BYTES) {
        throw new Error("HTML observation byte limit exceeded");
      }
    }

    const scheme = current.protocol === "http:" ? "http" : "https";
    // 304 is a conditional cache response, not a navigation redirect.
    // Only the common Location-redirecting statuses are classified here.
    const redirects = [301, 302, 303, 307, 308].includes(record.status_code);
    const location = record.location?.trim();
    let redirectTarget: "http" | "https" | "unresolved" | undefined;
    if (redirects && location) {
      try {
        const parsed = new URL(location, safe);
        redirectTarget = (!["http:", "https:"].includes(parsed.protocol) ||
          parsed.username || parsed.password || !parsed.hostname)
          ? "unresolved" : parsed.protocol === "https:" ? "https" : "http";
      } catch { redirectTarget = "unresolved"; }
    } else if (redirects) redirectTarget = "unresolved";
    const hstsHeaders = record.strict_transport_security ?? [];
    const hsts = hstsHeaders.length ? parseHsts(hstsHeaders) : null;
    const hstsState: HstsState = !hsts ? "absent" : scheme === "http" ?
      "http_ignored" : hsts.state;
    const enforced = (record.content_security_policy ?? []).filter((value) => value.trim());
    const reports = (record.content_security_policy_report_only ?? []).filter((value) => value.trim());
    const staticHtml = record.htmlContent !== undefined && scheme === "https"
      ? inspectStaticHtml(record.htmlContent, safe) : undefined;
    const metaCsp = staticHtml?.metaCsp ?? [];
    const cspState: CspState = (enforced.length || metaCsp.length) && reports.length ? "both"
      : enforced.length ? "enforced" : metaCsp.length ? "meta_only"
      : reports.length ? "report_only" : "absent";
    const cspUpgrade = hasCspDirective(enforced, "upgrade-insecure-requests") ||
      hasCspDirective(metaCsp, "upgrade-insecure-requests");
    const frameAncestors = hasCspDirective(enforced, "frame-ancestors");
    const referrer = (record.referrer_policy ?? "").trim().toLowerCase();
    const recognizedReferrers = new Set([
      "no-referrer", "no-referrer-when-downgrade", "same-origin", "origin",
      "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url",
    ]);
    // Comma-separated Referrer-Policy is a fallback list; the last
    // recognized policy wins, not the first or any weak token.
    const effectiveReferrer = referrer.split(",").map((item) => item.trim())
      .filter((item) => recognizedReferrers.has(item)).at(-1);
    const weakReferrer = effectiveReferrer === "unsafe-url" ||
      effectiveReferrer === "no-referrer-when-downgrade";
    const xframe = (record.x_frame_options ?? "").trim().toLowerCase();
    const evidence: SecurityPageEvidence = {
      page, scheme, status_code: record.status_code,
      https_redirect_declared: scheme === "http" && redirects && redirectTarget === "https",
      insecure_redirect_declared: scheme === "http" && redirects && redirectTarget === "http",
      unresolved_redirect: scheme === "http" && redirects && redirectTarget === "unresolved",
      hsts_state: hstsState,
      hsts_include_subdomains: Boolean(hsts && hstsState === "enabled" && hsts.includeSubdomains),
      hsts_preload_declared: Boolean(hsts && hstsState === "enabled" && hsts.preload),
      csp_state: cspState, csp_upgrade_insecure_requests: cspUpgrade,
      referrer_policy_observed: referrer.length > 0,
      weak_referrer_policy: weakReferrer,
      nosniff_observed: (record.x_content_type_options ?? "").trim().toLowerCase() === "nosniff",
      frame_protection_observed: frameAncestors || ["deny", "sameorigin"].includes(xframe),
      html_supplied: record.htmlContent !== undefined,
      mixed_blockable_declarations: staticHtml?.blockable ?? 0,
      mixed_upgradable_declarations: staticHtml?.upgradable ?? 0,
      insecure_form_actions: staticHtml?.forms ?? 0,
      mixed_ip_host_declarations: staticHtml?.ipHosts ?? 0,
      insecure_base_href: staticHtml?.insecureBase ?? false,
      declarations_truncated: staticHtml?.truncated ?? false,
    };
    review.pages.push(evidence);
    review.pages_sampled++;
    if (scheme === "https") review.https_observations++;
    else review.http_observations++;
    if (evidence.https_redirect_declared) review.https_redirect_declarations++;
    if (scheme === "http" && !evidence.https_redirect_declared) {
      review.http_without_secure_redirect++;
      if (redirects) finding(page, evidence.insecure_redirect_declared ? "http_redirect_not_https" : "http_redirect_unresolved",
        "warning", "The supplied HTTP redirect did not declare an unambiguous HTTPS destination.");
      else if (record.status_code >= 200 && record.status_code < 300) {
        finding(page, "http_success_without_redirect", "warning",
          "The supplied HTTP observation returned a success response rather than an observed HTTPS redirect.");
      }
    }
    if (hstsState === "absent" && scheme === "https") {
      review.https_without_hsts_observation++;
      finding(page, "hsts_missing_observation", "info",
        "No HSTS header was supplied for this HTTPS response; existing browser HSTS state is unknown.");
    } else if (hstsState === "disabled" || hstsState === "invalid" || hstsState === "conflicting") {
      review.hsts_disabled_or_invalid++;
      const code = hstsState === "disabled" ? "hsts_disabled" :
        hstsState === "invalid" ? "hsts_invalid" : "hsts_conflicting";
      finding(page, code, "warning",
        "Supplied HTTPS HSTS directives do not establish one unambiguous enabled max-age policy.");
    } else if (hstsState === "http_ignored") {
      finding(page, "hsts_http_ignored", "info",
        "HSTS sent over plain HTTP is ignored by browsers; HTTPS observations are needed.");
    }
    if (enforced.length || metaCsp.length) review.enforced_csp_observations++;
    if (reports.length && !enforced.length && !metaCsp.length) review.report_only_csp_observations++;
    if (scheme === "https" && cspState === "report_only") {
      finding(page, "csp_report_only", "info",
        "Only CSP Report-Only headers were supplied; they do not enforce a protection policy.");
    } else if (scheme === "https" && cspState === "absent") {
      finding(page, "csp_unobserved", "info",
        "No enforced CSP header or meta declaration was supplied; this is a review lead, not a confirmed vulnerability.");
    }
    if (weakReferrer) finding(page, "weak_referrer_policy", "warning",
      "The observed Referrer-Policy may disclose more navigation context than intended.");
    if (scheme === "https" && !evidence.nosniff_observed) {
      finding(page, "nosniff_unobserved", "info",
        "X-Content-Type-Options: nosniff was not supplied; inspect effective response headers.");
    }
    if (scheme === "https" && !evidence.frame_protection_observed) {
      finding(page, "frame_protection_unobserved", "info",
        "No enforced CSP frame-ancestors or supported X-Frame-Options was supplied; determine intended framing.");
    }
    if (evidence.mixed_blockable_declarations) {
      finding(page, "mixed_blockable", "warning",
        "The supplied HTTPS HTML declares potentially blockable HTTP subresources; browser enforcement was not tested.");
    }
    if (evidence.mixed_upgradable_declarations) {
      finding(page, "mixed_upgradable_candidate", "info",
        "The supplied HTTPS HTML declares HTTP image/media resources that browsers may upgrade automatically.");
    }
    if (evidence.insecure_form_actions) {
      finding(page, "insecure_form_action", "warning",
        "The supplied HTTPS HTML declares form actions targeting HTTP; no form was submitted.");
    }
    if (evidence.insecure_base_href) {
      finding(page, "insecure_base_href", "warning",
        "An HTTP base href in supplied HTTPS HTML may change resolution of relative resource and form URLs.");
    }
    if (evidence.declarations_truncated) {
      review.pages_with_truncated_html++;
      finding(page, "html_sampling_limited", "info",
        "The static resource-declaration sampling budget was reached; additional markup was not evaluated.");
    }
    if (record.status_code >= 400) finding(page, "non_success_response", "info",
      "The supplied response was non-successful; header and markup observations may not represent the intended page.");
    review.mixed_blockable_declarations += evidence.mixed_blockable_declarations;
    review.mixed_upgradable_declarations += evidence.mixed_upgradable_declarations;
    review.insecure_form_actions += evidence.insecure_form_actions;
  });
  all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1) ||
    a.page - b.page || a.code.localeCompare(b.code));
  review.total_findings = all.length;
  review.findings = all.slice(0, MAX_SECURITY_FINDINGS);
  review.findings_truncated = all.length > MAX_SECURITY_FINDINGS;
  return review;
}
