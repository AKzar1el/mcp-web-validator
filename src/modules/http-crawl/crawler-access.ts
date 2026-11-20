/**
 * V03 - bounded, static crawler-access matrix (robots.txt + page directives).
 *
 * A profile is a robots product-token simulation, NOT an authenticated crawl.
 * It never requests, returns, or stores raw URL paths, HTML or header values.
 */
import { load } from "cheerio";
import { safeHttpResourceUrl } from "./non-html-directives.js";

export const CRAWLER_PROFILES = [
  "googlebot-smartphone", "googlebot-desktop", "googlebot-news",
  "googlebot-image", "bingbot", "gptbot",
] as const;
export type CrawlerProfile = typeof CRAWLER_PROFILES[number];
export const MAX_CRAWLER_PAGES = 8;
export const MAX_CRAWLER_FINDINGS = 24;
export const MAX_CRAWLER_ROBOTS_BYTES = 64_000;
export const MAX_CRAWLER_HTML_BYTES = 150_000;
export const MAX_CRAWLER_TOTAL_HTML_BYTES = 300_000;
export const MAX_CRAWLER_ROBOT_RULES = 2_000;
export const CRAWLER_ACCESS_STATES = ["allowed", "disallowed", "unknown"] as const;
export const CRAWLER_INDEXING_STATES = [
  "explicit_noindex", "no_noindex_observed", "unknown",
] as const;
export const CRAWLER_FINDING_CODES = [
  "crawler_disallowed", "explicit_noindex", "blocked_with_noindex",
  "robots_unavailable", "indexing_observation_missing",
  "page_http_error", "conflicting_indexing_directives",
  "x_robots_scope_ambiguous", "robots_rules_truncated",
] as const;
export type CrawlerFindingCode = typeof CRAWLER_FINDING_CODES[number];
export type CrawlerAccessState = typeof CRAWLER_ACCESS_STATES[number];
export type CrawlerIndexingState = typeof CRAWLER_INDEXING_STATES[number];

export interface CrawlerAccessPage {
  url: string;
  status_code?: number;
  html?: string;
  x_robots_tag?: string[];
}
export interface CrawlerAccessInput {
  site_url: string;
  robots_txt?: string;
  robots_status_code?: number;
  pages: CrawlerAccessPage[];
  profiles?: CrawlerProfile[];
}
export interface CrawlerAccessRow {
  page: number;
  profile: CrawlerProfile;
  robots_access: CrawlerAccessState;
  robots_rule: "allow" | "disallow" | "none" | "unknown";
  robots_group_matched: boolean;
  indexing_state: CrawlerIndexingState;
  indexing_source: "meta" | "header" | "both" | "none";
  explicit_index_directive: boolean;
  conflicting_index_directives: boolean;
  x_robots_scope_ambiguous: boolean;
  page_http_status?: number;
  static_html_examined: boolean;
  effective_access: "crawl_disallowed" | "crawl_allowed_noindex_declared" |
    "crawl_allowed_no_noindex_observed" | "unverified";
}
export interface CrawlerAccessFinding {
  code: CrawlerFindingCode;
  severity: "warning" | "info";
  page: number;
  profile: CrawlerProfile;
  message: string;
}
export interface CrawlerAccessReview {
  scope: "caller_supplied_crawler_evidence" | "live_public_crawler_probe";
  pages_observed: number;
  profiles_checked: number;
  rows_checked: number;
  robots_status_code?: number;
  robots_rules_used: number;
  robots_rules_truncated: boolean;
  robots_unavailable: boolean;
  crawler_disallowed_rows: number;
  noindex_declared_rows: number;
  unknown_access_rows: number;
  unknown_indexing_rows: number;
  scope_ambiguous_rows: number;
  coverage_limited: true;
  limitations: string[];
  rows: CrawlerAccessRow[];
  total_findings: number;
  findings: CrawlerAccessFinding[];
  findings_truncated: boolean;
  error?: string;
}

