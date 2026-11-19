/**
 * P1-02: bounded hreflang and canonical cluster verification.
 *
 * Pure local/Worker logic over explicitly supplied static HTML observations.
 * Never fetch a referenced URL, infer Google's canonical choice, or echo
 * credentialed/query-bearing links.
 */
import * as cheerio from "cheerio";

export const MAX_MULTILINGUAL_PAGES = 16;
export const MAX_HREFLANG_LOCALES = 16;
export const MAX_HREFLANG_DECLARATIONS_SCANNED = 64;
export const MAX_MULTILINGUAL_FINDINGS = 12;
const MAX_PUBLIC_LABEL_CHARS = 256;
const MAX_HTML_CHARS = 250_000;
const MAX_EXAMPLE_URLS = 2;

export interface MultilingualReference {
  locale: string;
  url: string;
}

export type MultilingualCanonicalState = "missing" | "usable" | "ambiguous" | "unverifiable";

export interface MultilingualPageObservation {
  url: string;
  language?: string;
  canonical_state: MultilingualCanonicalState;
  canonical_url?: string;
  references: MultilingualReference[];
  invalid_declarations: number;
  repeated_locales: number;
  conflicting_locales: number;
  declarations_truncated: boolean;
  skipped: boolean;
}

export interface MultilingualFinding {
  code: string;
  severity: "error" | "warning";
  confidence: "observed" | "potential";
  message: string;
  example_urls: string[];
}

export interface MultilingualClusterAnalysis {
  scope: "sampled_pages_only";
  sampled_pages: number;
  eligible_pages: number;
  pages_with_alternates: number;
  locales_observed: number;
  unobserved_targets: number;
  invalid_declarations: number;
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: MultilingualFinding[];
  findings_truncated: boolean;
}

const REGION_CODES_RESERVED = new Set(["EU", "UN", "UK", "ZZ"]);
const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
const languages = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const scripts = new Intl.DisplayNames(["en"], { type: "script", fallback: "none" });

/** Deliberately require absolute, query-free references rather than masking changes in targets. */
export function safeMultilingualUrl(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_PUBLIC_LABEL_CHARS) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname || url.username || url.password || url.search || url.hash || url.port) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Accept Google's documented HTML hreflang forms: ISO 639-1 language, optional
 * ISO 15924 script, optional ISO 3166-1 alpha-2 region, and x-default.
 * ICU validates code membership; explicitly reject reserved pseudo-regions.
 */
export function normalizeHreflangLocale(raw: string): string | undefined {
  if (!raw || raw.length > 32) return undefined;
  if (raw.toLowerCase() === "x-default") return "x-default";
  const match = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i.exec(raw);
  if (!match) return undefined;
  const language = match[1].toLowerCase();
  const script = match[2];
  const region = match[3]?.toUpperCase();
  const scriptCode = script ? script.slice(0, 1).toUpperCase() + script.slice(1).toLowerCase() : "";
  if (!languages.of(language) || (scriptCode && !scripts.of(scriptCode)) ||
    (region && (REGION_CODES_RESERVED.has(region) || !regions.of(region)))) {
    return undefined;
  }
  return language + (scriptCode ? "-" + scriptCode : "") + (region ? "-" + region : "");
}

function relationIncludes(raw: string | undefined, token: string): boolean {
  return (raw ?? "").toLowerCase().split(/[\t\r\n\f ]+/).includes(token);
}

function documentLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const locale = new Intl.Locale(raw);
    if (!/^[a-z]{2}$/.test(locale.language)) return undefined;
    return locale.language +
      (locale.script ? "-" + locale.script.toLowerCase() : "");
  } catch {
    return undefined;
  }
}

function expectedLanguage(reference: string): string {
  const parts = reference.split("-");
  return parts[0] +
    (parts.length > 1 && parts[1].length === 4 ? "-" + parts[1].toLowerCase() : "");
}

function emptyPage(url: string): MultilingualPageObservation {
  return {
    url, canonical_state: "missing", references: [], invalid_declarations: 0,
    repeated_locales: 0, conflicting_locales: 0,
    declarations_truncated: false, skipped: true,
  };
}

