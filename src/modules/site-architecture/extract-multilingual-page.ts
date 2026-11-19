/**
 * Local stdio adapter. The shared multilingual analysis module deliberately
 * has no dependency on Cheerio or either runtime's package installation.
 */
import * as cheerio from "cheerio";
import {
  analyzeMultilingualHtmlSignals,
  MAX_MULTILINGUAL_HTML_CHARS,
  safeMultilingualUrl,
  type MultilingualPageObservation,
} from "./multilingual-clusters.js";

export function observeMultilingualPage(html: string, url: string): MultilingualPageObservation {
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
