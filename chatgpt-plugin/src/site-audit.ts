import * as cheerio from "cheerio";
import {
  auditSeoMetadata,
  toPublicHttpUrl,
  validateSchemaMarkup,
  type AuditIssue,
  type AuditSeverity,
} from "./audits";
import {
  SITE_AUDIT_CONCURRENCY,
  SITE_AUDIT_MAX_EXAMPLE_URLS,
  SITE_AUDIT_MAX_ISSUE_GROUPS,
  SITE_AUDIT_MAX_PAGE_FINDINGS,
  SITE_AUDIT_MAX_PAGES,
  SITE_AUDIT_MAX_ROBOTS_BYTES,
  SITE_AUDIT_MAX_SITEMAPS,
  SITE_AUDIT_MAX_SITEMAP_BYTES,
  SITE_AUDIT_MAX_SITEMAP_URLS,
} from "./constants";
import {
  fetchPublicHtml,
  fetchPublicText,
  PublicHtmlFetchError,
  type FetchedPublicHtml,
} from "./network";
import { validateHtmlDetailed, type ValidationMessage } from "./validators";

export type SitePageStatus = "passed" | "needs_attention" | "partial" | "failed" | "skipped";
export type HtmlValidationStatus = "completed" | "timeout" | "unavailable" | "not_run";
export type SiteDiscovery = "sitemap" | "root_only" | "partial";
export type SiteFindingCategory = "HTML" | "SEO" | "Schema" | "Accessibility";

export interface SiteAuditFinding {
  severity: AuditSeverity;
  category: SiteFindingCategory;
  message: string;
}

export interface SiteAuditPageSummary {
  url: string;
  fetched_url?: string;
  status: SitePageStatus;
  http_status?: number;
  redirects_followed?: number;
  page_fetched: boolean;
  html_validation_status: HtmlValidationStatus;
  html_errors: number;
  html_warnings: number;
  seo_errors: number;
  seo_warnings: number;
  schema_errors: number;
  schema_warnings: number;
  notes: number;
  health_score?: number;
  failure_code?: string;
  top_findings: SiteAuditFinding[];
}

export interface SiteAuditIssueGroup {
  severity: AuditSeverity;
  category: SiteFindingCategory;
  message: string;
  affected_pages: number;
  example_urls: string[];
}

export interface PublicSiteAuditOptions {
  siteUrl: string;
  maxPages: number;
  pageOffset: number;
}

export interface PublicSiteAuditResult {
  site_url: string;
  sitemap_url?: string;
  discovery: SiteDiscovery;
  discovery_error?: "robots_unavailable" | "sitemap_unavailable" | "sitemap_invalid";
  pages_discovered: number;
  pages_selected: number;
  pages_audited: number;
  pages_partial: number;
  pages_failed: number;
  pages_skipped_robots: number;
  truncated: boolean;
  next_page_offset?: number;
  audit_health_score?: number;
  score_coverage_percent: number;
  pages: SiteAuditPageSummary[];
  issue_groups: SiteAuditIssueGroup[];
  issue_groups_truncated: boolean;
}

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface ParsedRobots {
  rules: RobotsRule[];
  sitemapUrls: URL[];
}

interface ParsedSitemap {
  pageUrls: URL[];
  childSitemaps: URL[];
  invalid: boolean;
}

interface DiscoveryResult {
  rules: RobotsRule[];
  sitemapUrl?: string;
  pageUrls: URL[];
  discovery: SiteDiscovery;
  discoveryError?: PublicSiteAuditResult["discovery_error"];
  truncated: boolean;
}

interface GroupAccumulator {
  severity: AuditSeverity;
  category: SiteFindingCategory;
  message: string;
  pages: Set<string>;
}

const SITE_AUDIT_USER_AGENT = "digestseo-web-validator";
const SITEMAP_CONTENT_TYPES = [
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
  "text/plain",
];
const ROBOTS_CONTENT_TYPES = ["text/plain", "text/xml"];
const SEVERITY_ORDER: Record<AuditSeverity, number> = { error: 0, warning: 1, info: 2 };

function compactMessage(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 220 ? compact : `${compact.slice(0, 219).trimEnd()}…`;
}

function sameOriginCrawlUrl(value: string, baseUrl: string, origin: string): URL | undefined {
  const url = toPublicHttpUrl(value, baseUrl);
  if (!url || url.origin !== origin) return undefined;
  url.hash = "";
  // Query values can contain secrets and create an unbounded crawl surface.
  url.search = "";
  return url;
}