type RobotRule = { allow: boolean; pattern: string };
type RobotGroup = { agents: string[]; rules: RobotRule[] };
const profileTokens: Record<CrawlerProfile, string> = {
  "googlebot-smartphone": "googlebot",
  "googlebot-desktop": "googlebot",
  "googlebot-news": "googlebot-news",
  "googlebot-image": "googlebot-image",
  "bingbot": "bingbot",
  "gptbot": "gptbot",
};
const warnings: CrawlerAccessReview["limitations"] = [
  "Profiles simulate published robots product tokens, not actual requests from or authentication of search crawlers.",
  "Robots.txt affects crawl permission; robots meta and X-Robots-Tag express indexing preferences only when the crawler can fetch the page.",
  "No snippet verifies an engine's selected canonical, indexing verdict, real crawler user-agent handling, JavaScript rendering or historical behavior.",
  "Ambiguous folded X-Robots-Tag scopes and unavailable robots/pages are reported as uncertain, not assumed allowed.",
];
const encoder = new TextEncoder();
function bytes(text: string): number { return encoder.encode(text).byteLength; }

export function emptyCrawlerAccessReview(
  scope: CrawlerAccessReview["scope"] = "caller_supplied_crawler_evidence",
): CrawlerAccessReview {
  return {
    scope,
    pages_observed: 0, profiles_checked: 0, rows_checked: 0,
    robots_rules_used: 0, robots_rules_truncated: false,
    robots_unavailable: true, crawler_disallowed_rows: 0,
    noindex_declared_rows: 0, unknown_access_rows: 0,
    unknown_indexing_rows: 0, scope_ambiguous_rows: 0,
    coverage_limited: true, limitations: warnings, rows: [],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

/** Percent-encoded unreserved ASCII is equivalent to literal bytes (RFC 9309). */
function normalizedRobotsValue(value: string): string {
  const withEscapes = value.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(ch) ? ch : "%" + hex.toUpperCase();
  });
  return withEscapes.replace(/[^\x00-\x7f]/gu, (ch) =>
    Array.from(encoder.encode(ch), (byte) => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join(""));
}

/** Iterative glob matcher: bounded linear/backtracking behavior, no attacker regex. */
function matchesRobots(path: string, rawPattern: string): boolean {
  if (!rawPattern) return false;
  const target = normalizedRobotsValue(path);
  const rule = normalizedRobotsValue(rawPattern);
  const anchored = rule.endsWith("$");
  const pattern = anchored ? rule.slice(0, -1) : rule;
  let position = 0;
  let rulePosition = 0;
  let wildcard = -1;
  let wildcardEnd = 0;
  while (position < target.length) {
    if (!anchored && rulePosition === pattern.length) return true;
    if (rulePosition < pattern.length && pattern[rulePosition] === target[position]) {
      position++;
      rulePosition++;
    } else if (rulePosition < pattern.length && pattern[rulePosition] === "*") {
      wildcard = rulePosition++;
      wildcardEnd = position;
    } else if (wildcard >= 0) {
      rulePosition = wildcard + 1;
      position = ++wildcardEnd;
    } else return false;
  }
  while (rulePosition < pattern.length && pattern[rulePosition] === "*") rulePosition++;
  return rulePosition === pattern.length;
}

function parseRobots(content: string): { groups: RobotGroup[]; truncated: boolean; count: number } {
  const groups: RobotGroup[] = [];
  let current: RobotGroup = { agents: [], rules: [] };
  let hasRules = false;
  let count = 0;
  let truncated = false;
  const flush = () => {
    if (current.agents.length) groups.push(current);
    current = { agents: [], rules: [] };
    hasRules = false;
  };
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.split("#", 1)[0]?.trim() ?? "";
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === "user-agent") {
      if (hasRules) flush();
      if (/^(\*|[a-z0-9_.-]{1,80})$/i.test(value) && current.agents.length < 24) {
        current.agents.push(value.toLowerCase());
      }
      continue;
    }
    if ((directive === "allow" || directive === "disallow") &&
      current.agents.length > 0 && value.length <= 512) {
      count++;
      if (count <= MAX_CRAWLER_ROBOT_RULES) {
        current.rules.push({ allow: directive === "allow", pattern: value });
      } else truncated = true;
      hasRules = true;
    }
  }
  flush();
  return { groups, truncated, count };
}

function chosenRules(groups: RobotGroup[], token: string): {
  matched: boolean; rules: RobotRule[];
} {
  let specificity = -1;
  const selected: RobotGroup[] = [];
  for (const group of groups) {
    const score = group.agents.reduce((best, agent) =>
      Math.max(best, agent === "*" ? 0 : (token.includes(agent) ? agent.length : -1)), -1);
    if (score > specificity) {
      specificity = score;
      selected.length = 0;
      if (score >= 0) selected.push(group);
    } else if (score >= 0 && score === specificity) selected.push(group);
  }
  return { matched: specificity >= 0, rules: selected.flatMap((g) => g.rules) };
}

