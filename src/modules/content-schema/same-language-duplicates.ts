/**
 * P1-01: deterministic, evidence-limited same-language main-content comparisons.
 *
 * This pure module is shared by the local stdio MCP and the hosted Worker.
 * HTML extraction happens in the two runtime adapters; only already-observed
 * static main text reaches this function. No network, storage, embeddings or AI.
 */
export type MainContentSource = "main" | "article" | "body_fallback" | "missing";

export interface MainContentObservation {
  url: string;
  language: string | undefined;
  text: string;
  source: MainContentSource;
}

export interface ContentDuplicatePair {
  first_url: string;
  second_url: string;
  language: string;
  kind: "exact" | "near";
  confidence: "observed" | "potential";
  similarity_percent: number;
  first_words: number;
  second_words: number;
}

export interface SameLanguageDuplicateAnalysis {
  scope: "sampled_pages_only";
  sampled_pages: number;
  eligible_pages: number;
  skipped_pages: number;
  coverage_limited: boolean;
  limitations: string[];
  total_pairs: number;
  pairs: ContentDuplicatePair[];
  pairs_truncated: boolean;
}

export const MIN_MAIN_CONTENT_WORDS = 80;
export const MAX_MAIN_CONTENT_CHARS = 120_000;
export const MAX_MAIN_CONTENT_WORDS = 6_000;
export const MAX_CONTENT_DUPLICATE_PAIRS = 8;
export const MAIN_CONTENT_EXCLUDED_SELECTORS = [
  "script", "style", "noscript", "svg", "template", "nav", "header", "footer", "aside",
  "form", "button", "[hidden]", "[aria-hidden='true']", "[role='navigation']",
  "[role='banner']", "[role='contentinfo']", "[role='complementary']",
].join(",");
export const MAIN_CONTENT_BLOCK_SELECTORS = "p,h1,h2,h3,h4,h5,h6,li,div,section,article,blockquote,pre,br,dt,dd,tr";
const SHINGLE_SIZE = 5;
const MIN_DISTINCT_SHINGLES = 20;
const NEAR_JACCARD_THRESHOLD = 0.82;
const MIN_NEAR_LENGTH_RATIO = 0.82;
const MAX_RESULT_URL_CHARS = 512;

interface PreparedDocument {
  url: string;
  language: string;
  source: MainContentSource;
  normalized: string;
  tokens: string[];
  shingles: Set<string>;
}

function safeObservedUrl(value: string): string | undefined {
  try {
    if (value.length > MAX_RESULT_URL_CHARS) return undefined;
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.search || url.hash || !url.hostname) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Same base language, but preserve explicit script differences (sr-Cyrl vs sr-Latn). */
function comparisonLanguage(value: string | undefined): string | undefined {
  if (!value || value.length > 48) return undefined;
  try {
    const locale = new Intl.Locale(value.trim());
    if (!/^[a-z]{2,3}$/.test(locale.language) || ["und", "zxx"].includes(locale.language)) {
      return undefined;
    }
    return locale.language + (locale.script ? "-" + locale.script.toLowerCase() : "");
  } catch {
    return undefined;
  }
}

function tokensFromText(text: string, language: string): string[] {
  const segmenter = new Intl.Segmenter(language, { granularity: "word" });
  const tokens: string[] = [];
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike && /[\p{L}\p{N}]/u.test(part.segment)) {
      tokens.push(part.segment);
      if (tokens.length > MAX_MAIN_CONTENT_WORDS) break;
    }
  }
  return tokens;
}