function crawlKey(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hash = "";
  normalized.search = "";
  if (normalized.pathname.length > 1 && normalized.pathname.endsWith("/")) {
    normalized.pathname = normalized.pathname.slice(0, -1);
  }
  return normalized.href;
}

function safeOutputUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href;
}

function addUniqueUrl(target: URL[], seen: Set<string>, url: URL): boolean {
  const key = crawlKey(url);
  if (seen.has(key)) return false;
  seen.add(key);
  target.push(new URL(key));
  return true;
}

function robotsPatternMatches(path: string, rule: string): boolean {
  if (!rule) return false;
  const anchored = rule.endsWith("$");
  const source = anchored ? rule.slice(0, -1) : rule;
  const escaped = source
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

/** Parses the supported, public robots directives without interpreting arbitrary content. */
export function parseRobotsTxt(value: string, origin: string): ParsedRobots {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  const sitemapUrls: URL[] = [];
  let current = { agents: [] as string[], rules: [] as RobotsRule[] };
  let currentHasRules = false;

  const flush = () => {
    if (current.agents.length > 0) groups.push(current);
    current = { agents: [], rules: [] };
    currentHasRules = false;
  };

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const directiveValue = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      const sitemapUrl = sameOriginCrawlUrl(directiveValue, origin, origin);
      if (sitemapUrl && !sitemapUrl.pathname.endsWith(".gz")) sitemapUrls.push(sitemapUrl);
      continue;
    }

    if (field === "user-agent") {
      if (currentHasRules) flush();
      if (directiveValue) current.agents.push(directiveValue.toLowerCase());
      continue;
    }

    if ((field === "allow" || field === "disallow") && current.agents.length > 0) {
      current.rules.push({ allow: field === "allow", path: directiveValue });
      currentHasRules = true;
    }
  }
  flush();

  let bestSpecificity = -1;
  const matchingGroups: typeof groups = [];
  for (const group of groups) {
    const specificity = group.agents.reduce((best, agent) => {
      if (agent === "*") return Math.max(best, 0);
      return SITE_AUDIT_USER_AGENT.startsWith(agent) ? Math.max(best, agent.length) : best;
    }, -1);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      matchingGroups.length = 0;
      matchingGroups.push(group);
    } else if (specificity >= 0 && specificity === bestSpecificity) {
      matchingGroups.push(group);
    }
  }

  const sitemapSeen = new Set<string>();
  const uniqueSitemaps: URL[] = [];
  for (const sitemapUrl of sitemapUrls) addUniqueUrl(uniqueSitemaps, sitemapSeen, sitemapUrl);
  return {
    rules: matchingGroups.flatMap((group) => group.rules),
    sitemapUrls: uniqueSitemaps,
  };
}

/** Applies longest-match robots rules; allow wins equal-length ties. */
export function isAllowedByRobots(url: URL, rules: RobotsRule[]): boolean {
  const target = `${url.pathname}${url.search}`;
  let winner: RobotsRule | undefined;
  for (const rule of rules) {
    if (!robotsPatternMatches(target, rule.path)) continue;
    if (!winner || rule.path.length > winner.path.length || (rule.path.length === winner.path.length && rule.allow)) {
      winner = rule;
    }
  }
  return winner?.allow ?? true;
}

function parseSitemapXml(value: string, baseUrl: string, origin: string): ParsedSitemap {
  if (/<\s*!(?:doctype|entity)\b/i.test(value)) {
    return { pageUrls: [], childSitemaps: [], invalid: true };
  }

  try {
    const $ = cheerio.load(value, { xmlMode: true });
    const pageUrls: URL[] = [];
    const childSitemaps: URL[] = [];
    const seenPages = new Set<string>();
    const seenSitemaps = new Set<string>();

    $("urlset > url > loc").each((_index, element) => {
      const url = sameOriginCrawlUrl($(element).text().trim(), baseUrl, origin);
      if (url) addUniqueUrl(pageUrls, seenPages, url);
    });
    $("sitemapindex > sitemap > loc").each((_index, element) => {
      const url = sameOriginCrawlUrl($(element).text().trim(), baseUrl, origin);
      if (url && !url.pathname.endsWith(".gz")) addUniqueUrl(childSitemaps, seenSitemaps, url);
    });
    return { pageUrls, childSitemaps, invalid: false };
  } catch {
    return { pageUrls: [], childSitemaps: [], invalid: true };
  }
}

