/**
 * P1-06: evidence-limited competitor search-intent comparison.
 *
 * This module compares only static HTML that the caller already has the right
 * to supply. It cannot discover competitor pages, query Google/analytics, or
 * determine Google's interpretation, rankings, page usefulness or relevance.
 */
export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational";

export const INTENTS = [
  "informational", "commercial", "transactional", "navigational",
] as const satisfies readonly SearchIntent[];
export const MAX_INTENT_COMPETITORS = 6;
export const MAX_INTENT_HTML_BYTES = 150_000;
export const MAX_INTENT_TOTAL_BYTES = 800_000;
export const MAX_INTENT_FINDINGS = 10;
export const MAX_INTENT_QUERY_BYTES = 160;
const MAX_QUERY_TERMS = 12;

export const SIGNALS = {
  informational: ["article_schema", "faq_schema", "howto_schema", "editorial_sections"],
  commercial: ["product_schema", "review_schema", "comparison_heading", "pricing_heading"],
  transactional: ["offer_schema", "checkout_link", "purchase_action", "purchase_form"],
  navigational: ["contact_heading", "main_contact_link", "main_address"],
} as const;
type Signals = Record<SearchIntent, string[]>;
export type IntentCode = "primary_intent_signal_gap"
  | "primary_heading_query_gap"
  | "primary_missing_headings"
  | "no_explicit_intent_evidence"
  | "incomplete_competitor_sample"
  | "ambiguous_query_terms";

export interface IntentObservation {
  url: string;
  title: string;
  h1: string;
  signals: Signals;
  eligible: boolean;
  extraction_limited: boolean;
  main_found: boolean;
}
export interface IntentPageEvidence {
  origin: string;
  title_present: boolean;
  h1_present: boolean;
  main_found: boolean;
  signals: Signals;
  signal_counts: Record<SearchIntent, number>;
  intent_signal_count?: number;
  query_title_coverage_percent?: number;
  query_h1_coverage_percent?: number;
  extraction_limited: boolean;
}
export interface IntentFinding {
  code: IntentCode;
  severity: "warning" | "info";
  confidence: "observed" | "review";
  message: string;
  competitors_supporting?: number;
}
export interface IntentComparison {
  scope: "caller_supplied_static_html_only";
  expected_intent?: SearchIntent;
  query_supplied: boolean;
  usable_query_terms: number;
  primary: IntentPageEvidence;
  competitors: IntentPageEvidence[];
  competitors_submitted: number;
  competitors_eligible: number;
  competitors_with_intent_signals: number;
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: IntentFinding[];
  findings_truncated: boolean;
}

export function emptyIntentComparison(): IntentComparison {
  const signals = Object.fromEntries(INTENTS.map((intent) => [intent, [] as string[]])) as
    Record<SearchIntent, string[]>;
  const signal_counts = Object.fromEntries(INTENTS.map((intent) => [intent, 0])) as
    Record<SearchIntent, number>;
  return {
    scope: "caller_supplied_static_html_only",
    query_supplied: false,
    usable_query_terms: 0,
    primary: {
      origin: "", title_present: false, h1_present: false, main_found: false,
      signals, signal_counts, extraction_limited: true,
    },
    competitors: [], competitors_submitted: 0, competitors_eligible: 0,
    competitors_with_intent_signals: 0, coverage_limited: true,
    limitations: ["Comparison could not be performed on the bounded supplied input."],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

export function safeIntentUrl(raw: string): string | undefined {
  if (raw.length > 512) return undefined;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.port || parsed.hostname.length > 180) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "the", "to", "vs", "what", "when", "where", "which", "with",
]);

