/**
 * Worker adapter: parse already fetched HTML using the hosted package's own
 * Cheerio dependency, then apply the shared runtime-neutral cluster rules.
 */
import * as cheerio from "cheerio";
import {
  analyzeMultilingualHtmlSignals,
  MAX_MULTILINGUAL_HTML_CHARS,
  safeMultilingualUrl,
  type MultilingualPageObservation as CoreMultilingualPageObservation,
} from "../../../../src/modules/site-architecture/multilingual-clusters.js";

export {
  analyzeMultilingualClusters,
  normalizeHreflangLocale,
  MAX_MULTILINGUAL_PAGES,
  MAX_HREFLANG_LOCALES,
  MAX_MULTILINGUAL_FINDINGS,
} from "../../../../src/modules/site-architecture/multilingual-clusters.js";
export type {
  MultilingualPageObservation,
  MultilingualClusterAnalysis,
  MultilingualFinding,
} from "../../../../src/modules/site-architecture/multilingual-clusters.js";

export function observeMultilingualPage(html: string, url: string): CoreMultilingualPageObservation {
  if (!html || html.length > MAX_MULTILINGUAL_HTML_CHARS || !safeMultilingualUrl(url)) {
    return analyzeMultilingualHtmlSignals({ rawUrl: url, htmlLength: html.length, links: [] });
  }
  const $ = cheerio.load(html);
  return analyzeMultilingualHtmlSignals({
    rawUrl: url,
    htmlLength: html.length,
    rawLanguage: $("html").first().attr("lang"),
    links: $("head > link[rel], head > link[hreflang]").toArray().map((element) => {
      const link = $(element);
      return {
        rel: link.attr("rel"),
        href: link.attr("href"),
        hreflang: link.attr("hreflang"),
        hasMedia: link.attr("media") !== undefined,
        hasType: link.attr("type") !== undefined,
        hasLang: link.attr("lang") !== undefined,
      };
    }),
  });
}