function isRobotsMissing(error: unknown): boolean {
  return error instanceof PublicHtmlFetchError
    && error.code === "http_status"
    && error.message.includes("HTTP 404");
}

async function discoverFromSitemaps(
  origin: string,
  sitemapUrls: URL[],
): Promise<Pick<DiscoveryResult, "sitemapUrl" | "pageUrls" | "truncated" | "discoveryError">> {
  const queue = sitemapUrls.slice(0, SITE_AUDIT_MAX_SITEMAPS).map((url) => ({ url, depth: 0 }));
  const seenSitemaps = new Set<string>();
  const pageUrls: URL[] = [];
  const seenPages = new Set<string>();
  let sitemapUrl: string | undefined;
  let truncated = sitemapUrls.length > SITE_AUDIT_MAX_SITEMAPS;
  let discoveryError: DiscoveryResult["discoveryError"];

  while (queue.length > 0 && seenSitemaps.size < SITE_AUDIT_MAX_SITEMAPS) {
    const item = queue.shift();
    if (!item) break;
    const sitemapKey = crawlKey(item.url);
    if (seenSitemaps.has(sitemapKey)) continue;
    seenSitemaps.add(sitemapKey);

    try {
      const fetched = await fetchPublicText(item.url.href, {
        allowedOrigin: origin,
        acceptedContentTypes: SITEMAP_CONTENT_TYPES,
        maxBytes: SITE_AUDIT_MAX_SITEMAP_BYTES,
      });
      sitemapUrl ??= fetched.finalUrl;
      const parsed = parseSitemapXml(fetched.text, fetched.finalUrl, origin);
      if (parsed.invalid) {
        discoveryError ??= "sitemap_invalid";
        continue;
      }

      for (const pageUrl of parsed.pageUrls) {
        if (pageUrls.length >= SITE_AUDIT_MAX_SITEMAP_URLS) {
          truncated = true;
          break;
        }
        addUniqueUrl(pageUrls, seenPages, pageUrl);
      }

      if (item.depth >= 1 && parsed.childSitemaps.length > 0) {
        truncated = true;
        continue;
      }
      for (const childSitemap of parsed.childSitemaps) {
        if (queue.length + seenSitemaps.size >= SITE_AUDIT_MAX_SITEMAPS) {
          truncated = true;
          break;
        }
        queue.push({ url: childSitemap, depth: item.depth + 1 });
      }
    } catch {
      discoveryError ??= "sitemap_unavailable";
    }
  }

  return { sitemapUrl, pageUrls, truncated, discoveryError };
}

async function discoverSitePages(origin: string): Promise<DiscoveryResult> {
  const robotsUrl = new URL("/robots.txt", origin).href;
  let robots: ParsedRobots;
  try {
    const fetched = await fetchPublicText(robotsUrl, {
      allowedOrigin: origin,
      acceptedContentTypes: ROBOTS_CONTENT_TYPES,
      maxBytes: SITE_AUDIT_MAX_ROBOTS_BYTES,
    });
    robots = parseRobotsTxt(fetched.text, origin);
  } catch (cause) {
    if (!isRobotsMissing(cause)) {
      return {
        rules: [],
        pageUrls: [],
        discovery: "root_only",
        discoveryError: "robots_unavailable",
        truncated: false,
      };
    }
    robots = { rules: [], sitemapUrls: [] };
  }

  const fallbackSitemap = new URL("/sitemap.xml", origin);
  const sitemapUrls = robots.sitemapUrls.length > 0 ? robots.sitemapUrls : [fallbackSitemap];
  const discovered = await discoverFromSitemaps(origin, sitemapUrls);
  return {
    rules: robots.rules,
    pageUrls: discovered.pageUrls,
    discovery: discovered.pageUrls.length > 0 ? (discovered.discoveryError ? "partial" : "sitemap") : "root_only",
    sitemapUrl: discovered.sitemapUrl,
    discoveryError: discovered.discoveryError,
    truncated: discovered.truncated,
  };
}

function normalizeValidatorFailure(cause: unknown): HtmlValidationStatus {
  if (cause instanceof DOMException && cause.name === "AbortError") return "timeout";
  if (cause instanceof Error && cause.name === "AbortError") return "timeout";
  return "unavailable";
}