function robotDecision(url: URL, rules: RobotRule[]): { allowed: boolean; rule: "allow" | "disallow" | "none" } {
  const path = url.pathname + url.search;
  let winner: RobotRule | undefined;
  let best = -1;
  for (const rule of rules) {
    if (!matchesRobots(path, rule.pattern)) continue;
    const normalized = normalizedRobotsValue(rule.pattern);
    const specificity = normalized.replace(/%[0-9A-F]{2}/g, "X")
      .replace(/\*/g, "").replace(/\$$/, "").length;
    if (!winner || specificity > best || (specificity === best && rule.allow)) {
      winner = rule;
      best = specificity;
    }
  }
  return { allowed: winner?.allow ?? true,
    rule: winner ? (winner.allow ? "allow" : "disallow") : "none" };
}

/** Guard the service's own fetches without impersonating a real crawler. */
export function isAllowedForFetcher(
  robotsTxt: string, url: string, serviceToken = "digestseo-web-validator",
): boolean | undefined {
  if (typeof robotsTxt !== "string" || bytes(robotsTxt) > MAX_CRAWLER_ROBOTS_BYTES) {
    return undefined;
  }
  const safe = safeHttpResourceUrl(url);
  if (!safe || !/^[a-z0-9._-]{1,80}$/i.test(serviceToken)) return undefined;
  const parsed = parseRobots(robotsTxt);
  if (parsed.truncated) return undefined;
  const selected = chosenRules(parsed.groups, serviceToken.toLowerCase());
  return robotDecision(new URL(safe), selected.rules).allowed;
}

type DirectiveSet = {
  noindex: boolean; index: boolean; scopeAmbiguous: boolean;
};
function hasIndexToken(value: string, token: "noindex" | "index"): boolean {
  return value.split(/[,;\s]+/).some((part) => part.trim().toLowerCase() === token ||
    (token === "noindex" && part.trim().toLowerCase() === "none"));
}
function extractMeta(html: string | undefined): Map<string, { index: boolean; noindex: boolean }> {
  const result = new Map<string, { index: boolean; noindex: boolean }>();
  if (html === undefined) return result;
  const $ = load(html);
  $("meta[name][content]").each((_, element) => {
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    if (name !== "robots" && !Object.values(profileTokens).includes(name)) return;
    const content = $(element).attr("content") ?? "";
    const current = result.get(name) ?? { index: false, noindex: false };
    current.index ||= hasIndexToken(content, "index");
    current.noindex ||= hasIndexToken(content, "noindex");
    result.set(name, current);
  });
  return result;
}

/** Treat each supplied header value as potentially folded; avoid guessing global scope. */
function extractHeader(headers: string[] | undefined, profile: CrawlerProfile): DirectiveSet {
  const result: DirectiveSet = { index: false, noindex: false, scopeAmbiguous: false };
  if (!headers) return result;
  const token = profileTokens[profile];
  for (const raw of headers) {
    let scope = "all";
    let hasScoped = false;
    for (const part of raw.split(",")) {
      let value = part.trim().toLowerCase();
      if (!value) continue;
      const m = /^([a-z][a-z0-9._-]*):\s*(.*)$/.exec(value);
      // Values with colons such as max-snippet do not designate an agent.
      if (m && !["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"].includes(m[1])) {
        scope = m[1];
        hasScoped = true;
        value = m[2].trim();
      } else if (hasScoped && scope !== token && (value === "noindex" || value === "none")) {
        // Folded values may represent a second global header field.
        result.scopeAmbiguous = true;
      }
      if (scope === "all" || token === scope) {
        result.noindex ||= hasIndexToken(value, "noindex");
        result.index ||= hasIndexToken(value, "index");
      }
    }
  }
  return result;
}

function metaDirective(
  collected: Map<string, { index: boolean; noindex: boolean }>,
  profile: CrawlerProfile,
): { index: boolean; noindex: boolean } {
  const global = collected.get("robots");
  const specific = collected.get(profileTokens[profile]);
  return {
    index: Boolean(global?.index || specific?.index),
    noindex: Boolean(global?.noindex || specific?.noindex),
  };
}

