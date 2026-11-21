/**
 * V04: bounded HTTP redirect and canonical-chain evidence review.
 * Pure offline analyzer shared by Node and Cloudflare Worker MCPs.
 *
 * Original URL strings, source HTML, headers, tokens and query parameters
 * never appear in the report. No crawler/indexing verdict is asserted.
 */
import { load } from "cheerio";
import { safeVariantLabel } from "./url-variants.js";
import { analyzeCrawlerAccess, MAX_CRAWLER_HTML_BYTES } from "./crawler-access.js";

export const MAX_CHAIN_HOPS = 8;
export const MAX_CHAIN_FINDINGS = 24;
export const MAX_CHAIN_CANONICALS = 4;
// Match the existing hosted public HTML 1 MiB fetch cap; 150 KB excluded
// ordinary production pages with embedded application bootstrap data.
export const MAX_CHAIN_HTML_BYTES = 1_048_576;
export const MAX_CHAIN_TOTAL_HTML_BYTES = 1_500_000;
const MAX_CHAIN_URL_BYTES = 1024;
export const CHAIN_REDIRECT_STATES = [
  "none", "permanent", "temporary",
] as const;
export const CHAIN_TARGET_STATES = [
  "none", "next_observed", "loop", "cross_origin",
  "https_downgrade", "query_target", "unobserved",
  "missing", "invalid", "mismatch",
] as const;
export const CHAIN_CANONICAL_STATES = [
  "absent", "self", "sampled", "external", "unobserved",
  "conflicting", "invalid", "redirect_target",
] as const;
export const CHAIN_INDEXING_STATES = [
  "explicit_noindex", "no_noindex_observed", "unknown",
] as const;
export const CHAIN_FINDING_CODES = [
  "redirect_missing_location", "redirect_invalid_target",
  "redirect_loop", "redirect_cross_origin", "redirect_https_downgrade",
  "redirect_query_target", "redirect_observation_mismatch",
  "redirect_chain_unobserved", "redirect_long_chain",
  "redirect_destination_http_error", "redirect_destination_noindex",
  "redirect_destination_robots_blocked", "expected_destination_mismatch",
  "canonical_conflict", "canonical_invalid",
  "canonical_external", "canonical_unobserved",
  "canonical_to_redirect", "canonical_to_http_error",
  "canonical_to_noindex", "canonical_cycle", "canonical_chain",
  "final_status_unverified", "destination_indexing_unverified",
] as const;

export type ChainRedirectState = typeof CHAIN_REDIRECT_STATES[number];
export type ChainTargetState = typeof CHAIN_TARGET_STATES[number];
export type ChainCanonicalState = typeof CHAIN_CANONICAL_STATES[number];
export type ChainIndexingState = typeof CHAIN_INDEXING_STATES[number];
export type ChainFindingCode = typeof CHAIN_FINDING_CODES[number];

export interface RedirectChainObservation {
  url: string;
  status_code: number;
  location?: string;
  /** Caller-supplied canonical href values, including extracted HTTP Link rel=canonical. */
  canonicals?: string[];
  /** Optional static raw HTML from the HTTP GET (not rendered DOM). */
  html?: string;
  /** [] explicitly means the X-Robots-Tag header was checked and absent. */
  x_robots_tag?: string[];
  /** Actual caller-observed robots accessibility, never inferred from a GET. */
  robots_allowed?: boolean;
}

export interface RedirectCanonicalInput {
  source_url: string;
  observations: RedirectChainObservation[];
  expected_destination?: string;
}

export interface RedirectCanonicalHop {
  hop: number;
  status_code: number;
  redirect_state: ChainRedirectState;
  redirect_target: ChainTargetState;
  next_hop_observed: boolean;
  canonical_state: ChainCanonicalState;
  canonical_declarations: number;
  canonical_target_sampled: boolean;
  googlebot_indexing_state: ChainIndexingState;
  robots_allowed: "allowed" | "disallowed" | "unknown";
  static_html_examined: boolean;
  x_robots_header_examined: boolean;
}

export interface RedirectCanonicalFinding {
  hop: number;
  code: ChainFindingCode;
  severity: "warning" | "info";
  message: string;
}