function pageFailureCode(cause: unknown): string {
  if (!(cause instanceof PublicHtmlFetchError)) return "fetch_failed";
  if (cause.code === "too_large") return "page_size_limit";
  if (cause.code === "scope") return "scope_redirect_blocked";
  return cause.code;
}

function actionableFindings(findings: SiteAuditFinding[]): SiteAuditFinding[] {
  return findings
    .filter((finding) => finding.severity !== "info")
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    .slice(0, SITE_AUDIT_MAX_PAGE_FINDINGS);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

async function auditFetchedPage(fetched: FetchedPublicHtml): Promise<SiteAuditPageSummary & { findings: SiteAuditFinding[] }> {
  const seo = auditSeoMetadata(fetched.html);
  const schema = validateSchemaMarkup(fetched.html);
  let htmlMessages: ValidationMessage[] = [];
  let htmlCounts = { error: 0, warning: 0, info: 0 };
  let htmlValidationStatus: HtmlValidationStatus = "completed";

  try {
    const html = await validateHtmlDetailed(fetched.html);
    htmlMessages = html.messages;
    htmlCounts = html.counts;
  } catch (cause) {
    htmlValidationStatus = normalizeValidatorFailure(cause);
  }

  const findings: SiteAuditFinding[] = [
    ...htmlMessages.map((message) => ({
      severity: message.type,
      category: "HTML" as const,
      message: compactMessage(message.message),
    })),
    ...seo.issues.map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      message: compactMessage(issue.message),
    })),
    ...schema.issues.map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      message: compactMessage(issue.message),
    })),
  ];
  const seoErrors = seo.counts.error;
  const seoWarnings = seo.counts.warning;
  const schemaErrors = schema.counts.error;
  const schemaWarnings = schema.counts.warning;
  const errors = htmlCounts.error + seoErrors + schemaErrors;
  const warnings = htmlCounts.warning + seoWarnings + schemaWarnings;
  const notes = htmlCounts.info + seo.counts.info + schema.counts.info;
  const status: SitePageStatus = htmlValidationStatus === "completed"
    ? errors > 0 || warnings > 0 ? "needs_attention" : "passed"
    : "partial";

  return {
    url: safeOutputUrl(fetched.requestedUrl),
    fetched_url: safeOutputUrl(fetched.finalUrl),
    status,
    http_status: fetched.status,
    redirects_followed: fetched.redirectsFollowed,
    page_fetched: true,
    html_validation_status: htmlValidationStatus,
    html_errors: htmlCounts.error,
    html_warnings: htmlCounts.warning,
    seo_errors: seoErrors,
    seo_warnings: seoWarnings,
    schema_errors: schemaErrors,
    schema_warnings: schemaWarnings,
    notes,
    ...(htmlValidationStatus === "completed"
      ? { health_score: clampScore(100 - errors * 12 - warnings * 4) }
      : { failure_code: htmlValidationStatus === "timeout" ? "html_validation_timeout" : "html_validation_unavailable" }),
    top_findings: actionableFindings(findings),
    findings,
  };
}

async function auditPage(url: URL, origin: string, prefetched?: FetchedPublicHtml) {
  try {
    const fetched = prefetched ?? await fetchPublicHtml(url.href, { allowedOrigin: origin });
    return await auditFetchedPage(fetched);
  } catch (cause) {
    const failureCode = pageFailureCode(cause);
    const status: SitePageStatus = failureCode === "scope_redirect_blocked" ? "skipped" : "failed";
    return {
      url: url.href,
      status,
      page_fetched: false,
      html_validation_status: "not_run" as const,
      html_errors: 0,
      html_warnings: 0,
      seo_errors: 0,
      seo_warnings: 0,
      schema_errors: 0,
      schema_warnings: 0,
      notes: 0,
      failure_code: failureCode,
      top_findings: [],
      findings: [],
    };
  }
}

async function mapWithCrawlConcurrency<T, R>(
  values: T[],
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await action(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SITE_AUDIT_CONCURRENCY, values.length) }, worker));
  return results;
}

