/**
 * V01: bounded HTTP response-delivery evidence. All observations are one
 * point in time; the analyzer does not identify verified crawlers or causes.
 * Deliberately never returns raw URL paths, headers, Location or challenge IDs.
 */
import { safeHttpResourceUrl } from "./non-html-directives.js";

export const MAX_DELIVERY_HOPS = 4;
export const MAX_DELIVERY_FINDINGS = 12;
export const MAX_DELIVERY_HEADER_VALUE_BYTES = 512;
export const MAX_DELIVERY_TOTAL_HEADER_BYTES = 8_192;
export const DELIVERY_HEADER_NAMES = [
  "age", "cache-control", "cf-cache-status", "cf-mitigated", "cf-ray",
  "content-type", "location", "retry-after", "server", "x-cache",
] as const;

export const DELIVERY_FINDING_CODES = [
  "http_forbidden", "http_rate_limited", "http_server_error",
  "http_client_error", "cloudflare_challenge", "redirect_missing_location",
  "redirect_invalid_location", "redirect_query_target", "redirect_cross_origin",
  "redirect_https_downgrade", "redirect_observation_mismatch",
  "redirect_loop", "redirect_incomplete", "redirect_chain_long",
] as const;
export type DeliveryFindingCode = typeof DELIVERY_FINDING_CODES[number];
export type DeliveryStatus = "success" | "redirect" | "forbidden" | "rate_limited" |
  "server_error" | "client_error" | "other";
export type DeliveryRedirectTarget = "none" | "same_origin" | "cross_origin" |
  "https_downgrade" | "query_target" | "invalid" | "missing";
export type DeliveryCacheState = "hit" | "miss" | "bypass" | "dynamic" |
  "expired" | "stale" | "other" | "unknown";

export interface DeliveryInputHop {
  url: string;
  status_code: number;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
}

export interface DeliveryHop {
  hop: number;
  status_code: number;
  status: DeliveryStatus;
  method: "GET" | "HEAD" | "unspecified";
  https: boolean;
  redirect_target: DeliveryRedirectTarget;
  next_hop_observed: boolean;
  cache_state: DeliveryCacheState;
  cache_no_store: boolean;
  cache_no_cache: boolean;
  cache_private: boolean;
  cache_max_age_seconds?: number;
  age_seconds?: number;
  retry_after_present: boolean;
  retry_after_seconds?: number;
  cf_challenge: boolean;
  cf_ray_present: boolean;
  cloudflare_server: boolean;
  content_type_html: boolean;
}

export interface DeliveryFinding {
  hop: number;
  code: DeliveryFindingCode;
  severity: "warning" | "info";
  message: string;
}

export interface DeliveryReview {
  scope: "live_public_http_probe" | "caller_supplied_http_observations";
  hops_observed: number;
  redirects_observed: number;
  final_http_status?: number;
  errors_observed: number;
  challenges_observed: number;
  redirect_chain_complete: boolean;
  coverage_limited: true;
  limitations: string[];
  hops: DeliveryHop[];
  total_findings: number;
  findings: DeliveryFinding[];
  findings_truncated: boolean;
  error?: string;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const allowedHeaders = new Set<string>(DELIVERY_HEADER_NAMES);
const cacheStates = new Set(["HIT", "MISS", "BYPASS", "DYNAMIC", "EXPIRED", "STALE"]);
const probeLimits = [
  "One bounded HTTP observation, not historical availability or a Googlebot fetch.",
  "Only selected response-header flags are reported; cache status and edge headers do not establish root cause.",
  "Challenge detection relies on response signals, not JavaScript execution or an authenticated browser.",
];

export function emptyDeliveryReview(
  scope: DeliveryReview["scope"] = "caller_supplied_http_observations",
): DeliveryReview {
  return {
    scope, hops_observed: 0, redirects_observed: 0,
    errors_observed: 0, challenges_observed: 0,
    redirect_chain_complete: false, coverage_limited: true,
    limitations: probeLimits, hops: [], total_findings: 0,
    findings: [], findings_truncated: false,
  };
}

function statusKind(status: number): DeliveryStatus {
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (redirectStatuses.has(status)) return "redirect";
  if (status >= 200 && status < 300) return "success";
  return "other";
}

function safeIntegerHeader(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,9}$/.test(value.trim())) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function cacheDirectives(value: string): string[] {
  const directives: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) {
      directives.push(value.slice(start, i).trim().toLowerCase());
      start = i + 1;
    }
  }
  directives.push(value.slice(start).trim().toLowerCase());
  return directives;
}

