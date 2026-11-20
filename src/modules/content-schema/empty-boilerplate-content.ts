/**
 * P1-03: evidence-limited structural content-quality checks.
 * Pure deterministic logic over the already extracted static main text.
 * It is not a content-quality score, indexing verdict, or semantic judgment.
 */
import {
  MAX_MAIN_CONTENT_CHARS,
  MAX_MAIN_CONTENT_WORDS,
  comparisonLanguage,
  safeObservedUrl,
  tokensFromText,
  type MainContentObservation,
} from "./same-language-duplicates.js";

export const MAX_PAGE_QUALITY_PAGES = 8;
export const MAX_PAGE_QUALITY_FINDINGS = 12;
const THIN_CONTENT_WORDS = 40;
const MIN_REPEATED_WORDS = 60;
const MIN_REPEATED_SENTENCE_WORDS = 12;
const BOILERPLATE_MIN_SHARE = 0.65;
const LOW_UNIQUE_VALUE_SHARE = 0.8;
const LOW_UNIQUE_WORDS = 30;
const MAX_SENTENCES = 240;
const MAX_EXAMPLE_URLS = 2;

export interface ContentQualityFinding {
  code: string;
  severity: "warning" | "info";
  confidence: "observed" | "potential";
  message: string;
  affected_pages: number;
  example_urls: string[];
}

export interface PageContentQualityAnalysis {
  scope: "sampled_pages_only";
  sampled_pages: number;
  eligible_pages: number;
  skipped_pages: number;
  families_compared: number;
  empty_main_pages: number;
  short_main_pages: number;
  repeated_boilerplate_pages: number;
  possible_low_value_pages: number;
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: ContentQualityFinding[];
  findings_truncated: boolean;
}

interface AnalyzedSentence {
  normalized: string;
  words: number;
}

interface AnalyzedPage {
  url: string;
  source: MainContentObservation["source"];
  language?: string;
  family: string;
  normalizedText: string;
  words: number;
  sentences: AnalyzedSentence[];
  sentenceLimit: boolean;
}

/** URL-based grouping is a heuristic, not proof that two pages have the same purpose. */
function familyFor(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // A site's /privacy and /contact are not a family merely because they
  // share the root directory; grouping needs an actual path-category parent.
  const path = parts.length < 2 ? parsed.pathname :
    "/" + parts.slice(0, parts.length > 2 ? 2 : 1).join("/") + "/*";
  return parsed.origin + path;
}

function prepare(input: MainContentObservation): AnalyzedPage | undefined {
  const url = safeObservedUrl(input.url);
  if (!url || input.text.length > MAX_MAIN_CONTENT_CHARS) return undefined;
  const language = comparisonLanguage(input.language);
  const locale = language ?? "en";
  const normalizedText = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase(locale);
  if (normalizedText.length > MAX_MAIN_CONTENT_CHARS) return undefined;
  const words = tokensFromText(normalizedText, locale);
  if (words.length > MAX_MAIN_CONTENT_WORDS) return undefined;

  const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
  const sentences: AnalyzedSentence[] = [];
  let sentenceLimit = false;
  // Preserve author-provided paragraph boundaries: a 100-word paragraph
  // without punctuation is still a substantive reusable content block.
  // Analyze each leaf block once; do not double-count flattened main text.
  const blocks = input.blocks?.length ? input.blocks : [normalizedText];
  for (const rawBlock of blocks.slice(0, MAX_SENTENCES)) {
    if (sentences.length >= MAX_SENTENCES) { sentenceLimit = true; break; }
    const text = rawBlock.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase(locale);
    const segmented = Array.from(segmenter.segment(text), (segment) => segment.segment);
    // ICU sometimes misses punctuation after alphanumeric identifiers.
    const sections = segmented.length <= 1 && /[.!?]\s+\p{L}/u.test(text)
      ? text.split(/(?<=[.!?])\s+(?=\p{L})/u)
      : segmented;
    for (const section of sections) {
      if (sentences.length >= MAX_SENTENCES) { sentenceLimit = true; break; }
      const value = section.trim();
      if (!value) continue;
      const count = tokensFromText(value, locale).length;
      if (count >= MIN_REPEATED_SENTENCE_WORDS) sentences.push({ normalized: value, words: count });
    }
  }
  if (input.blocksTruncated || blocks.length > MAX_SENTENCES) sentenceLimit = true;
  return {
    url, source: input.source, ...(language ? { language } : {}),
    family: familyFor(url), normalizedText, words: words.length, sentences, sentenceLimit,
  };
}

