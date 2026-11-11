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
  code?: string;
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
  code?: string;
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
  expectedDiscoveryFingerprint?: string;
}

export interface PublicSiteAuditResult {
  site_url: string;
  sitemap_url?: string;
  discovery: SiteDiscovery;
  discovery_error?: "robots_unavailable" | "sitemap_unavailable" | "sitemap_invalid" | "sitemap_query_unsupported";
  pages_discovered: number;
  pages_selected: number;
  pages_audited: number;
  pages_partial: number;
  pages_failed: number;
  pages_skipped_robots: number;
  truncated: boolean;
  next_page_offset?: number;
  discovery_fingerprint: string;
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
  sitemapQueryUnsupported: boolean;
}

interface ParsedSitemap {
  pageUrls: URL[];
  childSitemaps: URL[];
  invalid: boolean;
  queryUnsupported?: boolean;
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
  code?: string;
  severity: AuditSeverity;
  category: SiteFindingCategory;
  message: string;
  pages: Set<string>;
}

const SITE_AUDIT_USER_AGENT = "digestseo-web-validator";
const SITEMAP_XML_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const ATOM_XML_NAMESPACE = "http://www.w3.org/2005/Atom";
const ROBOTS_MAX_REDIRECTS = 5;
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

function sameOriginCrawlUrl(value: string, baseUrl: string, origin: string, onQueryUnsupported?: () => void): URL | undefined {
  const url = toPublicHttpUrl(value, baseUrl);
  if (!url || url.origin !== origin) return undefined;
  if (url.search && onQueryUnsupported) {
    onQueryUnsupported();
    return undefined;
  }
  url.hash = "";
  // Query values can contain secrets and create an unbounded crawl surface.
  url.search = "";
  return url;
}