function parseHeaders(record: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  if (!record) return headers;
  for (const [name, value] of Object.entries(record)) {
    const key = name.toLowerCase();
    if (!allowedHeaders.has(key) || typeof value !== "string" ||
      /[\r\n\u0000]/u.test(value) ||
      new TextEncoder().encode(value).byteLength > MAX_DELIVERY_HEADER_VALUE_BYTES ||
      Object.hasOwn(headers, key)) {
      throw new Error("HTTP delivery headers must use unique approved names and bounded single-line values");
    }
    headers[key] = value;
  }
  return headers;
}

function classifyTarget(current: URL, location: string | undefined):
  { state: DeliveryRedirectTarget; target?: string } {
  if (location === undefined || !location.trim()) return { state: "missing" };
  try {
    const parsed = new URL(location, current);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username ||
      parsed.password || parsed.port) {
      return { state: "invalid" };
    }
    if (parsed.search || parsed.hash) {
      return { state: "query_target" };
    }
    if (!safeHttpResourceUrl(parsed.href)) return { state: "invalid" };
    if (current.protocol === "https:" && parsed.protocol === "http:") {
      return { state: "https_downgrade", target: parsed.href };
    }
    if (current.origin !== parsed.origin) {
      return { state: "cross_origin", target: parsed.href };
    }
    return { state: "same_origin", target: parsed.href };
  } catch {
    return { state: "invalid" };
  }
}