/** Head-only observations from one already-authorized static HTML document. */
export function observeMultilingualPage(html: string, rawUrl: string): MultilingualPageObservation {
  const url = safeMultilingualUrl(rawUrl);
  if (!url || html.length > MAX_HTML_CHARS || !html) return emptyPage(url ?? "");
  const $ = cheerio.load(html);
  const language = documentLanguage($("html").first().attr("lang")?.trim());
  const canonicalLinks = $("head > link[rel]").toArray().filter((element) =>
    relationIncludes($(element).attr("rel"), "canonical"));
  let canonicalState: MultilingualCanonicalState = "missing";
  let canonicalUrl: string | undefined;
  if (canonicalLinks.length > 1) canonicalState = "ambiguous";
  else if (canonicalLinks.length === 1) {
    const link = $(canonicalLinks[0]);
    const hasAnnotations = ["hreflang", "media", "type", "lang"].some((attribute) =>
      link.attr(attribute) !== undefined);
    canonicalUrl = hasAnnotations ? undefined : safeMultilingualUrl(link.attr("href")?.trim() ?? "");
    canonicalState = canonicalUrl ? "usable" : "unverifiable";
  }

  const refs: MultilingualReference[] = [];
  const indexed = new Map<string, string>();
  let invalid = 0;
  let repeated = 0;
  let conflicting = 0;
  let overflow = false;
  const declarations = $("head > link[hreflang]").toArray();
  if (declarations.length > MAX_HREFLANG_DECLARATIONS_SCANNED) overflow = true;
  for (const element of declarations.slice(0, MAX_HREFLANG_DECLARATIONS_SCANNED)) {
    const link = $(element);
    const locale = normalizeHreflangLocale(link.attr("hreflang")?.trim() ?? "");
    const target = safeMultilingualUrl(link.attr("href")?.trim() ?? "");
    // Media/type annotations on the same link are not supported by Google.
    if (!relationIncludes(link.attr("rel"), "alternate") ||
      ["media", "type"].some((attribute) => link.attr(attribute) !== undefined) ||
      !locale || !target) {
      invalid += 1;
      continue;
    }
    const existing = indexed.get(locale);
    if (existing !== undefined) {
      if (existing === target) repeated += 1;
      else conflicting += 1;
      continue;
    }
    const localeCount = indexed.has("x-default") ? indexed.size - 1 : indexed.size;
    if (locale !== "x-default" && localeCount >= MAX_HREFLANG_LOCALES) {
      overflow = true;
      continue;
    }
    indexed.set(locale, target);
    refs.push({ locale, url: target });
  }
  return {
    url,
    ...(language ? { language } : {}),
    canonical_state: canonicalState,
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    references: refs,
    invalid_declarations: invalid,
    repeated_locales: repeated,
    conflicting_locales: conflicting,
    declarations_truncated: overflow,
    skipped: false,
  };
}

function findingOrder(finding: MultilingualFinding): number {
  return finding.severity === "error" ? 0 : 1;
}

function compareFindings(left: MultilingualFinding, right: MultilingualFinding): number {
  return findingOrder(left) - findingOrder(right)
    || left.code.localeCompare(right.code)
    || (left.example_urls[0] ?? "").localeCompare(right.example_urls[0] ?? "");
}

/**
 * Check at most 16 supplied pages. Missing unsampled targets are unknown,
 * not broken; the sample can include HTML from multiple authorized origins.
 */