export function analyzeCrawlerAccess(
  input: CrawlerAccessInput,
  scope: CrawlerAccessReview["scope"] = "caller_supplied_crawler_evidence",
): CrawlerAccessReview {
  if (!input || typeof input !== "object" || !safeHttpResourceUrl(input.site_url)) {
    throw new Error("Use one safe public query-free site URL.");
  }
  const origin = new URL(input.site_url).origin;
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_CRAWLER_PAGES) {
    throw new Error("Supply one to eight same-origin page observations.");
  }
  const profiles = input.profiles ?? [...CRAWLER_PROFILES];
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > CRAWLER_PROFILES.length ||
    new Set(profiles).size !== profiles.length ||
    profiles.some((profile) => !CRAWLER_PROFILES.includes(profile))) {
    throw new Error("Crawler profile selection contains unknown or repeated values.");
  }
  if (input.robots_status_code !== undefined &&
    (!Number.isInteger(input.robots_status_code) ||
      input.robots_status_code < 100 || input.robots_status_code > 599)) {
    throw new Error("Invalid robots.txt HTTP status.");
  }
  if (input.robots_txt !== undefined &&
    (bytes(input.robots_txt) > MAX_CRAWLER_ROBOTS_BYTES ||
      (input.robots_status_code !== undefined && (
        input.robots_status_code < 200 || input.robots_status_code >= 300)))) {
    throw new Error("Robots content is oversized or inconsistent with the supplied status.");
  }
  const results: Array<{ url: URL; html?: string; headers?: string[]; status?: number }> = [];
  let htmlBytes = 0;
  for (const page of input.pages) {
    const safe = safeHttpResourceUrl(page.url);
    if (!safe || new URL(safe).origin !== origin) {
      throw new Error("All page URL labels must belong to the same origin and have no query/credentials.");
    }
    if (page.status_code !== undefined &&
      (!Number.isInteger(page.status_code) || page.status_code < 100 || page.status_code > 599)) {
      throw new Error("Invalid HTTP page status.");
    }
    if (page.html !== undefined) {
      const size = bytes(page.html);
      htmlBytes += size;
      if (size > MAX_CRAWLER_HTML_BYTES || htmlBytes > MAX_CRAWLER_TOTAL_HTML_BYTES) {
        throw new Error("HTML samples exceed the static input byte caps.");
      }
    }
    if (page.x_robots_tag !== undefined &&
      (!Array.isArray(page.x_robots_tag) || page.x_robots_tag.length > 8 ||
       page.x_robots_tag.some((part) => typeof part !== "string" || bytes(part) > 512))) {
      throw new Error("X-Robots-Tag lines must be a small bounded list.");
    }
    results.push({ url: new URL(safe), html: page.html,
      headers: page.x_robots_tag, status: page.status_code });
  }

  const parsed = input.robots_txt === undefined
    ? { groups: [] as RobotGroup[], truncated: false, count: 0 }
    : parseRobots(input.robots_txt);
  const review = emptyCrawlerAccessReview(scope);
  review.pages_observed = results.length;
  review.profiles_checked = profiles.length;
  review.robots_status_code = input.robots_status_code;
  review.robots_rules_used = Math.min(parsed.count, MAX_CRAWLER_ROBOT_RULES);
  review.robots_rules_truncated = parsed.truncated;
  const robotsStatus = input.robots_status_code;
  const absent = input.robots_txt === undefined && robotsStatus === undefined;
  const noRobotsDocument = robotsStatus !== undefined && robotsStatus >= 400 &&
    robotsStatus < 500 && robotsStatus !== 429;
  const unavailable = (robotsStatus !== undefined && (
    robotsStatus === 429 || robotsStatus >= 500 ||
    (robotsStatus >= 300 && robotsStatus < 400) ||
    robotsStatus < 200)) ||
    (input.robots_txt === undefined && !noRobotsDocument);
  review.robots_unavailable = unavailable || absent;
  function pushFinding(code: CrawlerFindingCode, severity: "warning" | "info",
    page: number, profile: CrawlerProfile, message: string) {
    review.total_findings++;
    if (review.findings.length < MAX_CRAWLER_FINDINGS) {
      review.findings.push({ code, severity, page, profile, message });
    } else review.findings_truncated = true;
  }

  for (let i = 0; i < results.length; i++) {
    const page = results[i];
    const metas = extractMeta(page.html);
    for (const profile of profiles) {
      const selected = chosenRules(parsed.groups, profileTokens[profile]);
      let robotsAccess: CrawlerAccessState;
      let rule: CrawlerAccessRow["robots_rule"] = "unknown";
      if (parsed.truncated || unavailable ||
        (noRobotsDocument && robotsStatus !== 404 && robotsStatus !== 410 &&
          !profile.startsWith("googlebot"))) {
        robotsAccess = "unknown";
      } else if (input.robots_txt !== undefined || noRobotsDocument) {
        const decision = robotDecision(page.url, selected.rules);
        rule = decision.rule;
        robotsAccess = decision.allowed ? "allowed" : "disallowed";
      } else robotsAccess = "unknown";

      const meta = metaDirective(metas, profile);
      const header = extractHeader(page.headers, profile);
      const noindex = meta.noindex || header.noindex;
      const explicitIndex = meta.index || header.index;
      const conflict = noindex && explicitIndex;
      const pageHttpOk = page.status === undefined || (page.status >= 200 && page.status < 300);
      const indexingKnown = page.html !== undefined && page.headers !== undefined;
      const indexingState: CrawlerIndexingState = noindex
        ? "explicit_noindex"
        : (!pageHttpOk || !indexingKnown ? "unknown" : "no_noindex_observed");
      const indexingSource: CrawlerAccessRow["indexing_source"] =
        meta.noindex || meta.index
          ? (header.noindex || header.index ? "both" : "meta")
          : (header.noindex || header.index ? "header" : "none");

      const row: CrawlerAccessRow = {
        page: i + 1, profile, robots_access: robotsAccess,
        robots_rule: rule, robots_group_matched: selected.matched,
        indexing_state: indexingState, indexing_source: indexingSource,
        explicit_index_directive: explicitIndex,
        conflicting_index_directives: conflict,
        x_robots_scope_ambiguous: header.scopeAmbiguous,
        ...(page.status === undefined ? {} : { page_http_status: page.status }),
        static_html_examined: page.html !== undefined,
        effective_access: robotsAccess === "disallowed" ? "crawl_disallowed"
          : robotsAccess === "allowed" && noindex ? "crawl_allowed_noindex_declared"
          : robotsAccess === "allowed" && indexingState === "no_noindex_observed"
            ? "crawl_allowed_no_noindex_observed" : "unverified",
      };
      review.rows.push(row);
      if (robotsAccess === "disallowed") {
        review.crawler_disallowed_rows++;
        pushFinding("crawler_disallowed", "warning", i + 1, profile,
          "The supplied robots.txt rule set disallows this crawler product token on this page.");
      }
      if (robotsAccess === "unknown") {
        review.unknown_access_rows++;
        pushFinding(parsed.truncated ? "robots_rules_truncated" : "robots_unavailable",
          "info", i + 1, profile, "Robots access cannot be established from complete applicable evidence.");
      }
      if (noindex) {
        review.noindex_declared_rows++;
        pushFinding("explicit_noindex", "warning", i + 1, profile,
          "A supplied meta or HTTP directive explicitly declares noindex for this profile.");
        if (robotsAccess === "disallowed") pushFinding("blocked_with_noindex", "info",
          i + 1, profile, "Robots disallow may stop this crawler from seeing the page's noindex instruction.");
      }
      if (indexingState === "unknown") {
        review.unknown_indexing_rows++;
        pushFinding("indexing_observation_missing", "info", i + 1, profile,
          "No complete indexability directive observation was provided for this page.");
      }
      if (page.status !== undefined && page.status >= 400) {
        pushFinding("page_http_error", "warning", i + 1, profile,
          "The supplied HTTP response status is an error, irrespective of robots rules.");
      }
      if (conflict) pushFinding("conflicting_indexing_directives", "warning",
        i + 1, profile, "Index and noindex are declared together; noindex should be treated as restrictive.");
      if (header.scopeAmbiguous) {
        review.scope_ambiguous_rows++;
        pushFinding("x_robots_scope_ambiguous", "info", i + 1, profile,
          "A folded X-Robots-Tag value has ambiguous scope and should be verified against raw server headers.");
      }
    }
  }
  review.rows_checked = review.rows.length;
  return review;
}