/** Caller-controlled records and live-captured headers are subject to identical validation. */
export function analyzeHttpDelivery(
  observations: DeliveryInputHop[],
  scope: DeliveryReview["scope"] = "caller_supplied_http_observations",
): DeliveryReview {
  if (!Array.isArray(observations) || observations.length < 1 ||
    observations.length > MAX_DELIVERY_HOPS) {
    throw new Error("Provide between one and four ordered HTTP delivery hops");
  }

  let totalHeaderBytes = 0;
  let origin: string | undefined;
  const urls: URL[] = [];
  const headers: Record<string, string>[] = [];
  for (const hop of observations) {
    const safe = safeHttpResourceUrl(hop.url);
    if (!safe) throw new Error("HTTP hop URLs must be safe query-free HTTP(S) labels");
    const url = new URL(safe);
    if (origin && url.origin !== origin) throw new Error("HTTP delivery hops must stay on one origin");
    origin = url.origin;
    if (!Number.isInteger(hop.status_code) || hop.status_code < 100 || hop.status_code > 599 ||
      (hop.method !== undefined && hop.method !== "GET" && hop.method !== "HEAD")) {
      throw new Error("HTTP delivery hop status or method is invalid");
    }
    const parsed = parseHeaders(hop.headers);
    totalHeaderBytes += Object.entries(parsed).reduce((bytes, [name, value]) =>
      bytes + name.length + new TextEncoder().encode(value).byteLength, 0);
    if (totalHeaderBytes > MAX_DELIVERY_TOTAL_HEADER_BYTES) {
      throw new Error("HTTP delivery response headers exceed the total input bound");
    }
    urls.push(url);
    headers.push(parsed);
  }

  const output = emptyDeliveryReview(scope);
  const addFinding = (hop: number, code: DeliveryFindingCode, severity: "warning" | "info", message: string) => {
    output.total_findings += 1;
    if (output.findings.length < MAX_DELIVERY_FINDINGS) {
      output.findings.push({ hop, code, severity, message });
    } else {
      output.findings_truncated = true;
    }
  };
  output.hops_observed = observations.length;
  output.final_http_status = observations[observations.length - 1].status_code;
  output.redirect_chain_complete = true;
  const visited = new Set<string>();
  for (let index = 0; index < observations.length; index += 1) {
    const entry = observations[index];
    const url = urls[index];
    const head = headers[index];
    const hopNumber = index + 1;
    const status = statusKind(entry.status_code);
    const redirect = status === "redirect";
    const target = redirect ? classifyTarget(url, head.location) : { state: "none" as const };
    const next = urls[index + 1];
    if (next && !redirect) {
      throw new Error("Each non-final HTTP hop must be a redirect response");
    }
    const nextMatches = Boolean(next && target.target === next.href);
    if (redirect && nextMatches) output.redirects_observed += 1;
    if (redirect && !nextMatches) output.redirect_chain_complete = false;
    if (visited.has(url.href) ||
      (redirect && target.target !== undefined &&
        (target.target === url.href || visited.has(target.target)))) {
      addFinding(hopNumber, "redirect_loop", "warning",
        "The redirect chain points to a previously observed response URL.");
    }
    visited.add(url.href);

    const cfChallenge = head["cf-mitigated"]?.trim().toLowerCase() === "challenge";
    // Cache-Control extension values may contain quoted commas and directive-like text.
    const control = cacheDirectives(head["cache-control"] ?? "");
    const cacheRaw = head["cf-cache-status"]?.trim().toUpperCase() ??
      (/\bHIT\b/i.test(head["x-cache"] ?? "") ? "HIT" :
        /\bMISS\b/i.test(head["x-cache"] ?? "") ? "MISS" : "");
    // RFC 9111: repeated directives use the first occurrence or are treated as stale.
    // Never accept a later max-age when the first occurrence is malformed.
    const firstMaxAge = control.find((part) => /^max-age(?:\s|=|$)/u.test(part));
    const maxAgeMatch = firstMaxAge === undefined ? null :
      /^max-age\s*=\s*(?:(\d{1,9})|"(\d{1,9})")$/u.exec(firstMaxAge);
    const maxAge = safeIntegerHeader(maxAgeMatch?.[1] ?? maxAgeMatch?.[2]);
    const age = safeIntegerHeader(head.age);
    const retryAfter = safeIntegerHeader(head["retry-after"]);
    const mediaType = (head["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    const hop: DeliveryHop = {
      hop: hopNumber, status, status_code: entry.status_code,
      method: entry.method ?? "unspecified", https: url.protocol === "https:",
      redirect_target: target.state, next_hop_observed: nextMatches,
      cache_state: cacheStates.has(cacheRaw)
        ? cacheRaw.toLowerCase() as DeliveryCacheState
        : cacheRaw ? "other" : "unknown",
      cache_no_store: control.includes("no-store"),
      cache_no_cache: control.some((part) => /^no-cache(?:\s*=|$)/u.test(part)),
      cache_private: control.some((part) => /^private(?:\s*=|$)/u.test(part)),
      ...(maxAge === undefined ? {} : { cache_max_age_seconds: maxAge }),
      ...(age === undefined ? {} : { age_seconds: age }),
      retry_after_present: head["retry-after"] !== undefined,
      ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
      cf_challenge: cfChallenge, cf_ray_present: Boolean(head["cf-ray"]),
      cloudflare_server: (head.server ?? "").toLowerCase().includes("cloudflare"),
      content_type_html: mediaType === "text/html" || mediaType === "application/xhtml+xml",
    };
    output.hops.push(hop);
    if (entry.status_code >= 400) output.errors_observed += 1;
    if (cfChallenge) output.challenges_observed += 1;

    if (cfChallenge) addFinding(hopNumber, "cloudflare_challenge", "warning",
      "Cloudflare reported a challenge response (cf-mitigated: challenge).");
    if (status === "forbidden") addFinding(hopNumber, "http_forbidden", "warning",
      "Observed HTTP 403; this response cannot be used as an indexable page.");
    else if (status === "rate_limited") addFinding(hopNumber, "http_rate_limited", "warning",
      "Observed HTTP 429 rate limiting; verify whether the condition is transient.");
    else if (status === "server_error") addFinding(hopNumber, "http_server_error", "warning",
      "Observed an HTTP 5xx server-side failure.");
    else if (status === "client_error") addFinding(hopNumber, "http_client_error", "warning",
      "Observed a non-403, non-429 HTTP 4xx response.");
    if (redirect) {
      const targetCodes: Partial<Record<DeliveryRedirectTarget, DeliveryFindingCode>> = {
        missing: "redirect_missing_location", invalid: "redirect_invalid_location",
        query_target: "redirect_query_target", cross_origin: "redirect_cross_origin",
        https_downgrade: "redirect_https_downgrade",
      };
      const code = targetCodes[target.state];
      if (code) addFinding(hopNumber, code, "warning",
        "Redirect target is " + target.state.replaceAll("_", " ") + "; it was not verified as a safe in-origin next hop.");
      if (next && !nextMatches) addFinding(hopNumber, "redirect_observation_mismatch", "warning",
        "The next supplied hop does not match the declared Location destination.");
      if (!nextMatches && !next) addFinding(hopNumber, "redirect_incomplete", "info",
        "The redirect destination was not observed in this sample.");
    }
  }
  if (output.redirects_observed > 2) addFinding(output.hops_observed, "redirect_chain_long", "info",
    "More than two followed redirect hops increase crawl work; review the chain.");
  return output;
}

/** Only allowlisted header values are captured, with no request cookies or body. */
export function deliveryResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const name of DELIVERY_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) {
      // Excessively long response headers are not passed through to the analyzer.
      result[name] = new TextEncoder().encode(value).byteLength <= MAX_DELIVERY_HEADER_VALUE_BYTES
        ? value : "";
    }
  }
  return result;
}