export interface RedirectCanonicalReview {
  scope: "caller_supplied_redirect_evidence" | "live_public_redirect_probe";
  hops_observed: number;
  redirects_observed: number;
  permanent_redirects: number;
  temporary_redirects: number;
  chain_complete: boolean;
  loop_detected: boolean;
  final_status_code?: number;
  expected_destination_match?: boolean;
  conflicting_canonical_hops: number;
  canonical_cycles: number;
  canonical_chain_edges: number;
  nonindexable_destination: boolean;
  destination_indexing_state: ChainIndexingState;
  coverage_limited: true;
  limitations: string[];
  hops: RedirectCanonicalHop[];
  total_findings: number;
  findings: RedirectCanonicalFinding[];
  findings_truncated: boolean;
  error?: string;
}

const limitations = [
  "Observed redirects and canonical declarations are signals, not Google's selected canonical or a live indexing verdict.",
  "An unobserved redirect or canonical target is unknown, not proven missing, broken or wrong.",
  "Only supplied/static HTML and X-Robots-Tag evidence was checked, never rendered JavaScript content.",
  "A different destination is called mismatched only when an expected destination was explicitly provided.",
];

const enc = new TextEncoder();
function bytes(value: string): number { return enc.encode(value).byteLength; }
function safeAbsoluteLabel(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length > MAX_CHAIN_URL_BYTES ||
    bytes(raw) > MAX_CHAIN_URL_BYTES) return null;
  const safe = safeVariantLabel(raw);
  if (!safe) return null;
  return new URL(safe);
}
function target(raw: string, base: URL): URL | null {
  try {
    if (typeof raw !== "string" || !raw || bytes(raw) > MAX_CHAIN_URL_BYTES ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(raw) ||
      raw.includes("#")) return null;
    const out = new URL(raw, base);
    if (!["http:", "https:"].includes(out.protocol) || out.username || out.password ||
      out.port || out.hash) return null;
    return out;
  } catch { return null; }
}
function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}
function redirectState(status: number): ChainRedirectState {
  if (status === 301 || status === 308) return "permanent";
  if (status === 302 || status === 303 || status === 307) return "temporary";
  return "none";
}
function shortStatus(status: number): boolean { return status >= 400 && status <= 599; }
function htmlCanonicals(html: string | undefined): string[] {
  if (html === undefined) return [];
  const $ = load(html);
  const matches: string[] = [];
  $("head > link[rel][href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").trim().toLowerCase().split(/\s+/);
    if (rel.includes("canonical")) matches.push(($(el).attr("href") ?? "").trim());
  });
  return matches;
}

/** Extract rel=canonical hrefs from a bounded HTTP Link field, without echoing them. */
export function canonicalHrefsFromLinkHeader(value: string | null): string[] {
  if (!value || bytes(value) > 8_192) return [];
  const found: string[] = [];
  for (const part of value.split(/,(?=\s*<)/u)) {
    const uri = /^\s*<([^<>]{1,1024})>/u.exec(part);
    if (!uri) continue;
    const parameters = part.slice(uri[0].length);
    let quote: "\"" | "'" | undefined;
    let start = -1; // Only semicolon-delimited Link parameters count.
    for (let i = 0; i <= parameters.length; i += 1) {
      const char = parameters[i];
      if (quote && char === "\\" && i + 1 < parameters.length) { i += 1; continue; }
      if (char === quote) quote = undefined;
      else if (!quote && (char === '"' || char === "'")) quote = char;
      if (!quote && (char === ";" || i === parameters.length)) {
        if (start >= 0) {
          const rel = /^rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]+))$/iu.exec(
            parameters.slice(start, i).trim(),
          );
          if (rel && (rel[1] ?? rel[2] ?? rel[3] ?? "")
            .toLowerCase().split(/\s+/u).includes("canonical")) {
            found.push(uri[1]);
            break;
          }
        }
        start = i + 1;
      }
    }
    if (found.length === MAX_CHAIN_CANONICALS) break;
  }
  return found;
}

/**
 * The shared V03 crawler matrix intentionally has a smaller per-page cap.
 * For V04's larger bounded HTML sample, preserve *all* applicable meta
 * declarations in a small synthetic document instead of truncating the head.
 * If that reduction cannot be completed, don't certify no-noindex-observed.
 */
function metadataOnlyHtml(html: string): string | undefined {
  if (bytes(html) <= MAX_CRAWLER_HTML_BYTES) return html;
  const $ = load(html);
  const tags: string[] = [];
  let total = 0;
  let exceeded = false;
  $("meta[name][content]").each((_, element) => {
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    if (name !== "robots" && name !== "googlebot") return;
    const markup = $.html(element);
    total += bytes(markup);
    if (tags.length >= 64 || total > 64_000) {
      exceeded = true;
    } else tags.push(markup);
  });
  return exceeded ? undefined : "<html><head>" + tags.join("") + "</head></html>";
}

