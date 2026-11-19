import * as cheerio from "cheerio";
import {
  MAIN_CONTENT_BLOCK_SELECTORS,
  MAIN_CONTENT_EXCLUDED_SELECTORS,
} from "../../../../src/modules/content-schema/same-language-duplicates.js";
import type { MainContentObservation, MainContentSource } from "../../../../src/modules/content-schema/same-language-duplicates.js";

export {
  analyzeSameLanguageDuplicates,
  MIN_MAIN_CONTENT_WORDS,
  MAX_CONTENT_DUPLICATE_PAIRS,
} from "../../../../src/modules/content-schema/same-language-duplicates.js";
export type {
  MainContentObservation,
  ContentDuplicatePair,
  SameLanguageDuplicateAnalysis,
} from "../../../../src/modules/content-schema/same-language-duplicates.js";

/** Worker adapter: observe static HTML from pages already fetched by the bounded site audit. */
export function observeMainContent(html: string, url: string): MainContentObservation {
  const $ = cheerio.load(html);
  const language = $("html").first().attr("lang")?.trim();
  $("template").remove();
  const main = $("main,[role='main']").filter((_, element) => $(element).parents("template").length === 0).first();
  const article = $("article").filter((_, element) => $(element).parents("template").length === 0).first();
  const body = $("body").first();
  const root = main.length ? main : article.length ? article : body;
  const source: MainContentSource = main.length ? "main" : article.length ? "article" : body.length ? "body_fallback" : "missing";
  if (!root.length) return { url, language, source: "missing", text: "" };
  root.find(MAIN_CONTENT_EXCLUDED_SELECTORS).remove();
  root.find(MAIN_CONTENT_BLOCK_SELECTORS).each((_, element) => {
    $(element).before(" ");
    $(element).after(" ");
  });
  return { url, language, source, text: root.text() };
}