/** Bounded, length-prefixed shingle keys avoid separator-collision ambiguity. */
function shingles(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i <= tokens.length - SHINGLE_SIZE; i += 1) {
    const key = tokens.slice(i, i + SHINGLE_SIZE)
      .map((token) => token.length + ":" + token).join("");
    result.add(key);
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size < MIN_DISTINCT_SHINGLES || right.size < MIN_DISTINCT_SHINGLES) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let overlap = 0;
  for (const shingle of smaller) if (larger.has(shingle)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function prepare(input: MainContentObservation): PreparedDocument | undefined {
  const url = safeObservedUrl(input.url);
  const language = comparisonLanguage(input.language);
  if (!url || !language || input.source === "missing"
      || !input.text || input.text.length > MAX_MAIN_CONTENT_CHARS) return undefined;
  const normalized = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase(language);
  if (!normalized || normalized.length > MAX_MAIN_CONTENT_CHARS) return undefined;
  const tokens = tokensFromText(normalized, language);
  if (tokens.length < MIN_MAIN_CONTENT_WORDS || tokens.length > MAX_MAIN_CONTENT_WORDS) return undefined;
  return { url, language, source: input.source, normalized, tokens, shingles: shingles(tokens) };
}

export function analyzeSameLanguageDuplicates(
  observations: readonly MainContentObservation[],
  options: { sampledPages?: number; coverageLimited?: boolean } = {},
): SameLanguageDuplicateAnalysis {
  // At most eight pages per call; reject rather than silently skip extra comparisons.
  if (observations.length > 8) throw new Error("Same-language duplicate analysis supports at most eight pages.");
  const sampledPages = options.sampledPages ?? observations.length;
  if (!Number.isSafeInteger(sampledPages) || sampledPages < observations.length || sampledPages > 8) {
    throw new Error("sampledPages must be between the observed page count and eight.");
  }

  const prepared = observations.flatMap((observation) => {
    const document = prepare(observation);
    return document ? [document] : [];
  });
  const matched: ContentDuplicatePair[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const left = prepared[i];
      const right = prepared[j];
      if (left.url === right.url || left.language !== right.language) continue;
      const exact = left.normalized === right.normalized;
      let similarity = 0;
      if (!exact) {
        const ratio = Math.min(left.tokens.length, right.tokens.length)
          / Math.max(left.tokens.length, right.tokens.length);
        if (ratio < MIN_NEAR_LENGTH_RATIO) continue;
        similarity = jaccard(left.shingles, right.shingles);
        if (similarity < NEAR_JACCARD_THRESHOLD) continue;
      }
      matched.push({
        first_url: left.url,
        second_url: right.url,
        language: left.language,
        kind: exact ? "exact" : "near",
        confidence: exact && left.source !== "body_fallback" && right.source !== "body_fallback"
          ? "observed" : "potential",
        similarity_percent: exact ? 100 : Math.min(99, Math.round(similarity * 100)),
        first_words: left.tokens.length,
        second_words: right.tokens.length,
      });
    }
  }
  matched.sort((a, b) =>
    (a.kind === "exact" ? 0 : 1) - (b.kind === "exact" ? 0 : 1)
    || b.similarity_percent - a.similarity_percent
    || a.first_url.localeCompare(b.first_url)
    || a.second_url.localeCompare(b.second_url),
  );
  const skippedPages = sampledPages - prepared.length;
  const limitations = [
    "Compares only supplied or selected, already-fetched pages; absence of matches does not prove site-wide uniqueness.",
    "Static text similarity is not a semantic or Google duplicate-content verdict.",
    ...(skippedPages ? [`${skippedPages} page(s) lacked a usable language, enough main content, a safe URL, or were over the size limit.`] : []),
    ...(options.coverageLimited ? ["Sitemap or page selection coverage is incomplete."] : []),
  ];
  return {
    scope: "sampled_pages_only",
    sampled_pages: sampledPages,
    eligible_pages: prepared.length,
    skipped_pages: skippedPages,
    coverage_limited: Boolean(options.coverageLimited) || sampledPages < 2 || skippedPages > 0,
    limitations,
    total_pairs: matched.length,
    pairs: matched.slice(0, MAX_CONTENT_DUPLICATE_PAIRS),
    pairs_truncated: matched.length > MAX_CONTENT_DUPLICATE_PAIRS,
  };
}
