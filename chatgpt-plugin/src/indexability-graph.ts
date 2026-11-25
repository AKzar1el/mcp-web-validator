import * as cheerio from "cheerio";
import type { SiteAuditPageSummary } from "./site-audit";

export type CanonicalState = "missing" | "usable" | "ambiguous" | "unverifiable";

export interface PageIndexabilitySignals {
  canonical_state: CanonicalState;
  canonical_url?: string;
  noindex_observed: boolean;
  title?: string;
  hreflang: Array<{ language: string; url: string }>;
  hreflang_truncated: boolean;
}

export interface IndexabilityGraphFinding {
  code: string;
  severity: "error" | "warning" | "info";
  confidence: "observed" | "potential";
  message: string;
  example_urls: string[];
}

export interface SiteIndexabilityGraph {
  scope: "sampled_pages_only";
  sampled_pages: number;
  sitemap_pages_sampled: number;
  coverage_limited: boolean;
  limitations: string[];
  findings: IndexabilityGraphFinding[];
  findings_truncated: boolean;
}

const MAX_TITLE_CHARACTERS = 150;
const MAX_HREFLANG = 16;
const MAX_GRAPH_FINDINGS = 30;
const MAX_EXAMPLE_URLS = 3;

function compact(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// Never output query parameters or credential-bearing URLs: sitemap crawling
// explicitly rejects them, and they can contain secrets or sensitive identifiers.
// Skipping such URLs is evidence loss, not evidence that a target is broken.
function safeObservedUrl(raw: string, baseUrl: string): string | undefined {
  // URL("", base) resolves to the current page, not a declared destination.
  if (!raw.trim()) return undefined;
  try {
    const url = new URL(raw, baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !url.hostname) return undefined;
    if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function relContains(value: string | undefined, token: string): boolean {
  return (value ?? "").trim().split(/[\t\r\n\f ]+/).some((part) => part.toLowerCase() === token);
}

function hasNoindexDirective(value: string | undefined): boolean {
  // Google treats `none` as the noindex,nofollow shorthand in both meta and HTTP rules.
  return Boolean(value && /(?:^|[,;\s])(?:noindex|none)(?:$|[,;\s])/i.test(value));
}

function hasGoogleNoindexHeader(header: string | undefined): boolean {
  if (!header) return false;
  // Comma-separated directives inherit their field's last crawler prefix;
  // a new header field starts unscoped. Colon-valued directives are not bots.
  const valuedRules = new Set(["max-snippet", "max-video-preview", "max-image-preview", "unavailable_after"]);
  return header.split(/[\r\n]+/).some((field) => {
    let crawler: string | undefined;
    for (const part of field.split(",")) {
      const directive = part.trim();
      const agent = /^([a-z][a-z0-9_-]*):\s*(.*)$/i.exec(directive);
      if (agent && !valuedRules.has(agent[1].toLowerCase())) {
        crawler = agent[1].toLowerCase();
        if (crawler === "googlebot" && hasNoindexDirective(agent[2])) return true;
      } else if ((!crawler || crawler === "googlebot") && hasNoindexDirective(directive)) {
        return true;
      }
    }
    return false;
  });
}

/** Extract only cheap, static HTML signals from an already fetched document. */
export function extractPageIndexabilitySignals(
  html: string,
  finalUrl: string,
  xRobotsTag?: string,
): PageIndexabilitySignals {
  const $ = cheerio.load(html);
  const title = compact($("head > title").first().text(), MAX_TITLE_CHARACTERS);
  const noindexMeta = $("head > meta[name]").toArray().some((element) => {
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    return (name === "robots" || name === "googlebot")
      && hasNoindexDirective($(element).attr("content"));
  });

  const canonicalLinks = $("head > link[rel]").toArray().filter((element) =>
    relContains($(element).attr("rel"), "canonical"),
  );
  let canonicalState: CanonicalState = "missing";
  let canonicalUrl: string | undefined;
  if (canonicalLinks.length > 1) {
    canonicalState = "ambiguous";
  } else if (canonicalLinks.length === 1) {
    const link = $(canonicalLinks[0]);
    const href = link.attr("href")?.trim();
    const annotated = ["hreflang", "lang", "media", "type"].some((attr) => link.attr(attr) !== undefined);
    canonicalUrl = href && !annotated ? safeObservedUrl(href, finalUrl) : undefined;
    canonicalState = canonicalUrl ? "usable" : "unverifiable";
  }

  const hreflang: PageIndexabilitySignals["hreflang"] = [];
  const distinct = new Set<string>();
  let hreflangTruncated = false;
  for (const element of $("head > link[rel][hreflang][href]").toArray()) {
    const link = $(element);
    if (!relContains(link.attr("rel"), "alternate")) continue;
    const language = (link.attr("hreflang") ?? "").trim().toLowerCase();
    const url = safeObservedUrl((link.attr("href") ?? "").trim(), finalUrl);
    if (!language || language.length > 40 || !url) {
      hreflangTruncated = true;
      continue;
    }
    const key = JSON.stringify([language, url]);
    if (distinct.has(key)) continue;
    distinct.add(key);
    if (hreflang.length >= MAX_HREFLANG) {
      hreflangTruncated = true;
      break;
    }
    hreflang.push({ language, url });
  }
  return {
    canonical_state: canonicalState,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    noindex_observed: noindexMeta || hasGoogleNoindexHeader(xRobotsTag),
    ...(title ? { title } : {}),
    hreflang,
    hreflang_truncated: hreflangTruncated,
  };
}

interface GraphOptions {
  sitemapPages: string[];
  discoveryComplete: boolean;
}

type ObservedPage = SiteAuditPageSummary & { indexability: PageIndexabilitySignals };

function auditUrl(page: SiteAuditPageSummary): string {
  return page.fetched_url ?? page.url;
}

function severityOrder(value: IndexabilityGraphFinding["severity"]): number {
  return value === "error" ? 0 : value === "warning" ? 1 : 2;
}

function compareFindings(a: IndexabilityGraphFinding, b: IndexabilityGraphFinding): number {
  return severityOrder(a.severity) - severityOrder(b.severity)
    || a.code.localeCompare(b.code)
    || (a.example_urls[0] ?? "").localeCompare(b.example_urls[0] ?? "")
    || JSON.stringify(a.example_urls).localeCompare(JSON.stringify(b.example_urls))
    || a.message.localeCompare(b.message);
}

export function buildSiteIndexabilityGraph(
  pages: SiteAuditPageSummary[],
  options: GraphOptions,
): SiteIndexabilityGraph {
  const findings: IndexabilityGraphFinding[] = [];
  const observed = pages.filter((page): page is ObservedPage =>
    page.page_fetched && page.indexability !== undefined,
  );
  const byUrl = new Map(observed.map((page) => [auditUrl(page), page]));
  const inSitemap = new Set(options.sitemapPages);
  const coverageLimited = !options.discoveryComplete || observed.length !== pages.length
    || observed.some((page) => page.indexability.hreflang_truncated);

  function report(finding: IndexabilityGraphFinding) {
    if (findings.length < MAX_GRAPH_FINDINGS) {
      findings.push(finding);
      return;
    }
    findingsTruncated = true;
    // Retain the most actionable findings, even when earlier warnings fill the cap.
    let worst = 0;
    for (let i = 1; i < findings.length; i++) {
      if (compareFindings(findings[i], findings[worst]) > 0) worst = i;
    }
    if (compareFindings(finding, findings[worst]) < 0) findings[worst] = finding;
  }
  let findingsTruncated = false;

  // Sitemap inclusion with an observed noindex signal is a concrete publishing
  // conflict, but not proof that Google deindexed or ignored the URL.
  for (const page of observed) {
    if (page.indexability.noindex_observed && inSitemap.has(page.url)) {
      report({
        code: "indexability.sitemap_noindex",
        severity: "warning",
        confidence: "observed",
        message: "A sampled sitemap URL returned HTML or an X-Robots-Tag that requests noindex; review whether the sitemap inclusion is intentional.",
        example_urls: [page.url],
      });
    }
  }

  // Each sampled page has at most one usable canonical target. Walk these
  // edges once to distinguish actual cycles from chains leading into cycles.
  const cycleMembers = new Set<string>();
  const visited = new Set<string>();
  for (const start of [...byUrl.keys()].sort()) {
    if (visited.has(start)) continue;
    const path: string[] = [];
    const pathPosition = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !visited.has(current) && !pathPosition.has(current)) {
      pathPosition.set(current, path.length);
      path.push(current);
      const canonical: string | undefined = byUrl.get(current)?.indexability.canonical_url;
      current = canonical && canonical !== current && byUrl.has(canonical) ? canonical : undefined;
    }
    const cycleStart = current ? pathPosition.get(current) : undefined;
    if (cycleStart !== undefined) {
      const cycle = path.slice(cycleStart).sort();
      if (cycle.length >= 2) {
        for (const member of cycle) cycleMembers.add(member);
        report({
          code: "indexability.canonical_cycle",
          severity: "error",
          confidence: "observed",
          message: "Sampled pages form a cycle of canonical declarations; select a consistent canonical target.",
          example_urls: cycle.slice(0, MAX_EXAMPLE_URLS),
        });
      }
    }
    for (const member of path) visited.add(member);
  }

  // Diagnose only sampled targets. A canonical pointing to an unseen URL is
  // neither a broken link nor a definite canonical error.
  for (const page of observed) {
    const canonical = page.indexability.canonical_url;
    const ownUrl = auditUrl(page);
    if (!canonical || canonical === ownUrl) continue;
    const target = byUrl.get(canonical);
    if (!target) continue;

    if (target.indexability.noindex_observed) {
      report({
        code: "indexability.canonical_to_noindex",
        severity: "warning",
        confidence: "observed",
        message: "A sampled page declares a canonical target whose sampled HTML or response header also requests noindex.",
        example_urls: [ownUrl, canonical],
      });
    }
    const back = target.indexability.canonical_url;
    if (!cycleMembers.has(ownUrl) && back && back !== canonical) {
      const another = byUrl.get(back);
      if (another && back !== ownUrl) {
        report({
          code: "indexability.canonical_chain",
          severity: "warning",
          confidence: "potential",
          message: "A sampled page's canonical points to another sampled page that declares a different sampled canonical target.",
          example_urls: [ownUrl, canonical, back],
        });
      }
    }
  }

  // Duplicate titles can be legitimate. Flag only distinct sampled canonical
  // destinations, and use 'potential' instead of declaring an indexing defect.
  const titles = new Map<string, ObservedPage[]>();
  for (const page of observed) {
    const title = page.indexability.title?.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const group = titles.get(title) ?? [];
    group.push(page);
    titles.set(title, group);
  }
  for (const matches of titles.values()) {
    const distinctCanonicalTargets = new Set(matches.map((page) =>
      page.indexability.canonical_url ?? auditUrl(page),
    ));
    if (matches.length > 1 && distinctCanonicalTargets.size > 1) {
      report({
        code: "indexability.duplicate_title",
        severity: "warning",
        confidence: "potential",
        message: "Different sampled canonical destinations share the same page title; check whether the pages are distinguishable in search.",
        example_urls: matches.map(auditUrl).sort().slice(0, MAX_EXAMPLE_URLS),
      });
    }
  }

  const seenHreflang = new Set<string>();
  for (const page of observed) {
    const ownUrl = auditUrl(page);
    // Only infer a missing self-reference from complete, explicit HTML language
    // declarations. An x-default-only fallback is not enough evidence.
    if (!page.indexability.hreflang_truncated
      && page.indexability.hreflang.some((link) => link.language !== "x-default" && link.url !== ownUrl)
      && !page.indexability.hreflang.some((link) => link.url === ownUrl)) {
      report({
        code: "indexability.hreflang_missing_self",
        severity: "warning",
        confidence: "observed",
        message: "Sampled HTML declares alternate languages without including this page in its hreflang set; review the missing self-reference.",
        example_urls: [ownUrl],
      });
    }
    // Multiple distinct destinations for the same locale make a declaration
    // ambiguous even when all pages are otherwise valid and reachable.
    const targetsByLanguage = new Map<string, Set<string>>();
    for (const alternative of page.indexability.hreflang) {
      const targets = targetsByLanguage.get(alternative.language) ?? new Set<string>();
      targets.add(alternative.url);
      targetsByLanguage.set(alternative.language, targets);
    }
    for (const targets of targetsByLanguage.values()) {
      if (targets.size < 2) continue;
      report({
        code: "indexability.hreflang_conflicting_targets",
        severity: "warning",
        confidence: "observed",
        message: "Sampled HTML assigns different destinations to the same hreflang language; review the conflicting declarations.",
        example_urls: [ownUrl, ...[...targets].sort()].slice(0, MAX_EXAMPLE_URLS),
      });
    }
    for (const alternative of page.indexability.hreflang) {
      const target = byUrl.get(alternative.url);
      if (!target || target.indexability.hreflang_truncated) continue;
      // An x-default language selector may not be a localized page and need
      // not declare the originating page as a language variant.
      if (alternative.language === "x-default" && target.indexability.hreflang.length === 0) continue;
      const reciprocal = target.indexability.hreflang.some((link) => link.url === ownUrl);
      if (reciprocal) continue;
      const key = JSON.stringify([ownUrl, alternative.url]);
      if (seenHreflang.has(key)) continue;
      seenHreflang.add(key);
      report({
        code: "indexability.hreflang_missing_return",
        severity: "warning",
        confidence: "observed",
        message: "An alternate-language link targets another sampled page, but the sampled target has no hreflang return link to its source.",
        example_urls: [ownUrl, alternative.url],
      });
    }
  }

  findings.sort(compareFindings);

  const limitations = [
    "Findings concern only static HTML and sampled fetched pages; they do not establish Google's selected canonical, indexing, or rankings.",
    ...(!options.discoveryComplete ? ["Sitemap discovery, page coverage, or validation was incomplete; absence of a finding is not a site-wide pass."] : []),
    ...(observed.length !== pages.length ? ["Some requested pages were not fetched or their static HTML signals were unavailable."] : []),
    ...(observed.some((page) => page.indexability.hreflang_truncated)
      ? ["Some hreflang links were malformed, query-bearing, or beyond the bounded analysis limit; reciprocal checks are incomplete."] : []),
  ];

  return {
    scope: "sampled_pages_only",
    sampled_pages: observed.length,
    sitemap_pages_sampled: observed.filter((page) => inSitemap.has(page.url)).length,
    coverage_limited: coverageLimited,
    limitations,
    findings,
    findings_truncated: findingsTruncated,
  };
}