export function analyzeMultilingualClusters(
  observations: readonly MultilingualPageObservation[],
  options: { sampledPages?: number; coverageLimited?: boolean } = {},
): MultilingualClusterAnalysis {
  if (observations.length > MAX_MULTILINGUAL_PAGES) {
    throw new Error("Multilingual cluster analysis accepts at most 16 pages.");
  }
  const sampledPages = options.sampledPages ?? observations.length;
  if (!Number.isSafeInteger(sampledPages) ||
      sampledPages < observations.length || sampledPages > MAX_MULTILINGUAL_PAGES) {
    throw new Error("sampledPages must be between observed count and sixteen.");
  }
  const byUrl = new Map<string, MultilingualPageObservation>();
  for (const observation of observations) {
    const url = safeMultilingualUrl(observation.url);
    if (!observation.skipped && url && !byUrl.has(url)) byUrl.set(url, observation);
  }
  const pages = [...byUrl.values()];
  const findings: MultilingualFinding[] = [];
  const seen = new Set<string>();
  let totalFindings = 0;
  function report(code: string, severity: MultilingualFinding["severity"],
    confidence: MultilingualFinding["confidence"], message: string, urls: string[]) {
    const examples = [...new Set(urls)].filter((url) => Boolean(safeMultilingualUrl(url)))
      .slice(0, MAX_EXAMPLE_URLS);
    const key = JSON.stringify([code, examples]);
    if (seen.has(key)) return;
    seen.add(key);
    totalFindings += 1;
    const next: MultilingualFinding = { code, severity, confidence, message, example_urls: examples };
    if (findings.length < MAX_MULTILINGUAL_FINDINGS) {
      findings.push(next);
    } else {
      // Bounded top-k selection: late high-priority errors must still displace
      // earlier warnings while preserving the full finding count.
      let worst = 0;
      for (let i = 1; i < findings.length; i += 1) {
        if (compareFindings(findings[i], findings[worst]) > 0) worst = i;
      }
      if (compareFindings(next, findings[worst]) < 0) findings[worst] = next;
    }
  }
  const allLocales = new Set<string>();
  const unseen = new Set<string>();
  let invalid = 0;
  let incomplete = sampledPages !== pages.length || Boolean(options.coverageLimited);
  for (const page of pages) {
    invalid += page.invalid_declarations;
    if (page.invalid_declarations > 0) {
      incomplete = true;
      report("multilingual.unusable_declaration", "warning", "observed",
        "A sampled page has hreflang declarations with invalid codes, targets or link attributes; they were excluded from comparison.",
        [page.url]);
    }
    if (page.declarations_truncated) {
      incomplete = true;
      report("multilingual.locale_limit", "warning", "observed",
        "A sampled page exceeds the supported 16 locale references (plus x-default) or the bounded declaration scan; cluster checks are incomplete.",
        [page.url]);
    }
    if (page.conflicting_locales > 0) {
      incomplete = true;
      report("multilingual.locale_conflict", "error", "observed",
        "A sampled page assigns more than one target URL to the same hreflang locale.",
        [page.url]);
    }
    if (page.repeated_locales > 0) {
      report("multilingual.repeated_locale", "warning", "observed",
        "A sampled page repeats an identical hreflang locale/URL declaration.",
        [page.url]);
    }
    if (page.references.length > 0 && (page.canonical_state === "ambiguous" ||
      page.canonical_state === "unverifiable")) {
      incomplete = true;
      report("multilingual.canonical_ambiguous", "warning", "observed",
        "A multilingual page has ambiguous or unusable canonical declarations.",
        [page.url]);
    }
    const hasLocales = page.references.some((ref) => ref.locale !== "x-default");
    if (hasLocales && !page.references.some((ref) => ref.url === page.url && ref.locale !== "x-default")) {
      report("multilingual.self_reference_missing", "warning", "observed",
        "A sampled multilingual page does not include itself among its hreflang alternate URLs.",
        [page.url]);
    }
    if (hasLocales && page.canonical_state === "usable" && page.canonical_url !== page.url) {
      report("multilingual.non_self_canonical", "warning", "potential",
        "A sampled multilingual page declares a different canonical URL; verify that hreflang targets point to canonical localized pages.",
        [page.url, page.canonical_url ?? ""]);
    }
    for (const ref of page.references) {
      if (ref.locale !== "x-default") allLocales.add(ref.locale);
      const target = byUrl.get(ref.url);
      if (!target) {
        unseen.add(ref.url);
        incomplete = true;
        continue;
      }
      if (target.canonical_state === "usable" && target.canonical_url !== target.url) {
        report("multilingual.target_not_canonical", "warning", "observed",
          "A sampled hreflang target declares a different canonical; check the localized canonical cluster.",
          [page.url, target.url]);
      }
      // x-default names a fallback page, not a localized reciprocal.
      // It cannot by itself satisfy a missing localized return reference.
      if (target.url !== page.url && !target.references.some((back) =>
        back.locale !== "x-default" && back.url === page.url)) {
        report("multilingual.return_link_missing", "warning", "observed",
          "A sampled alternate target does not link back to the referring page.",
          [page.url, target.url]);
      }
      if (ref.locale !== "x-default" && target.language &&
        expectedLanguage(ref.locale) !== target.language) {
        report("multilingual.language_signal_mismatch", "warning", "potential",
          "A sampled hreflang locale disagrees with the target document's HTML language/script signal; check the intended audience and actual page language.",
          [page.url, target.url]);
      }
    }
    // Already known sampled pages that lack alternates do not prove that any
    // unsampled alternate pages are missing return links.
  }
  if (allLocales.size > MAX_HREFLANG_LOCALES) {
    incomplete = true;
    report("multilingual.cross_page_locale_limit", "warning", "potential",
      "The compared pages collectively advertise more than 16 distinct locale variants; this bounded cluster review cannot certify all variants.",
      pages.map((p) => p.url));
  }

  // Diagnose canonical cycles and chains only when every intermediate target
  // was actually supplied. Never treat an unseen canonical as broken.
  const canonicalCycles = new Set<string>();
  for (const page of pages) {
    if (page.canonical_state !== "usable" || !page.canonical_url || page.canonical_url === page.url) continue;
    const target = byUrl.get(page.canonical_url);
    if (!target || target.canonical_state !== "usable" || !target.canonical_url) continue;
    if (target.canonical_url === page.url) {
      const urls = [page.url, target.url].sort();
      const key = JSON.stringify(urls);
      if (!canonicalCycles.has(key)) {
        canonicalCycles.add(key);
        report("multilingual.canonical_cycle", "error", "observed",
          "Two sampled localized pages point their canonical declarations at one another.",
          urls);
      }
    } else if (target.canonical_url !== target.url && byUrl.has(target.canonical_url)) {
      report("multilingual.canonical_chain", "warning", "potential",
        "A sampled localized page canonicals to a sampled page which itself canonicals elsewhere.",
        [page.url, target.url]);
    }
  }

  // Undirected edges only among sampled, explicitly linked pages; completely
  // unrelated page families must not be forced into one hreflang cluster.
  const visited = new Set<string>();
  for (const start of pages) {
    if (visited.has(start.url) || start.references.length === 0) continue;
    const component: MultilingualPageObservation[] = [];
    const queue = [start.url];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const page = byUrl.get(current);
      if (!page) continue;
      component.push(page);
      for (const ref of page.references) {
        if (ref.url !== page.url && byUrl.has(ref.url) && !visited.has(ref.url)) queue.push(ref.url);
      }
      for (const candidate of pages) {
        if (candidate.references.some((ref) => ref.url === current) && !visited.has(candidate.url)) {
          queue.push(candidate.url);
        }
      }
    }
    if (component.length < 2) continue;
    const expected = new Map<string, { target: string; page: string }>();
    for (const page of component) {
      for (const ref of page.references) {
        const previous = expected.get(ref.locale);
        if (!previous) expected.set(ref.locale, { target: ref.url, page: page.url });
        else if (previous.target !== ref.url) {
          report("multilingual.cluster_target_conflict", "error", "observed",
            "Linked sampled pages disagree on the target URL for the same hreflang locale.",
            [previous.page, page.url]);
        }
      }
    }
    for (const page of component) {
      const locales = new Set(page.references.map((ref) => ref.locale));
      if ([...expected.keys()].some((code) => !locales.has(code))) {
        report("multilingual.cluster_incomplete", "warning", "potential",
          "A sampled page omits one or more locales advertised by a linked sampled page; verify reciprocal links for each intended variant.",
          [page.url]);
      }
    }
  }

  findings.sort(compareFindings);
  const skipped = sampledPages - pages.length;
  const limitations = [
    "Only already supplied or sampled static HTML is checked; unsampled pages and HTTP-header/sitemap hreflang annotations are not verified.",
    "Hreflang, HTML lang and canonical declarations do not prove Google's selected canonical, detected page language, indexing or rankings.",
    ...(skipped ? [String(skipped) + " page(s) were missing, invalid, oversized or duplicated in the comparison input."] : []),
    ...(unseen.size || options.coverageLimited
      ? ["Referenced targets outside the page sample remain unverified; rerun with additional authorized page HTML."] : []),
  ];
  return {
    scope: "sampled_pages_only",
    sampled_pages: sampledPages,
    eligible_pages: pages.length,
    pages_with_alternates: pages.filter((page) => page.references.length > 0).length,
    locales_observed: allLocales.size,
    unobserved_targets: unseen.size,
    invalid_declarations: invalid,
    coverage_limited: incomplete || sampledPages < 2 ||
      pages.filter((page) => page.references.length > 0).length < 2,
    limitations,
    total_findings: totalFindings,
    findings,
    findings_truncated: totalFindings > MAX_MULTILINGUAL_FINDINGS,
  };
}
