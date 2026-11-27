/**
 * V05 bounded sitemap inventory and indexability cross-checks.
 * No network, crawler identity, storage or source URLs in the output.
 * XML input is parsed strictly enough to reject malformed structures and
 * never expands external entities. Full-site coverage is never inferred
 * unless the caller supplies a complete document/crawl inventory.
 */
import { load } from "cheerio";
import { safeVariantLabel } from "./url-variants.js";

export const MAX_SITEMAP_DOCUMENTS = 8;
export const MAX_SITEMAP_DOCUMENT_BYTES = 512_000;
export const MAX_SITEMAP_TOTAL_BYTES = 1_500_000;
export const MAX_SITEMAP_URLS = 2_000;
export const MAX_SITEMAP_DISCOVERED = 500;
export const MAX_SITEMAP_PAGE_OBSERVATIONS = 250;
export const MAX_SITEMAP_FINDINGS = 32;
export const MAX_SITEMAP_URL_BYTES = 2_048;
const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const enc = new TextEncoder();

export const SITEMAP_DOCUMENT_KINDS = [
  "urlset", "sitemapindex", "text", "invalid", "unsupported",
] as const;
export const SITEMAP_FINDING_CODES = [
  "sitemap_http_error", "xml_malformed", "unsupported_format",
  "missing_loc", "invalid_loc", "external_loc", "out_of_scope_loc",
  "duplicate_loc", "invalid_lastmod", "future_lastmod",
  "conflicting_lastmod", "lastmod_vs_observed_change",
  "sitemap_child_missing", "sitemap_unlisted_child",
  "sitemap_cycle", "sitemap_inventory_truncated",
  "sitemap_page_not_discovered", "discovered_page_not_sitemapped",
  "sitemap_url_http_error", "sitemap_url_redirect",
  "sitemap_url_noindex", "sitemap_url_robots_blocked",
  "sitemap_url_noncanonical", "observed_page_not_in_sitemap",
  "unverified_indexability", "unverified_coverage",
] as const;
export type SitemapKind = typeof SITEMAP_DOCUMENT_KINDS[number];
export type SitemapFindingCode = typeof SITEMAP_FINDING_CODES[number];

export interface SitemapInputDocument {
  sitemap_url: string;
  content: string;
  content_type?: "application/xml" | "text/xml" | "text/plain";
  status_code?: number;
}
export interface SitemapPageObservation {
  url: string;
  status_code?: number;
  canonical_url?: string;
  noindex?: boolean;
  robots_allowed?: boolean;
  /** Independently observed significant content modification time, if known. */
  modified_at?: string;
}
export interface SitemapInventoryInput {
  site_url: string;
  documents: SitemapInputDocument[];
  discovered_urls?: string[];
  page_observations?: SitemapPageObservation[];
  /** Optional explicit completeness declaration for caller-supplied sitemap docs. */
  documents_complete?: boolean;
  /** Optional explicit completeness declaration for independent discovered URLs. */
  discovered_complete?: boolean;
  /** Optional observation clock; defaults to UTC now in live/normal calls. */
  observed_at?: string;
}
export interface SitemapDocumentReport {
  document: number;
  kind: SitemapKind;
  status_code?: number;
  entries_seen: number;
  valid_url_entries: number;
  child_sitemaps: number;
  invalid_entries: number;
  external_entries: number;
  duplicate_entries: number;
  lastmod_present: number;
  lastmod_invalid: number;
  lastmod_future: number;
  truncated: boolean;
}
export interface SitemapFinding {
  document: number;
  entry?: number;
  severity: "warning" | "info";
  code: SitemapFindingCode;
  message: string;
}
export interface SitemapInventoryReview {
  scope: "caller_supplied_sitemap_evidence" | "live_public_sitemap_sample";
  documents_observed: number;
  documents_complete: boolean;
  discovered_complete: boolean;
  inventory_complete: boolean;
  documents_truncated: boolean;
  total_entries_seen: number;
  distinct_sitemap_urls: number;
  distinct_page_urls: number;
  distinct_child_sitemaps: number;
  missing_child_documents: number;
  duplicate_url_entries: number;
  invalid_url_entries: number;
  external_url_entries: number;
  lastmod_values_seen: number;
  lastmod_invalid_count: number;
  lastmod_future_count: number;
  lastmod_conflicting_count: number;
  independently_discovered_urls: number;
  discovered_in_sitemaps: number;
  discovered_missing_from_sitemaps: number;
  sitemap_urls_not_in_discovery: number;
  page_observations: number;
  sitemap_urls_with_page_evidence: number;
  status_conflicts: number;
  noindex_conflicts: number;
  robots_conflicts: number;
  canonical_conflicts: number;
  lastmod_observation_conflicts: number;
  known_indexability_conflicts: number;
  unknown_page_indexability: number;
  coverage_limited: true;
  limitations: string[];
  documents: SitemapDocumentReport[];
  total_findings: number;
  findings: SitemapFinding[];
  findings_truncated: boolean;
  error?: string;
}

