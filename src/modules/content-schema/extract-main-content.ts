import * as cheerio from "cheerio";
import { MAIN_CONTENT_BLOCK_SELECTORS, MAIN_CONTENT_EXCLUDED_SELECTORS } from "./same-language-duplicates.js";
import type { MainContentObservation, MainContentSource } from "./same-language-duplicates.js";

/**
 * Inspect the static HTML supplied by the caller. This never executes scripts,
 * infers language from the URL, follows links or reads assets.
 */
export function observeMainContent(html: string, url: string): MainContentObservation {
  const $ = cheerio.load(html);
  const language = $("html").first().attr("lang")?.trim();
  // parse5 stores <template> contents in a document fragment, so a CSS
  // parent/ancestor filter alone is not sufficient to reject inert <main>.
  $("template").remove();
  const main = $("main,[role='main']").filter((_, element) => $(element).parents("template").length === 0).first();
  const article = $("article").filter((_, element) => $(element).parents("template").length === 0).first();
  const body = $("body").first();
  const root = main.length ? main : article.length ? article : body;
  const source: MainContentSource = main.length ? "main" : article.length ? "article" : body.length ? "body_fallback" : "missing";
  if (!root.length) return { url, language, source: "missing", text: "" };
  root.find(MAIN_CONTENT_EXCLUDED_SELECTORS).remove();
  const blocks = root.find("p,li,blockquote,pre").filter((_, element) =>
    $(element).parents("p,li,blockquote,pre").length === 0).toArray()
    .map((element) => $(element).text().replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  root.find(MAIN_CONTENT_BLOCK_SELECTORS).each((_, element) => {
    $(element).before(" ");
    $(element).after(" ");
  });
  return {
    url, language, source, text: root.text(),
    blocks: blocks.slice(0, 240), blocksTruncated: blocks.length > 240,
  };
}