function findingComparator(left: ContentQualityFinding, right: ContentQualityFinding): number {
  return (left.severity === "warning" ? 0 : 1) - (right.severity === "warning" ? 0 : 1)
    || left.code.localeCompare(right.code)
    || (left.example_urls[0] ?? "").localeCompare(right.example_urls[0] ?? "");
}

export function analyzePageContentQuality(
  observations: readonly MainContentObservation[],
  options: { sampledPages?: number; coverageLimited?: boolean } = {},
): PageContentQualityAnalysis {
  if (observations.length > MAX_PAGE_QUALITY_PAGES) {
    throw new Error("Content-quality analysis supports at most eight pages per sample.");
  }
  const sampledPages = options.sampledPages ?? observations.length;
  if (!Number.isSafeInteger(sampledPages) || sampledPages < observations.length ||
    sampledPages > MAX_PAGE_QUALITY_PAGES) {
    throw new Error("sampledPages must be between the observed count and eight.");
  }
  const seenPages = new Set<string>();
  const prepared = observations.flatMap((item) => {
    const page = prepare(item);
    if (!page || seenPages.has(page.url)) return [];
    seenPages.add(page.url);
    return [page];
  });
  const empty = prepared.filter((p) => p.words <= 2 && p.source !== "body_fallback");
  const noTextBody = prepared.filter((p) => p.words <= 2 && p.source === "body_fallback");
  const thin = prepared.filter((p) => p.words > 2 && p.words < THIN_CONTENT_WORDS &&
    (p.source === "main" || p.source === "article"));
  const findings: ContentQualityFinding[] = [];
  const seen = new Set<string>();
  let totalFindings = 0;

  function report(code: string, confidence: ContentQualityFinding["confidence"],
    message: string, pages: readonly AnalyzedPage[], severity: ContentQualityFinding["severity"] = "warning") {
    if (pages.length === 0) return;
    const examples = [...new Set(pages.map((page) => page.url))].sort();
    const key = JSON.stringify([code, examples]);
    if (seen.has(key)) return;
    seen.add(key);
    totalFindings += 1;
    findings.push({
      code, severity, confidence, message,
      affected_pages: examples.length,
      example_urls: examples.slice(0, MAX_EXAMPLE_URLS),
    });
  }

  if (empty.length) report(
    "content.empty_main", "observed",
    "Sampled page main content has little or no static text. Images, video, or script-rendered content might still provide value; inspect the rendered page.",
    empty,
  );
  if (noTextBody.length) report(
    "content.no_static_body", "potential",
    "Sampled HTML has almost no static body text and no main landmark. A JavaScript-rendered interface may still provide substantial content; check the rendered page.",
    noTextBody,
  );
  if (thin.length) report(
    "content.short_main", "potential",
    "Sampled page main text has fewer than 40 words. Short pages can be useful; review whether each meets its visitors' needs.",
    thin,
  );

  const byFamily = new Map<string, AnalyzedPage[]>();
  for (const page of prepared) {
    const group = byFamily.get(page.family) ?? [];
    group.push(page);
    byFamily.set(page.family, group);
  }
  const repeated = new Set<string>();
  const lowValue = new Set<string>();
  let comparableFamilies = 0;
  for (const pages of byFamily.values()) {
    if (pages.length < 2) continue;
    const emptyPages = pages.filter((page) => page.words <= 2);
    if (emptyPages.length >= 2) report(
      "content.family_empty", emptyPages.some((p) => p.source === "body_fallback") ? "potential" : "observed",
      "Multiple pages in an approximate URL family have almost no static main text; inspect the family template and rendered output.",
      emptyPages,
    );
    const shortPages = pages.filter((page) => page.words < THIN_CONTENT_WORDS);
    if (pages.length >= 3 && shortPages.length >= Math.ceil(pages.length * 0.75)) report(
      "content.family_thin", "potential",
      "Most sampled pages in an approximate URL family have short main text; evaluate their different visitor needs rather than relying on word count alone.",
      shortPages,
    );

    const byLanguage = new Map<string, AnalyzedPage[]>();
    for (const page of pages) {
      if (!page.language) continue;
      const languagePages = byLanguage.get(page.language) ?? [];
      languagePages.push(page);
      byLanguage.set(page.language, languagePages);
    }
    for (const languagePages of byLanguage.values()) {
      if (languagePages.length < 2) continue;
      comparableFamilies += 1;
      const sentenceOwners = new Map<string, Set<string>>();
      const exactTextOwners = new Map<string, Set<string>>();
      for (const page of languagePages) {
        const repeatedText = exactTextOwners.get(page.normalizedText) ?? new Set<string>();
        repeatedText.add(page.url);
        exactTextOwners.set(page.normalizedText, repeatedText);
        for (const sentence of page.sentences) {
          const owners = sentenceOwners.get(sentence.normalized) ?? new Set<string>();
          owners.add(page.url);
          sentenceOwners.set(sentence.normalized, owners);
        }
      }
      const familyBoilerplate: AnalyzedPage[] = [];
      const familyLowValue: AnalyzedPage[] = [];
      for (const page of languagePages) {
        // Identical pages are already reported by P1-01. Avoid duplicating
        // that same diagnostic under a new name.
        if ((exactTextOwners.get(page.normalizedText)?.size ?? 0) > 1 || page.words < MIN_REPEATED_WORDS) {
          continue;
        }
        const repeatedWords = Math.min(page.words, page.sentences.reduce(
          (sum, sentence) => sum +
            ((sentenceOwners.get(sentence.normalized)?.size ?? 0) >= 2 ? sentence.words : 0),
          0,
        ));
        if (repeatedWords < MIN_REPEATED_WORDS) continue;
        const ratio = repeatedWords / page.words;
        if (ratio >= BOILERPLATE_MIN_SHARE) {
          familyBoilerplate.push(page);
          repeated.add(page.url);
        }
        if (ratio >= LOW_UNIQUE_VALUE_SHARE && page.words - repeatedWords < LOW_UNIQUE_WORDS) {
          familyLowValue.push(page);
          lowValue.add(page.url);
        }
      }
      if (familyBoilerplate.length >= 2) report(
        "content.family_repeated_boilerplate", "potential",
        "Substantial main-text sentences repeat across multiple nonidentical pages in one sampled URL family. Review whether the pages offer distinct information.",
        familyBoilerplate,
      );
      if (familyLowValue.length) report(
        "content.low_unique_value", "potential",
        "One or more sampled pages contain mostly repeated main-text sentences with little additional text. This is a review signal, not a determination of usefulness.",
        familyLowValue,
      );
    }
  }

  findings.sort(findingComparator);
  const skippedPages = sampledPages - prepared.length;
  const unknownLanguage = prepared.some((page) => !page.language);
  const sentenceLimits = prepared.some((page) => page.sentenceLimit);
  return {
    scope: "sampled_pages_only",
    sampled_pages: sampledPages,
    eligible_pages: prepared.length,
    skipped_pages: skippedPages,
    families_compared: comparableFamilies,
    empty_main_pages: empty.length,
    short_main_pages: thin.length,
    repeated_boilerplate_pages: repeated.size,
    possible_low_value_pages: lowValue.size,
    coverage_limited: Boolean(options.coverageLimited) || sampledPages < 2 ||
      skippedPages > 0 || unknownLanguage || sentenceLimits,
    limitations: [
      "Static main-text heuristics cannot prove content usefulness, originality, indexing eligibility, ranking effects, or rendered-page behavior.",
      "Boilerplate comparisons use only sampled pages in the same approximate URL family and language; a clean result is not site-wide coverage.",
      ...(skippedPages ? [String(skippedPages) + " page(s) had unavailable or oversized observations or duplicate URL labels."] : []),
      ...(unknownLanguage || sentenceLimits || options.coverageLimited
        ? ["Unknown language, a bounded sentence scan, or incomplete page discovery limits cross-page conclusions."] : []),
    ],
    total_findings: totalFindings,
    findings: findings.slice(0, MAX_PAGE_QUALITY_FINDINGS),
    findings_truncated: findings.length > MAX_PAGE_QUALITY_FINDINGS,
  };
}