type ParsedEntry = { url: URL; document: number; entry: number; lastmod?: number; lastmodValid: boolean };
type ParsedDocument = {
  report: SitemapDocumentReport;
  entries: ParsedEntry[];
  children: ParsedEntry[];
  rootUrl?: URL;
};
const limits = [
  "Bounded sitemap documents are samples, not proof of complete site inventory, crawl coverage or Google indexing.",
  "Sitemap inclusion recommends canonical discovery; actual crawl/index selection and historical fetches are not verified.",
  "Date conflicts depend on caller-supplied independent modification evidence; equal dates alone are not incorrect.",
  "Only XML urlset/index and plain-text sitemap entries are assessed here; RSS/Atom feeds require a separate export.",
];

function bytes(v: string): number { return enc.encode(v).byteLength; }
function safeUrl(value: unknown, allowQuery = true): URL | undefined {
  if (typeof value !== "string" || !value || bytes(value) > MAX_SITEMAP_URL_BYTES ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/u.test(value) ||
    value.includes("#")) return undefined;
  const parsed = safeVariantLabel(value);
  if (!parsed) return undefined;
  const url = new URL(parsed);
  if (!allowQuery && (url.search || value.includes("?"))) return undefined;
  return url;
}
function strictDate(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length < 10 || value.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) {
    return undefined;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The first safe same-origin robots.txt Sitemap declaration, if present. */
export function sitemapFromRobotsTxt(siteUrl: string, robotsText: string): string | undefined {
  const site = safeUrl(siteUrl, false);
  if (!site || typeof robotsText !== "string" || bytes(robotsText) > 64_000) return undefined;
  for (const line of robotsText.split(/\r\n|\r|\n/u)) {
    const match = /^\s*sitemap\s*:\s*(\S+)(?:\s+#.*)?\s*$/iu.exec(line);
    if (!match) continue;
    const found = safeUrl(match[1], false);
    if (found && found.origin === site.origin) return found.href;
  }
  return undefined;
}

/**
 * Bounded XML well-formedness gate, independent of Cheerio recovery.
 * Rejects DTD/entity declarations, unescaped entities, bad quoted attributes,
 * nesting errors, extra roots and unbound-prefixed element names.
 */
function isWellFormedXml(source: string): boolean {
  // XML 1.0 Char production applies to literals everywhere, including comments and CDATA.
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(source)) return false;
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(source)) return false;
  const stack: string[] = [];
  const bindings: Array<Set<string>> = [];
  let cursor = 0;
  let roots = 0;
  const nameRx = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
  function entitiesValid(text: string): boolean {
    const re = /&(?:amp|lt|gt|apos|quot|#(?:[0-9]{1,8}|x[0-9a-fA-F]{1,6}));/gu;
    let invalidNumericReference = false;
    const without = text.replace(re, (entity) => {
      if (entity.startsWith("&#")) {
        const hex = entity[2] === "x";
        const point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        // XML 1.0 Char production excludes NUL, surrogates and out-of-range code points.
        if (!(point === 0x9 || point === 0xA || point === 0xD ||
          (point >= 0x20 && point <= 0xD7FF) ||
          (point >= 0xE000 && point <= 0xFFFD) ||
          (point >= 0x10000 && point <= 0x10FFFF))) {
          invalidNumericReference = true;
        }
      }
      return "";
    });
    return !invalidNumericReference && !without.includes("&");
  }
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) {
      const remaining = source.slice(cursor);
      return (stack.length > 0 || remaining.trim() === "") && entitiesValid(remaining)
        && stack.length === 0 && roots === 1;
    }
    const plain = source.slice(cursor, start);
    if ((!stack.length && plain.trim()) || plain.includes("]]>") || !entitiesValid(plain)) return false;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0 || source.slice(start + 4, end).includes("--")) return false;
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", start)) {
      if (!stack.length) return false;
      const end = source.indexOf("]]>", start + 9);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", start)) {
      const end = source.indexOf("?>", start + 2);
      if (end < 0 || source.slice(start + 2, end).includes("<")) return false;
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", start)) return false;
    let end = start + 1;
    let quote = "";
    for (; end < source.length; end++) {
      const c = source[end];
      if (quote) {
        if (c === "<") return false;
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "<") return false;
      else if (c === ">") break;
    }
    if (end === source.length || quote) return false;
    let tag = source.slice(start + 1, end).trim();
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (!nameRx.test(name) || stack.pop() !== name) return false;
      bindings.pop();
    } else {
      const self = tag.endsWith("/");
      if (self) tag = tag.slice(0, -1).trimEnd();
      const first = /^([^\s]+)([\s\S]*)$/u.exec(tag);
      if (!first || !nameRx.test(first[1])) return false;
      let attrs = first[2];
      const seen = new Set<string>();
      const scope = new Set(bindings.at(-1) ?? ["xml"]);
      while (attrs.trim()) {
        const a = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(attrs);
        if (!a || seen.has(a[1]) || !entitiesValid(a[2] ?? a[3])) return false;
        seen.add(a[1]);
        if (a[1].startsWith("xmlns:")) scope.add(a[1].slice(6));
        attrs = attrs.slice(a[0].length);
      }
      const prefix = first[1].includes(":") ? first[1].split(":")[0] : undefined;
      if (prefix && !scope.has(prefix)) return false;
      if (!stack.length && ++roots > 1) return false;
      if (!self) {
        stack.push(first[1]);
        bindings.push(scope);
      }
    }
    cursor = end + 1;
  }
  return stack.length === 0 && roots === 1;
}

