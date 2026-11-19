import * as cheerio from "cheerio";
import {
  METADATA_FIELDS,
  MAX_METADATA_HTML_BYTES,
  MAX_METADATA_VALUES,
  safeMetadataLabel,
  type MetadataField,
  type MetadataObservation,
} from "../../../../src/modules/content-schema/metadata-consistency.js";

/** Static in-memory HTML parsing only; no page, URL, or social endpoint fetch. */
export function observeMetadata(html: string, rawUrl: string): MetadataObservation {
  const url = safeMetadataLabel(rawUrl) ?? "";
  const values = Object.fromEntries(
    METADATA_FIELDS.map((field) => [field, [] as string[]]),
  ) as Record<MetadataField, string[]>;
  const result: MetadataObservation = {
    url, values, excluded_canonicals: 0, extraction_limited: false,
  };
  if (!url || !html || new TextEncoder().encode(html).byteLength > MAX_METADATA_HTML_BYTES) {
    return { ...result, extraction_limited: true };
  }
  const $ = cheerio.load(html);
  function push(field: MetadataField, value: string) {
    const clean = value.replace(/\s+/gu, " ").trim();
    const max = field === "canonical" || field === "og:url" ? 1024 : 320;
    if (clean.length > max) {
      result.extraction_limited = true;
      return;
    }
    if (values[field].length < MAX_METADATA_VALUES) values[field].push(clean);
    else result.extraction_limited = true;
  }
  $("head > title").each((_, element) => push("title", $(element).text()));
  $("head > meta").each((_, element) => {
    const meta = $(element);
    const name = (meta.attr("name") ?? "").trim().toLowerCase();
    const property = (meta.attr("property") ?? "").trim().toLowerCase();
    const content = meta.attr("content") ?? "";
    if (name === "description" || name === "twitter:title" || name === "twitter:description") {
      push(name, content);
    }
    if (property === "og:title" || property === "og:description" || property === "og:url") {
      push(property, content);
    }
    if (name === "robots" || name === "googlebot") push(name, content);
  });
  // Explicit robots declarations in the body may be noticed by Google;
  // these are source observations, not verified crawl directives.
  $("body meta[name]").each((_, element) => {
    const name = ($(element).attr("name") ?? "").trim().toLowerCase();
    if (name === "robots" || name === "googlebot") push(name, $(element).attr("content") ?? "");
  });
  $("head > link[rel]").each((_, element) => {
    const item = $(element);
    const rel = (item.attr("rel") ?? "").toLowerCase().split(/\s+/u);
    if (!rel.includes("canonical")) return;
    if (["hreflang", "media", "type", "lang"].some((key) => item.attr(key) !== undefined)) {
      result.excluded_canonicals += 1;
      return;
    }
    push("canonical", item.attr("href") ?? "");
  });
  result.base_href = $("head > base[href]").first().attr("href");
  return result;
}

export { analyzeMetadataConsistency, emptyMetadataReview, safeMetadataLabel, MAX_METADATA_HTML_BYTES, MAX_METADATA_TOTAL_BYTES, MAX_METADATA_FINDINGS } from "../../../../src/modules/content-schema/metadata-consistency.js";
export type { MetadataReview } from "../../../../src/modules/content-schema/metadata-consistency.js";