function crawlKey(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hash = "";
  normalized.search = "";
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

function normalizeRobotsComparisonValue(value: string): string {
  const unreserved = /^[A-Za-z0-9._~-]$/;
  // RFC 9309 decodes percent-encoded ASCII unreserved octets, but keeps
  // reserved/non-ASCII octets encoded for the robots path comparison.
  const withCanonicalEscapes = value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const decoded = String.fromCharCode(Number.parseInt(hex, 16));
    return unreserved.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
  });

  return withCanonicalEscapes.replace(/[^\x00-\x7F]/gu, (character) =>
    Array.from(new TextEncoder().encode(character), (byte) =>
      `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join(""),
  );
}

function robotsPatternMatches(path: string, rule: string): boolean {
  if (!rule) return false;
  const normalizedPath = normalizeRobotsComparisonValue(path);
  const normalizedRule = normalizeRobotsComparisonValue(rule);
  const anchored = normalizedRule.endsWith("$");
  const pattern = anchored ? normalizedRule.slice(0, -1) : normalizedRule;

  // A robots.txt path pattern has only one wildcard metacharacter: "*".
  // Avoid turning untrusted patterns into RegExp: repeated wildcards can
  // trigger exponential backtracking on otherwise short public URLs.
  let pathIndex = 0;
  let patternIndex = 0;
  let lastStarIndex = -1;
  let starMatchedThrough = 0;
  while (pathIndex < normalizedPath.length) {
    if (patternIndex === pattern.length && !anchored) return true;
    if (patternIndex < pattern.length && pattern[patternIndex] === normalizedPath[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      lastStarIndex = patternIndex++;
      starMatchedThrough = pathIndex;
    } else if (lastStarIndex >= 0) {
      patternIndex = lastStarIndex + 1;
      pathIndex = ++starMatchedThrough;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

/** Parses the supported, public robots directives without interpreting arbitrary content. */
export function parseRobotsTxt(value: string, origin: string): ParsedRobots {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  const sitemapUrls: URL[] = [];
  let sitemapQueryUnsupported = false;
  let current = { agents: [] as string[], rules: [] as RobotsRule[] };
  let currentHasRules = false;

  const flush = () => {
    if (current.agents.length > 0) groups.push(current);
    current = { agents: [], rules: [] };
    currentHasRules = false;
  };

  for (const rawLine of value.split(/\r\n|\r|\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const directiveValue = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      const sitemapUrl = sameOriginCrawlUrl(directiveValue, origin, origin, () => {
        sitemapQueryUnsupported = true;
      });
      if (sitemapUrl) sitemapUrls.push(sitemapUrl);
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
      // Robots product tokens match case-insensitively within the crawler name.
      // Prefer the longest matching token over a shorter one or the wildcard.
      return SITE_AUDIT_USER_AGENT.includes(agent) ? Math.max(best, agent.length) : best;
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
    sitemapQueryUnsupported,
  };
}

/** Applies longest-match robots rules; allow wins equal-length ties. */
export function isAllowedByRobots(url: URL, rules: RobotsRule[]): boolean {
  const target = `${url.pathname}${url.search}`;
  let winner: RobotsRule | undefined;
  let winnerSpecificity = -1;
  for (const rule of rules) {
    if (!robotsPatternMatches(target, rule.path)) continue;
    const specificity = normalizeRobotsComparisonValue(rule.path).replace(/%[0-9A-F]{2}/g, "x").length;
    if (!winner || specificity > winnerSpecificity || (specificity === winnerSpecificity && rule.allow)) {
      winner = rule;
      winnerSpecificity = specificity;
    }
  }
  return winner?.allow ?? true;
}

/** XML 1.0 Char production, for both literal characters and numeric references. */
function isValidXmlCharacter(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

/** Do not let Cheerio's XML recovery turn malformed entity references into sitemap URLs. */
function hasValidXmlEntities(text: string): boolean {
  const referencePattern = /&(?:amp|lt|gt|apos|quot|#(?:[0-9]+|x[0-9a-fA-F]+));/y;
  let offset = text.indexOf("&");
  while (offset !== -1) {
    referencePattern.lastIndex = offset;
    const match = referencePattern.exec(text);
    if (!match) return false;
    if (match[0].startsWith("&#")) {
      const digits = match[0].slice(2, -1);
      const codePoint = digits.startsWith("x")
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);
      if (!isValidXmlCharacter(codePoint)) return false;
    }
    offset = text.indexOf("&", referencePattern.lastIndex);
  }
  return true;
}

/** Namespace bindings compare decoded XML attribute values, not their source spellings. */
function normalizeXmlNamespaceUri(raw: string): string {
  const predefined: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&quot;": '"',
  };
  return raw.replace(/\r\n|[\r\n\t]|&(?:amp|lt|gt|apos|quot|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (reference) => {
    if (reference[0] !== "&") return " ";
    if (reference.startsWith("&#")) {
      const digits = reference.slice(2, -1);
      const codePoint = digits.startsWith("x")
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);
      return String.fromCodePoint(codePoint);
    }
    return predefined[reference];
  });
}

/** Cheerio recovers broken XML; reject malformed markup before using discovered URLs. */
function isWellFormedSitemapXml(value: string): boolean {
  // Character validity applies to comments, CDATA and markup too, not only text nodes.
  for (const character of value) {
    if (!isValidXmlCharacter(character.codePointAt(0)!)) return false;
  }
  const stack: string[] = [];
  const namespaceScopes: Map<string, string>[] = [];
  const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
  const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";
  const namePattern = /^[\p{L}_][\p{L}\p{N}_.:-]*$/u;
  const localNamePattern = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
  let position = 0;
  let roots = 0;
  while (position < value.length) {
    const start = value.indexOf("<", position);
    if (start === -1) {
      return stack.length === 0 && roots === 1 && (position === value.length || !value.slice(position).trim());
    }
    const text = value.slice(position, start);
    if ((stack.length === 0 && text.trim()) || text.includes("]]>") || !hasValidXmlEntities(text)) return false;

    if (value.startsWith("<!--", start)) {
      const end = value.indexOf("-->", start + 4);
      if (end === -1 || value.slice(start + 4, end).includes("--")) return false;
      position = end + 3;
      continue;
    }
    if (value.startsWith("<![CDATA[", start)) {
      if (!stack.length) return false;
      const end = value.indexOf("]]>", start + 9);
      if (end === -1) return false;
      position = end + 3;
      continue;
    }
    if (value.startsWith("<?", start)) {
      const end = value.indexOf("?>", start + 2);
      if (end === -1) return false;
      const instruction = value.slice(start + 2, end);
      const target = /^[^\s?]+/.exec(instruction)?.[0];
      if (!target || !namePattern.test(target)) return false;
      let data = instruction.slice(target.length);
      if (data && !/^[ \t\r\n]/.test(data)) return false;
      // The PI target "xml" is reserved for the initial declaration only.
      if (target?.toLowerCase() === "xml") {
        const atDocumentStart = start === 0 || (start === 1 && value.charCodeAt(0) === 0xfeff);
        if (target !== "xml" || !atDocumentStart || stack.length !== 0 || roots !== 0) return false;
        // XML declarations require version first, then optional encoding and standalone.
        const version = /^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')/.exec(data);
        if (!version) return false;
        data = data.slice(version[0].length);
        const encoding = /^[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*')/.exec(data);
        if (encoding) data = data.slice(encoding[0].length);
        const standalone = /^[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)')/.exec(data);
        if (standalone) data = data.slice(standalone[0].length);
        if (!/^[ \t\r\n]*$/.test(data)) return false;
      }
      position = end + 2;
      continue;
    }
    if (value.startsWith("<!", start)) return false;

    let end = start + 1;
    let quote: string | undefined;
    for (; end < value.length; end++) {
      const character = value[end];
      if (quote) {
        // XML attributes may use &lt;, but never an unescaped '<'.
        if (character === "<") return false;
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "<") {
        return false;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= value.length || quote) return false;
    let content = value.slice(start + 1, end).trim();
    if (content.startsWith("/")) {
      const closingName = content.slice(1).trim();
      if (!namePattern.test(closingName) || stack.pop() !== closingName) return false;
      namespaceScopes.pop();
    } else {
      const empty = content.endsWith("/");
      if (empty) content = content.slice(0, -1).trimEnd();
      const match = /^([^\s]+)([\s\S]*)$/.exec(content);
      if (!match || !namePattern.test(match[1])) return false;
      // XML attributes require a name and a quoted value, unlike permissive HTML.
      let attributes = match[2];
      const seenAttributes = new Set<string>();
      const namespaceDeclarations = new Map<string, string>();
      while (attributes.trim()) {
        const attribute = /^\s+([\p{L}_][\p{L}\p{N}_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(attributes);
        if (!attribute || seenAttributes.has(attribute[1]) || !hasValidXmlEntities(attribute[2] ?? attribute[3])) return false;
        seenAttributes.add(attribute[1]);
        if (attribute[1] === "xmlns") {
          const uri = normalizeXmlNamespaceUri(attribute[2] ?? attribute[3]);
          if (uri === xmlNamespace || uri === xmlnsNamespace) return false;
        } else if (attribute[1].startsWith("xmlns:")) {
          const prefix = attribute[1].slice(6);
          const uri = normalizeXmlNamespaceUri(attribute[2] ?? attribute[3]);
          if (!localNamePattern.test(prefix) || prefix === "xmlns" || !uri ||
              uri === xmlnsNamespace || (prefix === "xml") !== (uri === xmlNamespace)) return false;
          namespaceDeclarations.set(prefix, uri);
        }
        attributes = attributes.slice(attribute[0].length);
      }
      const bindings = new Map<string, string>(
        namespaceScopes[namespaceScopes.length - 1] ?? [["xml", xmlNamespace]],
      );
      for (const [prefix, uri] of namespaceDeclarations) bindings.set(prefix, uri);
      const hasBoundPrefix = (name: string): boolean => {
        const separator = name.indexOf(":");
        if (separator === -1) return true;
        return localNamePattern.test(name.slice(0, separator)) &&
          localNamePattern.test(name.slice(separator + 1)) &&
          bindings.has(name.slice(0, separator));
      };
      if (!hasBoundPrefix(match[1])) return false;
      const expandedAttributes = new Set<string>();
      for (const name of seenAttributes) {
        if (name === "xmlns" || name.startsWith("xmlns:")) continue;
        if (!hasBoundPrefix(name)) return false;
        // Different prefixes may identify the same attribute after namespace resolution.
        const separator = name.indexOf(":");
        const namespace = separator === -1 ? "" : bindings.get(name.slice(0, separator))!;
        const localName = separator === -1 ? name : name.slice(separator + 1);
        const expandedName = JSON.stringify([namespace, localName]);
        if (expandedAttributes.has(expandedName)) return false;
        expandedAttributes.add(expandedName);
      }
      if (!stack.length && ++roots > 1) return false;
      if (!empty) {
        stack.push(match[1]);
        namespaceScopes.push(bindings);
      }
    }
    position = end + 1;
  }
  return roots === 1 && stack.length === 0;
}

function parseSitemapXml(value: string, baseUrl: string, origin: string): ParsedSitemap {
  if (/<\s*!(?:doctype|entity)\b/i.test(value)) {
    return { pageUrls: [], childSitemaps: [], invalid: true };
  }

  if (!isWellFormedSitemapXml(value)) {
    return { pageUrls: [], childSitemaps: [], invalid: true };
  }

  try {
    const $ = cheerio.load(value, { xmlMode: true });
    const pageUrls: URL[] = [];
    const childSitemaps: URL[] = [];
    const seenPages = new Set<string>();
    const seenSitemaps = new Set<string>();
    let queryUnsupported = false;
    const sitemapCrawlUrl = (value: string): URL | undefined =>
      sameOriginCrawlUrl(value, baseUrl, origin, () => { queryUnsupported = true; });

    const documentElement = $.root().children().first();
    // Cheerio's tagName property uppercases names even in XML mode; the node name preserves XML case.
    const documentElementName = documentElement.get(0)?.name ?? "";
    const documentElementLocalName = documentElementName
      .slice(documentElementName.indexOf(":") + 1);

    if (documentElementLocalName === "rss" && documentElement.attr("version") === "2.0") {
      $("channel > item > link").each((_index, element) => {
        const url = sitemapCrawlUrl($(element).text().trim());
        if (url) addUniqueUrl(pageUrls, seenPages, url);
      });
      return { pageUrls, childSitemaps, invalid: false, queryUnsupported };
    }

    const documentElementSeparator = documentElementName.indexOf(":");
    const documentElementPrefix = documentElementSeparator >= 0
      ? documentElementName.slice(0, documentElementSeparator)
      : "";
    const documentElementNamespaceDeclaration = documentElementPrefix
      ? `xmlns:${documentElementPrefix}`
      : "xmlns";
    const documentElementNamespace = documentElement.attr(documentElementNamespaceDeclaration)?.trim();

    if (documentElementLocalName === "feed" && documentElementNamespace === ATOM_XML_NAMESPACE) {
      const atomElements = $("*").filter((_index, element) => {
        if (element.type !== "tag") return false;
        const qualifiedName = element.name;
        const separator = qualifiedName.indexOf(":");
        const prefix = separator >= 0 ? qualifiedName.slice(0, separator) : "";
        const declaration = prefix ? `xmlns:${prefix}` : "xmlns";
        let current = $(element);

        while (current.length > 0) {
          const declaredNamespace = current.attr(declaration);
          if (declaredNamespace !== undefined) {
            return declaredNamespace.trim() === ATOM_XML_NAMESPACE;
          }
          current = current.parent();
        }
        return false;
      });
      const atomNodes = new Set(atomElements.toArray());

      atomElements.each((_index, element) => {
        if (element.type !== "tag") return;
        const qualifiedName = element.name;
        const localName = qualifiedName.slice(qualifiedName.indexOf(":") + 1);
        if (localName !== "link") return;

        const parent = $(element).parent().get(0);
        if (!parent || !atomNodes.has(parent)) return;
        const parentName = parent.name;
        const parentLocalName = parentName.slice(parentName.indexOf(":") + 1);
        if (parentLocalName !== "entry") return;

        const rel = $(element).attr("rel")?.trim().toLowerCase();
        if (rel && rel !== "alternate") return;
        const url = sitemapCrawlUrl($(element).attr("href")?.trim() ?? "");
        if (url) addUniqueUrl(pageUrls, seenPages, url);
      });
      return { pageUrls, childSitemaps, invalid: false, queryUnsupported };
    }

    const legacyUnnamespacedDocument = !documentElementName.includes(":")
      && documentElement.attr("xmlns") === undefined;
    if (!["urlset", "sitemapindex"].includes(documentElementLocalName)
      || (!legacyUnnamespacedDocument && documentElementNamespace !== SITEMAP_XML_NAMESPACE)) {
      return { pageUrls: [], childSitemaps: [], invalid: true };
    }
    const protocolElements = $("*").filter((_index, element) => {
      if (element.type !== "tag") return false;
      const qualifiedName = element.name;
      const separator = qualifiedName.indexOf(":");
      const prefix = separator >= 0 ? qualifiedName.slice(0, separator) : "";
      const declaration = prefix ? `xmlns:${prefix}` : "xmlns";
      let current = $(element);

      while (current.length > 0) {
        const declaredNamespace = current.attr(declaration);
        if (declaredNamespace !== undefined) {
          return declaredNamespace.trim() === SITEMAP_XML_NAMESPACE;
        }
        current = current.parent();
      }

      // Keep accepting the repository's historical unnamespaced sitemap fixtures,
      // but do not treat unqualified elements inside a prefixed XML document as Sitemap elements.
      return prefix === "" && legacyUnnamespacedDocument;
    });
    const protocolNodes = new Set(protocolElements.toArray());

    protocolElements.each((_index, element) => {
      if (element.type !== "tag") return;
      const qualifiedName = element.name;
      const localName = qualifiedName.slice(qualifiedName.indexOf(":") + 1);
      if (localName !== "loc") return;

      const parent = $(element).parent().get(0);
      const grandparent = parent ? $(parent).parent().get(0) : undefined;
      if (!parent || !grandparent || !protocolNodes.has(parent) || !protocolNodes.has(grandparent)) return;

      const parentName = parent.name;
      const grandparentName = grandparent.name;
      const parentLocalName = parentName.slice(parentName.indexOf(":") + 1);
      const grandparentLocalName = grandparentName.slice(grandparentName.indexOf(":") + 1);
      const url = sitemapCrawlUrl($(element).text().trim());
      if (!url) return;

      if (parentLocalName === "url" && grandparentLocalName === "urlset") {
        addUniqueUrl(pageUrls, seenPages, url);
      } else if (parentLocalName === "sitemap" && grandparentLocalName === "sitemapindex") {
        addUniqueUrl(childSitemaps, seenSitemaps, url);
      }
    });
    return { pageUrls, childSitemaps, invalid: false, queryUnsupported };
  } catch {
    return { pageUrls: [], childSitemaps: [], invalid: true };
  }
}

function parseTextSitemap(value: string, baseUrl: string, origin: string): ParsedSitemap {
  const pageUrls: URL[] = [];
  const seenPages = new Set<string>();
  let queryUnsupported = false;
  for (const line of value.split(/\r\n|\n|\r/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      return { pageUrls: [], childSitemaps: [], invalid: true };
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return { pageUrls: [], childSitemaps: [], invalid: true };
    }
    const url = sameOriginCrawlUrl(candidate, baseUrl, origin, () => { queryUnsupported = true; });
    if (url) addUniqueUrl(pageUrls, seenPages, url);
  }
  return { pageUrls, childSitemaps: [], invalid: false, queryUnsupported };
}

function parseSitemapRepresentation(
  value: string,
  contentType: string,
  baseUrl: string,
  origin: string,
): ParsedSitemap {
  return contentType === "text/plain"
    ? parseTextSitemap(value, baseUrl, origin)
    : parseSitemapXml(value, baseUrl, origin);
}

function robotsHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof PublicHtmlFetchError) || error.code !== "http_status") return undefined;
  return error.status;
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
        allowGzipSitemap: true,
      });
      const representationType = new URL(fetched.finalUrl).pathname.toLowerCase().endsWith(".txt.gz")
        ? "text/plain" : fetched.contentType;
      const parsed = parseSitemapRepresentation(fetched.text, representationType, fetched.finalUrl, origin);
      if (parsed.invalid) {
        discoveryError ??= "sitemap_invalid";
        continue;
      }
      sitemapUrl ??= fetched.finalUrl;
      if (parsed.queryUnsupported) discoveryError ??= "sitemap_query_unsupported";

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
      maxRedirects: ROBOTS_MAX_REDIRECTS,
      allowCrossOriginRedirects: true,
    });
    robots = parseRobotsTxt(fetched.text, origin);
  } catch (cause) {
    const status = robotsHttpStatus(cause);
    const emptySuccessfulRobots = cause instanceof PublicHtmlFetchError && cause.code === "empty";
    if (emptySuccessfulRobots || (status !== undefined && status >= 400 && status <= 499 && status !== 429)) {
      robots = { rules: [], sitemapUrls: [], sitemapQueryUnsupported: false };
    } else if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
      return {
        rules: [{ allow: false, path: "/" }],
        pageUrls: [],
        discovery: "root_only",
        discoveryError: "robots_unavailable",
        truncated: false,
      };
    } else {
      return {
        rules: [{ allow: false, path: "/" }],
        pageUrls: [],
        discovery: "root_only",
        discoveryError: "robots_unavailable",
        truncated: false,
      };
    }
  }

  const fallbackSitemap = new URL("/sitemap.xml", origin);
  const sitemapUrls = robots.sitemapUrls.length > 0
    ? robots.sitemapUrls
    : robots.sitemapQueryUnsupported ? [] : [fallbackSitemap];
  const discovered = await discoverFromSitemaps(origin, sitemapUrls);
  const discoveryError = discovered.discoveryError ?? (robots.sitemapQueryUnsupported ? "sitemap_query_unsupported" : undefined);
  return {
    rules: robots.rules,
    pageUrls: discovered.pageUrls,
    discovery: discovered.pageUrls.length > 0 ? (discoveryError ? "partial" : "sitemap") : "root_only",
    sitemapUrl: discovered.sitemapUrl,
    discoveryError,
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
  if (cause.code === "robots") return "robots_redirect_blocked";
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

async function auditFetchedPage(
  fetched: FetchedPublicHtml,
): Promise<SiteAuditPageSummary & { findings: SiteAuditFinding[]; findingsTruncated: boolean }> {
  const seo = auditSeoMetadata(fetched.html, { xRobotsTag: fetched.xRobotsTag });
  const schema = validateSchemaMarkup(fetched.html);
  let htmlMessages: ValidationMessage[] = [];
  let htmlCounts = { error: 0, warning: 0, info: 0 };
  let htmlValidationStatus: HtmlValidationStatus = "completed";

  try {
    const html = await validateHtmlDetailed(fetched.html, fetched.contentType);
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
      code: issue.code,
      severity: issue.severity,
      category: issue.category,
      message: compactMessage(issue.message),
    })),
    ...schema.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      category: issue.category,
      message: compactMessage(issue.message),
    })),
  ];
  const seoErrors = seo.counts.error;
  const seoWarnings = seo.counts.warning;
  const schemaErrors = schema.counts.error;
  const schemaWarnings = schema.counts.warning;
  const findingsTruncated =
    htmlCounts.error + htmlCounts.warning > htmlMessages.filter((message) => message.type !== "info").length
    || seoErrors + seoWarnings > seo.issues.filter((issue) => issue.severity !== "info").length
    || schemaErrors + schemaWarnings > schema.issues.filter((issue) => issue.severity !== "info").length;
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
    findingsTruncated,
  };
}

async function auditPage(url: URL, origin: string, robotsRules: RobotsRule[], prefetched?: FetchedPublicHtml) {
  try {
    const fetched = prefetched ?? await fetchPublicHtml(url.href, {
      allowedOrigin: origin,
      allowRedirect: (target) => isAllowedByRobots(target, robotsRules),
    });
    return await auditFetchedPage(fetched);
  } catch (cause) {
    const failureCode = pageFailureCode(cause);
    const status: SitePageStatus = failureCode === "scope_redirect_blocked" || failureCode === "robots_redirect_blocked"
      ? "skipped"
      : "failed";
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
      findingsTruncated: false,
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

function groupFindings(
  pages: Array<SiteAuditPageSummary & { findings: SiteAuditFinding[]; findingsTruncated: boolean }>,
) {
  const groups = new Map<string, GroupAccumulator>();
  let truncated = pages.some((page) => page.findingsTruncated);
  for (const page of pages) {
    for (const finding of page.findings) {
      if (finding.severity === "info") continue;
      const identity = finding.code ? `code:${finding.code}` : `message:${finding.message}`;
      const key = `${finding.severity}\u0000${finding.category}\u0000${identity}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          code: finding.code,
          severity: finding.severity,
          category: finding.category,
          message: finding.code?.startsWith("schema.jsonld.")
            ? finding.message.replace(/^JSON-LD block #\d+ /, "A JSON-LD block ")
            : finding.message,
          pages: new Set<string>(),
        };
        groups.set(key, group);
      }
      group.pages.add(page.fetched_url ?? page.url);
    }
  }

  const rankedGroups = Array.from(groups.values())
    .map((group) => ({
      code: group.code,
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
  if (rankedGroups.length > SITE_AUDIT_MAX_ISSUE_GROUPS) truncated = true;
  return {
    issueGroups: rankedGroups.slice(0, SITE_AUDIT_MAX_ISSUE_GROUPS),
    truncated,
  };
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

  // Fetch robots.txt before requesting any HTML from the initial site.
  // Never follow an initial cross-origin redirect without a separate robots policy.
  const initialUrl = toPublicHttpUrl(options.siteUrl);
  if (!initialUrl) {
    throw new PublicHtmlFetchError("blocked_url", "Use a public HTTP(S) URL without credentials or a custom port.");
  }
  let origin = initialUrl.origin;
  let discovery = await discoverSitePages(origin);
  const seed = isAllowedByRobots(initialUrl, discovery.rules)
    ? await fetchPublicHtml(options.siteUrl, {
        allowRedirect: async (target) => {
          if (target.origin === origin) return isAllowedByRobots(target, discovery.rules);
          // Canonical-host redirects need the destination's own robots policy
          // before any HTML is requested from that origin.
          const targetDiscovery = await discoverSitePages(target.origin);
          if (!isAllowedByRobots(target, targetDiscovery.rules)) return false;
          origin = target.origin;
          discovery = targetDiscovery;
          return true;
        },
      })
    : undefined;
  const seedUrl = sameOriginCrawlUrl(seed?.finalUrl ?? initialUrl.href, origin, origin);
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

  // Offset pagination is only safe against the same ordered discovery snapshot.
  // Hash the eligible URL sequence, not just its length: insertions and reorderings
  // otherwise cause silent duplicates or skipped pages on later batches.
  const snapshotBytes = new TextEncoder().encode(JSON.stringify({
    origin,
    urls: eligible.map((url) => url.href),
  }));
  const snapshotHash = await crypto.subtle.digest("SHA-256", snapshotBytes);
  const discoveryFingerprint = Array.from(new Uint8Array(snapshotHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (options.pageOffset > 0 && options.expectedDiscoveryFingerprint !== discoveryFingerprint) {
    throw new Error("Stale site audit continuation: restart with page_offset 0 and use its discovery fingerprint.");
  }
  if (options.pageOffset > 0 && options.pageOffset >= eligible.length) {
    throw new Error("Invalid site audit continuation: page_offset is at or beyond the discovered eligible pages; restart with page_offset 0.");
  }

  const pageOffset = options.pageOffset;
  const selected = eligible.slice(pageOffset, pageOffset + options.maxPages);
  const prefetchedKey = crawlKey(seedUrl);
  const auditedPages = await mapWithCrawlConcurrency(selected, (candidate) =>
    auditPage(candidate, origin, discovery.rules, crawlKey(candidate) === prefetchedKey ? seed : undefined),
  );
  const pages = auditedPages.map(({ findings: _findings, findingsTruncated: _findingsTruncated, ...page }) => page);
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
    pages_skipped_robots: pagesSkippedRobots + pages.filter((page) => page.failure_code === "robots_redirect_blocked").length,
    truncated: discovery.truncated || hasMorePages,
    discovery_fingerprint: discoveryFingerprint,
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