export function emptySitemapInventoryReview(
  scope: SitemapInventoryReview["scope"] = "caller_supplied_sitemap_evidence",
): SitemapInventoryReview {
  return {
    scope, documents_observed: 0, documents_complete: false,
    discovered_complete: false, inventory_complete: false,
    documents_truncated: false, total_entries_seen: 0,
    distinct_sitemap_urls: 0, distinct_page_urls: 0,
    distinct_child_sitemaps: 0, missing_child_documents: 0,
    duplicate_url_entries: 0, invalid_url_entries: 0,
    external_url_entries: 0, lastmod_values_seen: 0,
    lastmod_invalid_count: 0, lastmod_future_count: 0,
    lastmod_conflicting_count: 0, independently_discovered_urls: 0,
    discovered_in_sitemaps: 0, discovered_missing_from_sitemaps: 0,
    sitemap_urls_not_in_discovery: 0, page_observations: 0,
    sitemap_urls_with_page_evidence: 0, status_conflicts: 0,
    noindex_conflicts: 0, robots_conflicts: 0,
    canonical_conflicts: 0, lastmod_observation_conflicts: 0,
    known_indexability_conflicts: 0, unknown_page_indexability: 0,
    coverage_limited: true, limitations: limits, documents: [],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function analyzeSitemapInventory(
  input: SitemapInventoryInput,
  scope: SitemapInventoryReview["scope"] = "caller_supplied_sitemap_evidence",
): SitemapInventoryReview {
  const site = safeUrl(input?.site_url, false);
  if (!site || !Array.isArray(input.documents) ||
    input.documents.length < 1 || input.documents.length > MAX_SITEMAP_DOCUMENTS) {
    throw new Error("Supply a safe site URL and one to eight observed sitemap documents.");
  }
  const documents = input.documents;
  const discovered = input.discovered_urls ?? [];
  const pages = input.page_observations ?? [];
  if (!Array.isArray(discovered) || discovered.length > MAX_SITEMAP_DISCOVERED ||
    !Array.isArray(pages) || pages.length > MAX_SITEMAP_PAGE_OBSERVATIONS ||
    (input.documents_complete !== undefined && typeof input.documents_complete !== "boolean") ||
    (input.discovered_complete !== undefined && typeof input.discovered_complete !== "boolean")) {
    throw new Error("Sitemap coverage observations exceed bounds.");
  }
  const now = input.observed_at === undefined ? Date.now() : strictDate(input.observed_at);
  if (now === undefined) throw new Error("Observed clock must be a real ISO date.");
  const out = emptySitemapInventoryReview(scope);
  out.documents_observed = documents.length;
  out.documents_complete = input.documents_complete === true;
  out.discovered_complete = input.discovered_complete === true;

  function finding(document: number, code: SitemapFindingCode,
    severity: "warning" | "info", message: string, entry?: number) {
    out.total_findings++;
    if (out.findings.length < MAX_SITEMAP_FINDINGS) out.findings.push({
      document, code, severity, message, ...(entry ? { entry } : {}),
    });
    else out.findings_truncated = true;
  }
  const observedDocuments = new Set<string>();
  let totalBytes = 0;
  const allPages = new Map<string, ParsedEntry>();
  const allChildren = new Map<string, ParsedEntry>();
  const allDocumentResults: ParsedDocument[] = [];
  const dateByPage = new Map<string, number>();

  for (let docIdx = 0; docIdx < documents.length; docIdx++) {
    const doc = documents[docIdx];
    if (!doc || typeof doc.content !== "string" ||
      bytes(doc.content) > MAX_SITEMAP_DOCUMENT_BYTES) {
      throw new Error("Sitemap content must be bounded UTF-8 text.");
    }
    totalBytes += bytes(doc.content);
    if (totalBytes > MAX_SITEMAP_TOTAL_BYTES) {
      throw new Error("Combined sitemap content exceeded the total limit.");
    }
    const label = safeUrl(doc.sitemap_url, false);
    if (!label || label.origin !== site.origin || observedDocuments.has(label.href)) {
      throw new Error("Each supplied sitemap URL must be unique, same-origin and query-free.");
    }
    observedDocuments.add(label.href);
    const status = doc.status_code;
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error("Invalid sitemap HTTP status.");
    }
    const contentType = doc.content_type ?? "application/xml";
    if (!["application/xml", "text/xml", "text/plain"].includes(contentType)) {
      throw new Error("Unsupported content-type field.");
    }
    const report: SitemapDocumentReport = {
      document: docIdx + 1, kind: "invalid",
      ...(status === undefined ? {} : { status_code: status }),
      entries_seen: 0, valid_url_entries: 0, child_sitemaps: 0,
      invalid_entries: 0, external_entries: 0, duplicate_entries: 0,
      lastmod_present: 0, lastmod_invalid: 0, lastmod_future: 0,
      truncated: false,
    };
    const result: ParsedDocument = { report, entries: [], children: [], rootUrl: label };
    allDocumentResults.push(result);
    out.documents.push(report);

    if (status !== undefined && !(status >= 200 && status < 300)) {
      finding(docIdx + 1, "sitemap_http_error", "warning",
        "The supplied sitemap URL returned a non-2xx HTTP status.");
      report.kind = "invalid";
      continue;
    }
    let entries: Array<{ value: string; lastmod?: string; child: boolean }> = [];
    if (contentType === "text/plain") {
      report.kind = "text";
      entries = doc.content.split(/\r\n|\n|\r/u).map((value) =>
        ({ value: value.trim(), child: false })).filter((row) => row.value.length > 0);
    } else {
      if (!isWellFormedXml(doc.content)) {
        finding(docIdx + 1, "xml_malformed", "warning",
          "The supplied sitemap XML has malformed elements, declarations or entities.");
        continue;
      }
      try {
        const $ = load(doc.content, { xmlMode: true });
        const root = $.root().children().first();
        const rootName = root.get(0)?.name ?? "";
        const localName = rootName.slice(rootName.indexOf(":") + 1);
        const prefix = rootName.includes(":") ? rootName.split(":")[0] : "";
        const ns = root.attr(prefix ? "xmlns:" + prefix : "xmlns");
        if (!["urlset", "sitemapindex"].includes(localName) ||
          (ns !== SITEMAP_NS && ns !== undefined)) {
          report.kind = "unsupported";
          finding(docIdx + 1, "unsupported_format", "warning",
            "Only standard XML urlsets/indexes and plain-text sitemap documents are supported.");
          continue;
        }
        report.kind = localName as "urlset" | "sitemapindex";
        const tag = localName === "urlset" ? "url" : "sitemap";
        const childMode = localName === "sitemapindex";
        root.children().each((_i, item) => {
          if (item.type !== "tag" || item.name !== (prefix ? prefix + ":" + tag : tag)) return;
          const element = $(item);
          const loc = element.children().filter((_j, node) =>
            node.type === "tag" && node.name === (prefix ? prefix + ":loc" : "loc"));
          const lastmod = element.children().filter((_j, node) =>
            node.type === "tag" && node.name === (prefix ? prefix + ":lastmod" : "lastmod"));
          entries.push({
            value: loc.length === 1 ? loc.text().trim() : "",
            ...(lastmod.length === 1 ? { lastmod: lastmod.text().trim() } :
              lastmod.length > 1 ? { lastmod: "" } : {}),
            child: childMode,
          });
        });
      } catch {
        report.kind = "invalid";
        finding(docIdx + 1, "xml_malformed", "warning",
          "The sitemap XML could not be parsed safely.");
        continue;
      }
    }

    const inDocument = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      if (out.total_entries_seen >= MAX_SITEMAP_URLS) {
        report.truncated = true;
        out.documents_truncated = true;
        finding(docIdx + 1, "sitemap_inventory_truncated", "info",
          "The bounded URL entry limit was reached; remaining entries were not counted.");
        break;
      }
      report.entries_seen++;
      out.total_entries_seen++;
      const entry = entries[i];
      const pageUrl = safeUrl(entry.value, !entry.child);
      if (!pageUrl) {
        report.invalid_entries++;
        out.invalid_url_entries++;
        finding(docIdx + 1, entry.value ? "invalid_loc" : "missing_loc",
          "warning", "A sitemap entry has a missing, relative, malformed or unsupported URL.", i + 1);
        continue;
      }
      if (pageUrl.origin !== site.origin) {
        report.external_entries++;
        out.external_url_entries++;
        finding(docIdx + 1, "external_loc", "info",
          "A sitemap entry points outside the target site; cross-site authorization was not verified.", i + 1);
        continue;
      }
      if (entry.child && !pageUrl.pathname.startsWith(label.pathname.slice(
        0, label.pathname.lastIndexOf("/") + 1))) {
        finding(docIdx + 1, "out_of_scope_loc", "info",
          "A child sitemap is outside its index directory; cross-directory submission may need verification.", i + 1);
      }
      const store = entry.child ? allChildren : allPages;
      const repeatedHere = inDocument.has(pageUrl.href);
      const repeatedElsewhere = !repeatedHere && store.has(pageUrl.href);
      if (repeatedHere || repeatedElsewhere) {
        report.duplicate_entries++;
        out.duplicate_url_entries++;
        finding(docIdx + 1, "duplicate_loc", "info",
          repeatedHere
            ? "A URL is repeated within the same sitemap document."
            : "This URL also appeared in another supplied sitemap document.", i + 1);
      }
      inDocument.add(pageUrl.href);

      let lastmod: number | undefined;
      let lastmodValid = true;
      if (entry.lastmod !== undefined) {
        report.lastmod_present++;
        out.lastmod_values_seen++;
        lastmod = strictDate(entry.lastmod);
        if (lastmod === undefined) {
          lastmodValid = false;
          report.lastmod_invalid++;
          out.lastmod_invalid_count++;
          finding(docIdx + 1, "invalid_lastmod", "warning",
            "A sitemap lastmod is not a valid W3C date/datetime.", i + 1);
        } else if (lastmod > now + 24 * 60 * 60 * 1000) {
          report.lastmod_future++;
          out.lastmod_future_count++;
          finding(docIdx + 1, "future_lastmod", "warning",
            "A sitemap lastmod is more than a day in the future relative to the observation clock.", i + 1);
        }
      }
      const found: ParsedEntry = { url: pageUrl, document: docIdx + 1,
        entry: i + 1, lastmod, lastmodValid };
      store.set(pageUrl.href, store.get(pageUrl.href) ?? found);
      (entry.child ? result.children : result.entries).push(found);
      if (entry.child) report.child_sitemaps++;
      else report.valid_url_entries++;
      if (lastmod !== undefined && !entry.child) {
        const earlier = dateByPage.get(pageUrl.href);
        if (earlier !== undefined && earlier !== lastmod) {
          out.lastmod_conflicting_count++;
          finding(docIdx + 1, "conflicting_lastmod", "warning",
            "The same URL has different lastmod dates across observed sitemap entries.", i + 1);
        }
        dateByPage.set(pageUrl.href, lastmod);
      }
    }
  }

  out.distinct_page_urls = allPages.size;
  out.distinct_sitemap_urls = observedDocuments.size;
  out.distinct_child_sitemaps = allChildren.size;
  for (const child of allChildren.values()) {
    if (!observedDocuments.has(child.url.href)) {
      out.missing_child_documents++;
      finding(child.document, "sitemap_child_missing", "info",
        "An index references a child sitemap that was not supplied or fetched.", child.entry);
    }
  }
  out.inventory_complete = out.documents_complete &&
    !out.documents_truncated && out.missing_child_documents === 0 &&
    out.documents.every((doc) => doc.kind !== "invalid" && doc.kind !== "unsupported");
  if (input.documents_complete === true && out.missing_child_documents > 0) {
    out.inventory_complete = false;
  }

  const uniqueDiscovered = new Set<string>();
  for (const value of discovered) {
    const url = safeUrl(value);
    if (!url || url.origin !== site.origin) throw new Error("Discovered URL labels must be same-origin safe URLs.");
    uniqueDiscovered.add(url.href);
  }
  out.independently_discovered_urls = uniqueDiscovered.size;
  for (const value of uniqueDiscovered) {
    if (allPages.has(value)) out.discovered_in_sitemaps++;
    else {
      out.discovered_missing_from_sitemaps++;
      finding(0, "discovered_page_not_sitemapped", "info",
        "A caller-discovered page does not appear in the supplied sitemap URLs.");
    }
  }
  for (const url of allPages.keys()) {
    if (!uniqueDiscovered.has(url) && discovered.length) {
      out.sitemap_urls_not_in_discovery++;
    }
  }
  if (!out.inventory_complete || !out.discovered_complete) {
    finding(0, "unverified_coverage", "info",
      "No complete independent sitemap-and-discovery inventory is proven by these samples.");
  }

  const seenPageObservations = new Set<string>();
  for (const observed of pages) {
    if (!observed || typeof observed !== "object") {
      throw new Error("Invalid page observation.");
    }
    const pageUrl = safeUrl(observed.url);
    if (!pageUrl || pageUrl.origin !== site.origin ||
      seenPageObservations.has(pageUrl.href) ||
      (observed.status_code !== undefined &&
        (!Number.isInteger(observed.status_code) ||
        observed.status_code < 100 || observed.status_code > 599)) ||
      (observed.noindex !== undefined && typeof observed.noindex !== "boolean") ||
      (observed.robots_allowed !== undefined && typeof observed.robots_allowed !== "boolean")) {
      throw new Error("Page observations must be distinct safe same-origin records.");
    }
    seenPageObservations.add(pageUrl.href);
    const canonical = observed.canonical_url === undefined ? undefined : safeUrl(observed.canonical_url);
    if (observed.canonical_url !== undefined && !canonical) {
      throw new Error("Invalid observed canonical label.");
    }
    const modified = observed.modified_at === undefined ? undefined : strictDate(observed.modified_at);
    if (observed.modified_at !== undefined && modified === undefined) {
      throw new Error("Invalid independent modification timestamp.");
    }
    out.page_observations++;
    const listed = allPages.get(pageUrl.href);
    if (!listed) {
      finding(0, "observed_page_not_in_sitemap", "info",
        "An observed page is not among the supplied sitemap URL records.");
      continue;
    }
    out.sitemap_urls_with_page_evidence++;
    let conflicting = false;
    if (observed.status_code !== undefined) {
      if ([301, 302, 303, 307, 308].includes(observed.status_code)) {
        out.status_conflicts++;
        conflicting = true;
        finding(listed.document, "sitemap_url_redirect", "warning",
          "A sitemap-listed page returned a redirect instead of a direct 2xx response.", listed.entry);
      } else if (observed.status_code < 200 || observed.status_code >= 400) {
        out.status_conflicts++;
        conflicting = true;
        finding(listed.document, "sitemap_url_http_error", "warning",
          "A sitemap-listed page returned a non-indexable HTTP error or non-2xx state.", listed.entry);
      }
    }
    if (observed.noindex === true) {
      out.noindex_conflicts++;
      conflicting = true;
      finding(listed.document, "sitemap_url_noindex", "warning",
        "A sitemap-listed page has an independently observed noindex declaration.", listed.entry);
    }
    if (observed.robots_allowed === false) {
      out.robots_conflicts++;
      conflicting = true;
      finding(listed.document, "sitemap_url_robots_blocked", "warning",
        "A sitemap-listed page is marked robots-disallowed in supplied evidence.", listed.entry);
    }
    if (canonical && canonical.href !== pageUrl.href) {
      out.canonical_conflicts++;
      conflicting = true;
      finding(listed.document, "sitemap_url_noncanonical", "warning",
        "A sitemap-listed page declares a different preferred canonical URL.", listed.entry);
    }
    if (modified !== undefined && listed.lastmod !== undefined &&
      Math.abs(modified - listed.lastmod) > 24 * 60 * 60 * 1000) {
      out.lastmod_observation_conflicts++;
      finding(listed.document, "lastmod_vs_observed_change", "info",
        "The sitemap lastmod differs from independently supplied significant modification time.", listed.entry);
    }
    if (conflicting) out.known_indexability_conflicts++;
    if (observed.status_code === undefined || observed.noindex === undefined ||
      observed.robots_allowed === undefined || canonical === undefined) {
      out.unknown_page_indexability++;
    }
  }
  out.coverage_limited = true;
  return out;
}

/** Simple first-party accessor for live indexing of bounded child sitemap links. */
export function sitemapIndexChildUrls(input: SitemapInventoryInput): string[] {
  const review = analyzeSitemapInventory(input);
  if (review.documents_truncated) return [];
  const found: string[] = [];
  for (const doc of input.documents) {
    const safe = safeUrl(doc.sitemap_url, false);
    if (!safe || !isWellFormedXml(doc.content)) continue;
    const $ = load(doc.content, { xmlMode: true });
    const root = $.root().children().first();
    const rootName = root.get(0)?.name ?? "";
    if (!rootName.endsWith("sitemapindex")) continue;
    const prefix = rootName.includes(":") ? rootName.split(":")[0] : "";
    root.children().each((_i, el) => {
      if (el.type !== "tag" || el.name !== (prefix ? prefix + ":sitemap" : "sitemap")) return;
      const text = $(el).children().filter((_j, node) =>
        node.type === "tag" && node.name === (prefix ? prefix + ":loc" : "loc")).text().trim();
      const candidate = safeUrl(text, false);
      if (candidate && candidate.origin === safe.origin &&
        !found.includes(candidate.href)) found.push(candidate.href);
    });
  }
  return found.slice(0, 3);
}