function googleIndexing(row: RedirectChainObservation, url: URL): ChainIndexingState {
  if (row.html === undefined && row.x_robots_tag === undefined) return "unknown";
  if (!(row.status_code >= 200 && row.status_code <= 299)) return "unknown";
  const compact = row.html === undefined ? undefined : metadataOnlyHtml(row.html);
  const review = analyzeCrawlerAccess({
    site_url: url.origin + "/",
    pages: [{
      url: url.href,
      status_code: row.status_code,
      ...(compact === undefined ? {} : { html: compact }),
      ...(row.x_robots_tag === undefined ? {} : { x_robots_tag: row.x_robots_tag }),
    }],
    profiles: ["googlebot-desktop"],
  });
  return review.rows[0]?.indexing_state ?? "unknown";
}

export function emptyRedirectCanonicalReview(
  scope: RedirectCanonicalReview["scope"] = "caller_supplied_redirect_evidence",
): RedirectCanonicalReview {
  return {
    scope, hops_observed: 0, redirects_observed: 0, permanent_redirects: 0,
    temporary_redirects: 0, chain_complete: false, loop_detected: false,
    conflicting_canonical_hops: 0, canonical_cycles: 0, canonical_chain_edges: 0,
    nonindexable_destination: false, destination_indexing_state: "unknown",
    coverage_limited: true, limitations, hops: [], total_findings: 0,
    findings: [], findings_truncated: false,
  };
}

