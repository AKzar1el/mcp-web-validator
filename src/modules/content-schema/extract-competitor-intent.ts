import * as cheerio from "cheerio";
import {
  INTENTS, MAX_INTENT_HTML_BYTES, safeIntentUrl,
  type IntentObservation, type SearchIntent,
} from "./competitor-intent-comparison.js";

const MAX_JSONLD_SCRIPTS = 4;
const MAX_JSONLD_BYTES = 24_000;
const MAX_ELEMENTS = 160;

export function observeIntentHtml(html: string, rawUrl: string): IntentObservation {
  const url = safeIntentUrl(rawUrl) ?? "";
  const signals: Record<SearchIntent, string[]> =
    Object.fromEntries(INTENTS.map((intent) => [intent, [] as string[]])) as Record<SearchIntent, string[]>;
  const empty = {
    url, title: "", h1: "", signals,
    eligible: false, extraction_limited: false, main_found: false,
  };
  if (!url || !html || new TextEncoder().encode(html).byteLength > MAX_INTENT_HTML_BYTES) return empty;
  const $ = cheerio.load(html);
  const title = $("head title").first().text().replace(/\s+/gu, " ").trim().slice(0, 360);
  let truncated = $("head title").first().text().length > 360;
  const scripts = $('script[type="application/ld+json"]').toArray();
  if (scripts.length > MAX_JSONLD_SCRIPTS) truncated = true;
  function mark(intent: SearchIntent, signal: string) {
    if (!signals[intent].includes(signal)) signals[intent].push(signal);
  }
  for (const script of scripts.slice(0, MAX_JSONLD_SCRIPTS)) {
    const content = $(script).html() ?? "";
    if (new TextEncoder().encode(content).byteLength > MAX_JSONLD_BYTES) {
      truncated = true;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      const nodes: unknown[] = Array.isArray(parsed) ? parsed.slice(0, 12) : [parsed];
      if (Array.isArray(parsed) && parsed.length > 12) truncated = true;
      for (const node of [...nodes]) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        const graph = (node as Record<string, unknown>)["@graph"];
        if (Array.isArray(graph)) {
          if (graph.length > 12) truncated = true;
          nodes.push(...graph.slice(0, 12));
        }
      }
      for (const node of nodes.slice(0, 24)) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        const record = node as Record<string, unknown>;
        const kind = record["@type"];
        const types = (Array.isArray(kind) ? kind : [kind])
          .filter((name): name is string => typeof name === "string" && name.length <= 90)
          .map((name) => name.split("/").at(-1));
        if (types.some((type) => ["Article", "NewsArticle", "BlogPosting", "ScholarlyArticle"].includes(type ?? "")))
          mark("informational", "article_schema");
        if (types.includes("FAQPage")) mark("informational", "faq_schema");
        if (types.includes("HowTo")) mark("informational", "howto_schema");
        if (types.includes("Product")) mark("commercial", "product_schema");
        if (types.some((type) => ["Review", "AggregateRating"].includes(type ?? "")))
          mark("commercial", "review_schema");
        if (types.includes("Offer") || types.includes("AggregateOffer") ||
          ((types.includes("Product")) && record.offers && typeof record.offers === "object")) {
          mark("transactional", "offer_schema");
        }
      }
      if (nodes.length > 24) truncated = true;
    } catch {
      // Parsing failure belongs to the existing JSON-LD validator; it does
      // not authorize deriving intent from partially understood JSON.
      truncated = true;
    }
  }
  $("script,template,style,noscript,nav,header,footer,aside,[hidden],[aria-hidden='true']").remove();
  const main = $("main,[role='main']").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body").first();
  if (!root.length) return { ...empty, title, extraction_limited: truncated };
  const h1Text = root.find("h1").first().text().replace(/\s+/gu, " ").trim();
  const h1 = h1Text.slice(0, 360);
  if (h1Text.length > 360) truncated = true;
  const headings = root.find("h2,h3").toArray();
  if (headings.length > MAX_ELEMENTS) truncated = true;
  const headingText = headings.slice(0, MAX_ELEMENTS)
    .map((node) => $(node).text().replace(/\s+/gu, " ").trim().toLowerCase().slice(0, 120));
  if (headingText.some((value) => /\b(?:versus|compare|comparison|best|review|reviews)\b|\bvs\.?\b/iu.test(value)))
    mark("commercial", "comparison_heading");
  if (headingText.some((value) => /\b(?:pricing|prices|price|plans|costs)\b/iu.test(value)))
    mark("commercial", "pricing_heading");
  if (headingText.some((value) => /\b(?:contact|locations|find us|get in touch|directions)\b/iu.test(value)))
    mark("navigational", "contact_heading");
  const paragraphs = root.find("p").toArray();
  if (paragraphs.length > MAX_ELEMENTS) truncated = true;
  const substantive = paragraphs.slice(0, MAX_ELEMENTS)
    .filter((node) => $(node).text().trim().length >= 80).length;
  if ((root.is("article") || root.find("article").length > 0) &&
    headings.length >= 2 && substantive >= 2) mark("informational", "editorial_sections");
  const anchors = root.find("a[href]").toArray();
  if (anchors.length > MAX_ELEMENTS) truncated = true;
  for (const anchor of anchors.slice(0, MAX_ELEMENTS)) {
    const href = ($(anchor).attr("href") ?? "").toLowerCase().slice(0, 300);
    const label = $(anchor).text().replace(/\s+/gu, " ").trim().toLowerCase().slice(0, 100);
    if (/(?:^|[/#])(?:checkout|cart|basket|booking|reserve|order)(?:[-/?#]|$)/.test(href))
      mark("transactional", "checkout_link");
    if (/\b(?:buy now|add to cart|checkout|book now|reserve now|order now|purchase now)\b/i.test(label))
      mark("transactional", "purchase_action");
    if (/(?:^|[/#])contact(?:[-/?#]|$)/.test(href) && /\b(?:contact|location|directions)\b/.test(label))
      mark("navigational", "main_contact_link");
  }
  const actions = root.find("button,input[type='submit'],input[type='button']").toArray();
  if (actions.length > MAX_ELEMENTS) truncated = true;
  for (const action of actions.slice(0, MAX_ELEMENTS)) {
    const button = $(action);
    const label = (button.attr("value") ?? button.text()).replace(/\s+/gu, " ")
      .trim().toLowerCase().slice(0, 100);
    if (/\b(?:buy now|add to cart|checkout|book now|reserve now|order now|purchase now)\b/i.test(label)) {
      mark("transactional", "purchase_action");
      if (button.closest("form").length) mark("transactional", "purchase_form");
    }
  }
  if (root.find("address").length) mark("navigational", "main_address");
  return {
    url, title, h1, signals, eligible: true,
    extraction_limited: truncated, main_found: Boolean(main.length || article.length),
  };
}