function groupFindings(pages: Array<SiteAuditPageSummary & { findings: SiteAuditFinding[] }>) {
  const groups = new Map<string, GroupAccumulator>();
  let truncated = false;
  for (const page of pages) {
    for (const finding of page.findings) {
      if (finding.severity === "info") continue;
      const key = `${finding.severity}\u0000${finding.category}\u0000${finding.message}`;
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= SITE_AUDIT_MAX_ISSUE_GROUPS) {
          truncated = true;
          continue;
        }
        group = {
          severity: finding.severity,
          category: finding.category,
          message: finding.message,
          pages: new Set<string>(),
        };
        groups.set(key, group);
      }
      group.pages.add(page.fetched_url ?? page.url);
    }
  }

  const issueGroups = Array.from(groups.values())
    .map((group) => ({
      severity: group.severity,
      category: group.category,
      message: group.message,
      affected_pages: group.pages.size,
      example_urls: Array.from(group.pages).slice(0, SITE_AUDIT_MAX_EXAMPLE_URLS),
    }))
    .sort((left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
      || right.affected_pages - left.affected_pages
      || left.message.localeCompare(right.message),
    );
  return { issueGroups, truncated };
}

/**
 * Runs a small, sitemap-first audit. It never follows HTML links, contacts
 * linked assets, authenticates, or checks per-page links. This keeps the
 * hosted call bounded and avoids broad third-party traffic.
 */
export async function auditPublicSite(options: PublicSiteAuditOptions): Promise<PublicSiteAuditResult> {
  if (options.maxPages < 1 || options.maxPages > SITE_AUDIT_MAX_PAGES) {
    throw new Error(`maxPages must be between 1 and ${SITE_AUDIT_MAX_PAGES}.`);
  }

  const seed = await fetchPublicHtml(options.siteUrl);
  const origin = new URL(seed.finalUrl).origin;
  const discovery = await discoverSitePages(origin);
  const seedUrl = sameOriginCrawlUrl(seed.finalUrl, origin, origin);
  if (!seedUrl) throw new Error("The authorized website redirect could not be normalized.");

  const candidates: URL[] = [];
  const seenCandidates = new Set<string>();
  addUniqueUrl(candidates, seenCandidates, seedUrl);
  for (const pageUrl of discovery.pageUrls) addUniqueUrl(candidates, seenCandidates, pageUrl);

  const eligible: URL[] = [];
  let pagesSkippedRobots = 0;
  for (const candidate of candidates) {
    if (!isAllowedByRobots(candidate, discovery.rules)) {
      pagesSkippedRobots += 1;
      continue;
    }
    eligible.push(candidate);
  }

  const pageOffset = Math.min(options.pageOffset, eligible.length);
  const selected = eligible.slice(pageOffset, pageOffset + options.maxPages);
  const prefetchedKey = crawlKey(seedUrl);
  const auditedPages = await mapWithCrawlConcurrency(selected, (candidate) =>
    auditPage(candidate, origin, crawlKey(candidate) === prefetchedKey ? seed : undefined),
  );
  const pages = auditedPages.map(({ findings: _findings, ...page }) => page);
  const grouped = groupFindings(auditedPages);
  const pagesAudited = pages.filter((page) => page.status === "passed" || page.status === "needs_attention").length;
  const pagesPartial = pages.filter((page) => page.status === "partial").length;
  const pagesFailed = pages.filter((page) => page.status === "failed").length;
  const scores = pages.flatMap((page) => page.health_score === undefined ? [] : [page.health_score]);
  const hasMorePages = pageOffset + selected.length < eligible.length;

  return {
    site_url: seedUrl.href,
    ...(discovery.sitemapUrl ? { sitemap_url: discovery.sitemapUrl } : {}),
    discovery: discovery.discovery,
    ...(discovery.discoveryError ? { discovery_error: discovery.discoveryError } : {}),
    pages_discovered: candidates.length,
    pages_selected: selected.length,
    pages_audited: pagesAudited,
    pages_partial: pagesPartial,
    pages_failed: pagesFailed,
    pages_skipped_robots: pagesSkippedRobots,
    truncated: discovery.truncated || hasMorePages,
    ...(hasMorePages ? { next_page_offset: pageOffset + selected.length } : {}),
    ...(scores.length > 0
      ? { audit_health_score: Math.round(scores.reduce((total, score) => total + score, 0) / scores.length) }
      : {}),
    score_coverage_percent: selected.length === 0 ? 0 : Math.round((scores.length / selected.length) * 100),
    pages,
    issue_groups: grouped.issueGroups,
    issue_groups_truncated: grouped.truncated,
  };
}