/** Exact normalized heading tokens only; synonyms/intent are not inferred. */
function tokenize(text: string): string[] {
  const matches = text.normalize("NFKC").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((word) => word.length >= 2 && word.length <= 32);
}
export function queryKeywords(query?: string): string[] {
  if (!query || new TextEncoder().encode(query).byteLength > MAX_INTENT_QUERY_BYTES) return [];
  return [...new Set(tokenize(query)
    .filter((word) => !stopWords.has(word)))].slice(0, MAX_QUERY_TERMS);
}
function wordCoverage(heading: string, words: readonly string[]): number | undefined {
  if (!words.length) return undefined;
  const terms = new Set(tokenize(heading));
  return Math.round(100 * words.filter((word) => terms.has(word)).length / words.length);
}
function signalSnapshot(record: IntentObservation, expected: SearchIntent | undefined,
  words: readonly string[]): IntentPageEvidence {
  const url = safeIntentUrl(record.url);
  const signals = Object.fromEntries(INTENTS.map((intent) => [intent,
    [...new Set(record.signals[intent])].filter((item) =>
      (SIGNALS[intent] as readonly string[]).includes(item)).slice(0, 5),
  ])) as Signals;
  const counts = Object.fromEntries(INTENTS.map((intent) =>
    [intent, signals[intent].length])) as Record<SearchIntent, number>;
  return {
    origin: url ? new URL(url).origin : "",
    title_present: Boolean(record.title.trim()),
    h1_present: Boolean(record.h1.trim()),
    main_found: record.main_found,
    signals, signal_counts: counts,
    ...(expected ? { intent_signal_count: counts[expected] } : {}),
    ...(words.length ? {
      query_title_coverage_percent: wordCoverage(record.title, words),
      query_h1_coverage_percent: wordCoverage(record.h1, words),
    } : {}),
    extraction_limited: record.extraction_limited,
  };
}
export function compareIntentObservations(
  primary: IntentObservation,
  competitors: readonly IntentObservation[],
  options: { expectedIntent?: SearchIntent; query?: string } = {},
): IntentComparison {
  if (competitors.length < 1 || competitors.length > MAX_INTENT_COMPETITORS) {
    throw new Error("Supply one to six competitor observations.");
  }
  const primaryUrl = safeIntentUrl(primary.url);
  if (!primaryUrl || !primary.eligible) throw new Error("Primary HTML observation is ineligible.");
  const primaryOrigin = new URL(primaryUrl).origin;
  const competitorOrigins = new Set<string>();
  for (const record of competitors) {
    const competitorUrl = safeIntentUrl(record.url);
    if (!competitorUrl || !record.eligible) throw new Error("Competitor HTML observation is ineligible.");
    const origin = new URL(competitorUrl).origin;
    if (origin === primaryOrigin || competitorOrigins.has(origin)) {
      throw new Error("Competitor observations must have distinct origins from the primary and each other.");
    }
    competitorOrigins.add(origin);
  }
  if (options.expectedIntent && !INTENTS.includes(options.expectedIntent)) {
    throw new Error("Unsupported intent label.");
  }
  const query = options.query;
  if (query && new TextEncoder().encode(query).byteLength > MAX_INTENT_QUERY_BYTES) {
    throw new Error("Optional query exceeds the byte limit.");
  }
  const words = queryKeywords(query);
  const own = signalSnapshot(primary, options.expectedIntent, words);
  const others = competitors.map((record) => signalSnapshot(record, options.expectedIntent, words));
  let competitorsWithSignals = 0;
  const findings: IntentFinding[] = [];
  if (options.expectedIntent) {
    competitorsWithSignals = others.filter((record) => (record.intent_signal_count ?? 0) > 0).length;
    if (!own.intent_signal_count && competitorsWithSignals > 0) {
      findings.push({
        code: "primary_intent_signal_gap", severity: competitorsWithSignals >= 2 ? "warning" : "info",
        confidence: "review",
        competitors_supporting: competitorsWithSignals,
        message: "The primary page lacks the selected intent's inspected static signals, while one or more supplied competitor pages display them. This is a markup review lead, not an intent or ranking verdict.",
      });
    }
  }
  if (words.length) {
    const primaryCoverage = Math.max(own.query_title_coverage_percent ?? 0,
      own.query_h1_coverage_percent ?? 0);
    const competitorCoverage = others.filter((record) =>
      Math.max(record.query_title_coverage_percent ?? 0, record.query_h1_coverage_percent ?? 0) >= 50).length;
    if (primaryCoverage === 0 && competitorCoverage >= 2) {
      findings.push({
        code: "primary_heading_query_gap", severity: "info", confidence: "review",
        competitors_supporting: competitorCoverage,
        message: "Neither primary heading contains the supplied query's normalized content words, but multiple competitor headings overlap at least half. Synonyms, other languages and page relevance were not assessed.",
      });
    }
  } else if (query) {
    findings.push({
      code: "ambiguous_query_terms", severity: "info", confidence: "review",
      message: "No usable content words remain after bounded tokenization of the supplied query. No lexical heading overlap can be assessed.",
    });
  }
  if (!own.title_present && !own.h1_present) {
    findings.push({
      code: "primary_missing_headings", severity: "info", confidence: "observed",
      message: "The primary supplied HTML has neither a nonempty title nor a visible first main H1.",
    });
  }
  if (!options.expectedIntent && !words.length) {
    findings.push({
      code: "no_explicit_intent_evidence", severity: "info", confidence: "review",
      message: "No explicit target intent or usable query was supplied; only inspected static signal inventories can be compared.",
    });
  }
  // Never declare that an incomplete user-supplied competitor set is a SERP,
  // competitor ranking, market sample or result from a search engine.
  return {
    scope: "caller_supplied_static_html_only",
    ...(options.expectedIntent ? { expected_intent: options.expectedIntent } : {}),
    query_supplied: Boolean(query), usable_query_terms: words.length,
    primary: own, competitors: others,
    competitors_submitted: competitors.length, competitors_eligible: others.length,
    competitors_with_intent_signals: competitorsWithSignals,
    coverage_limited: true,
    limitations: [
      "Only caller-supplied static page HTML is compared; no competitors, SERP rankings, live search demand, search console data, crawl results, or index status were retrieved.",
      "Intent indicators are bounded DOM/JSON-LD and heading observations, not Google's interpretation, a semantic classifier, topical authority, content usefulness or proof of relevance.",
      ...(query ? ["Query-heading overlap is strictly lexical; translations, variants, synonyms and implicit intent are not evaluated."] :
        ["No query was supplied; topical heading alignment cannot be checked."]),
      ...(!options.expectedIntent ? ["No target search intent was supplied; markup cannot establish it automatically."] : []),
      ...([primary, ...competitors].some((record) => record.extraction_limited || !record.main_found)
        ? ["At least one page lacked a main region or reached a static parsing bound; evidence may be incomplete."] : []),
    ],
    total_findings: findings.length,
    findings: findings.slice(0, MAX_INTENT_FINDINGS),
    findings_truncated: findings.length > MAX_INTENT_FINDINGS,
  };
}