export function analyzeRedirectCanonicalChains(
  input: RedirectCanonicalInput,
  scope: RedirectCanonicalReview["scope"] = "caller_supplied_redirect_evidence",
): RedirectCanonicalReview {
  const source = safeAbsoluteLabel(input?.source_url);
  const records = input?.observations;
  if (!source || !Array.isArray(records) || records.length < 1 ||
    records.length > MAX_CHAIN_HOPS) {
    throw new Error("Provide one to eight ordered HTTP observations and one safe source URL.");
  }
  const expected = input.expected_destination === undefined
    ? undefined : safeAbsoluteLabel(input.expected_destination);
  if (input.expected_destination !== undefined && !expected) {
    throw new Error("The expected destination must be a safe URL label.");
  }
  let htmlTotal = 0;
  const urls = records.map((record) => {
    const url = safeAbsoluteLabel(record.url);
    if (!url || !Number.isInteger(record.status_code) ||
      record.status_code < 100 || record.status_code > 599) {
      throw new Error("Each observed hop requires a valid safe URL label and HTTP status.");
    }
    if (record.location !== undefined &&
      (typeof record.location !== "string" || bytes(record.location) > MAX_CHAIN_URL_BYTES)) {
      throw new Error("Oversized redirect Location evidence.");
    }
    if (record.canonicals !== undefined && (!Array.isArray(record.canonicals) ||
      record.canonicals.length > MAX_CHAIN_CANONICALS ||
      record.canonicals.some((c) => typeof c !== "string" || bytes(c) > MAX_CHAIN_URL_BYTES))) {
      throw new Error("Canonical declarations exceed the bounded input format.");
    }
    if (record.html !== undefined) {
      if (typeof record.html !== "string") throw new Error("Invalid HTML sample");
      const size = bytes(record.html);
      htmlTotal += size;
      if (size > MAX_CHAIN_HTML_BYTES || htmlTotal > MAX_CHAIN_TOTAL_HTML_BYTES) {
        throw new Error("Source HTML exceeds V04 byte caps.");
      }
    }
    if (record.x_robots_tag !== undefined &&
      (!Array.isArray(record.x_robots_tag) || record.x_robots_tag.length > 8 ||
        record.x_robots_tag.some((h) => typeof h !== "string" || bytes(h) > 512))) {
      throw new Error("X-Robots-Tag observations exceed the bounded input format.");
    }
    if (record.robots_allowed !== undefined && typeof record.robots_allowed !== "boolean") {
      throw new Error("Invalid robots accessibility observation.");
    }
    return url;
  });
  if (urls[0].href !== source.href) {
    throw new Error("The initial hop must be the specified source URL.");
  }

  const out = emptyRedirectCanonicalReview(scope);
  const indexByUrl = new Map(urls.map((url, idx) => [url.href, idx]));
  const indexingByRow = records.map((record, index) => googleIndexing(record, urls[index]));
  const isObserved = new Set<string>();
  const canonicalLinks = new Map<number, string>();
  const seenCycles = new Set<string>();
  let consistent = true;
  const add = (hop: number, code: ChainFindingCode, severity: "warning" | "info",
    message: string) => {
    out.total_findings++;
    if (out.findings.length < MAX_CHAIN_FINDINGS) {
      out.findings.push({ hop, code, severity, message });
    } else out.findings_truncated = true;
  };

  for (let idx = 0; idx < records.length; idx++) {
    const record = records[idx];
    const url = urls[idx];
    const hop = idx + 1;
    const redirect = isRedirect(record.status_code);
    const next = urls[idx + 1];
    if (next && !redirect) {
      throw new Error("Non-final observations must be redirect HTTP responses.");
    }
    const state = redirectState(record.status_code);
    if (redirect) {
      out.redirects_observed++;
      if (state === "permanent") out.permanent_redirects++;
      else out.temporary_redirects++;
    }

    let redirect_target: ChainTargetState = "none";
    let next_hop_observed = false;
    const location = redirect && record.location !== undefined
      ? target(record.location, url) : null;
    if (redirect) {
      if (record.location === undefined || record.location.length === 0) {
        redirect_target = "missing";
        add(hop, "redirect_missing_location", "warning",
          "This HTTP redirect has no usable Location header.");
        consistent = false;
      } else if (!location) {
        redirect_target = "invalid";
        add(hop, "redirect_invalid_target", "warning",
          "This redirect has an invalid or unsafe Location target.");
        consistent = false;
      } else if (isObserved.has(location.href) || location.href === url.href) {
        redirect_target = "loop";
        out.loop_detected = true;
        consistent = false;
        add(hop, "redirect_loop", "warning",
          "The redirect points to a previously observed URL in this chain.");
      } else if (next && location.href !== next.href) {
        redirect_target = "mismatch";
        consistent = false;
        add(hop, "redirect_observation_mismatch", "warning",
          "The next supplied hop does not match the observed Location target.");
      } else if (url.protocol === "https:" && location.protocol === "http:") {
        redirect_target = "https_downgrade";
        next_hop_observed = Boolean(next && location.href === next.href);
        add(hop, "redirect_https_downgrade", "warning",
          "The redirect target downgrades an HTTPS page to HTTP.");
      } else if (location.origin !== url.origin) {
        redirect_target = "cross_origin";
        next_hop_observed = Boolean(next && location.href === next.href);
        add(hop, "redirect_cross_origin", "info",
          "The observed redirect crosses an origin boundary; inspect that destination independently.");
      } else if (location.search) {
        redirect_target = "query_target";
        next_hop_observed = Boolean(next && location.href === next.href);
        add(hop, "redirect_query_target", "info",
          "The target has query parameters; confirm that its destination and content are intended.");
      } else if (next && location.href === next.href) {
        redirect_target = "next_observed";
        next_hop_observed = true;
      } else {
        redirect_target = "unobserved";
        add(hop, "redirect_chain_unobserved", "info",
          "The redirect destination was not included among the supplied responses.");
      }
      if (next && !next_hop_observed && location?.href !== next.href) consistent = false;
      if (!next) consistent = false;
    }
    isObserved.add(url.href);

    const declarations = [...(record.canonicals ?? []), ...htmlCanonicals(record.html)];
    let canonical_state: ChainCanonicalState = "absent";
    let canonical_target_sampled = false;
    const candidates = declarations.map((declaration) => target(declaration, url));
    if (declarations.length > 0) {
      const good = candidates.filter((candidate): candidate is URL => candidate !== null);
      const distinct = new Set(good.map((candidate) => candidate.href));
      if (distinct.size > 1) {
        canonical_state = "conflicting";
        out.conflicting_canonical_hops++;
        add(hop, "canonical_conflict", "warning",
          "A single observed response declares different canonical target URLs.");
      } else if (good.length !== candidates.length || good.length === 0) {
        canonical_state = "invalid";
        add(hop, "canonical_invalid", "warning",
          "At least one canonical declaration has an invalid or unsafe URL.");
      } else {
        const first = good[0];
        canonical_target_sampled = indexByUrl.has(first.href);
        if (first.href === url.href) canonical_state = "self";
        else if (first.origin !== url.origin) {
          canonical_state = "external";
          add(hop, "canonical_external", "info",
            "The declared canonical target is outside this origin and is not verified here.");
        } else if (!canonical_target_sampled) {
          canonical_state = "unobserved";
          add(hop, "canonical_unobserved", "info",
            "The canonical target is not sampled; its status and indexing state are unknown.");
        } else {
          canonical_state = "sampled";
          canonicalLinks.set(idx, first.href);
          const targetIdx = indexByUrl.get(first.href)!;
          const targetRecord = records[targetIdx];
          if (isRedirect(targetRecord.status_code)) {
            canonical_state = "redirect_target";
            add(hop, "canonical_to_redirect", "warning",
              "A canonical target is itself an observed HTTP redirect; use its resolved final page.");
          }
          if (shortStatus(targetRecord.status_code)) {
            add(hop, "canonical_to_http_error", "warning",
              "The canonical points to a sampled HTTP 4xx/5xx response.");
          }
          if (indexingByRow[targetIdx] === "explicit_noindex") {
            add(hop, "canonical_to_noindex", "warning",
              "The canonical target has an observed Google-applicable noindex declaration.");
          }
        }
      }
    }

    const indexing = indexingByRow[idx];
    out.hops.push({
      hop, status_code: record.status_code,
      redirect_state: state, redirect_target, next_hop_observed,
      canonical_state, canonical_declarations: declarations.length,
      canonical_target_sampled, googlebot_indexing_state: indexing,
      robots_allowed: record.robots_allowed === undefined ? "unknown"
        : record.robots_allowed ? "allowed" : "disallowed",
      static_html_examined: record.html !== undefined,
      x_robots_header_examined: record.x_robots_tag !== undefined,
    });
  }

  // Canonical graph analysis is limited to actually supplied edges. Unknown
  // targets do not become synthetic nodes or asserted errors.
  for (const [start] of canonicalLinks) {
    const traversed: number[] = [];
    const seen = new Map<number, number>();
    let at: number | undefined = start;
    while (at !== undefined) {
      if (seen.has(at)) {
        const cycle = traversed.slice(seen.get(at)!);
        const key = [...cycle].sort((a, b) => a - b).join(",");
        if (!seenCycles.has(key) && cycle.length > 1) {
          seenCycles.add(key);
          out.canonical_cycles++;
          add(start + 1, "canonical_cycle", "warning",
            "Two or more sampled pages declare canonical URLs that form a cycle.");
        }
        break;
      }
      if (traversed.length > MAX_CHAIN_HOPS) break;
      seen.set(at, traversed.length);
      traversed.push(at);
      const label = canonicalLinks.get(at);
      at = label === undefined ? undefined : indexByUrl.get(label);
    }
    if (traversed.length >= 2 && at === undefined && canonicalLinks.has(traversed[1])) {
      out.canonical_chain_edges++;
      add(start + 1, "canonical_chain", "info",
        "A canonical target declares a different sampled canonical target; review the canonical chain.");
    }
  }

  const final = records.at(-1)!;
  const last = out.hops.at(-1)!;
  out.hops_observed = out.hops.length;
  out.chain_complete = !isRedirect(final.status_code) && !out.loop_detected && consistent;
  if (out.chain_complete) {
    out.final_status_code = final.status_code;
    out.destination_indexing_state = last.googlebot_indexing_state;
    if (expected) {
      out.expected_destination_match = urls.at(-1)!.href === expected.href;
      if (!out.expected_destination_match) {
        add(records.length, "expected_destination_mismatch", "warning",
          "The sampled chain resolved to a different URL than the caller's expected destination.");
      }
    }
    if (shortStatus(final.status_code)) {
      out.nonindexable_destination = true;
      add(records.length, "redirect_destination_http_error", "warning",
        "The sampled chain ends at HTTP 4xx/5xx, not an indexable success response.");
    }
    if (last.googlebot_indexing_state === "explicit_noindex") {
      out.nonindexable_destination = true;
      add(records.length, "redirect_destination_noindex", "warning",
        "The sampled redirect destination declares noindex for Googlebot.");
    }
    if (final.robots_allowed === false) {
      out.nonindexable_destination = true;
      add(records.length, "redirect_destination_robots_blocked", "warning",
        "The destination is explicitly marked robots-disallowed by caller-supplied evidence.");
    }
    if (last.googlebot_indexing_state === "unknown") {
      add(records.length, "destination_indexing_unverified", "info",
        "The final response's indexing directives were not fully observed.");
    }
  } else {
    add(records.length, "final_status_unverified", "info",
      "A complete, consistent non-redirect destination response was not observed.");
  }
  if (out.redirects_observed >= 4) {
    add(1, "redirect_long_chain", "info",
      "This chain contains four or more redirect responses; shorter direct redirects are preferable.");
  }
  return out;
}
