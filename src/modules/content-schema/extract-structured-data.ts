import * as cheerio from "cheerio";
import {
  MAX_SUPPORTED_SCHEMA_HTML_BYTES, MAX_SUPPORTED_SCHEMA_SCRIPTS,
  reviewSupportedJsonLd, type SupportedSchemaReview,
} from "./structured-data-validation.js";

/** Extract only inert, explicitly typed JSON-LD; never fetch referenced URLs. */
export function reviewSupportedSchemaHtml(html: string): SupportedSchemaReview {
  if (!html || new TextEncoder().encode(html).byteLength > MAX_SUPPORTED_SCHEMA_HTML_BYTES) {
    throw new Error("Static HTML must be present and at most 250,000 UTF-8 bytes.");
  }
  const $ = cheerio.load(html);
  const scripts = $("script[type]").filter((_, element) => {
    const type = ($(element).attr("type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/ld+json") return false;
    let node: { name?: string; parent?: unknown } | null = element;
    while (node) {
      if (node.name?.toLowerCase() === "template") return false;
      node = (node.parent ?? null) as typeof node;
    }
    return true;
  });
  const sample = scripts.toArray().slice(0, MAX_SUPPORTED_SCHEMA_SCRIPTS)
    .map((element) => $(element).html() ?? "");
  return reviewSupportedJsonLd(sample, scripts.length);
}
