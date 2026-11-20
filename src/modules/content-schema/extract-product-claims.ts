import * as cheerio from "cheerio";
import {
  isPublicToolName,
  MAX_PRODUCT_CLAIM_HTML_BYTES,
  MAX_PRODUCT_CLAIM_TOOLS,
  type ProductClaimObservation,
} from "./product-claims.js";

/** Static, visible main-content promises only; scripts and nav never execute. */
export function observeProductClaims(html: string): ProductClaimObservation {
  if (!html || Buffer.byteLength(html, "utf8") > MAX_PRODUCT_CLAIM_HTML_BYTES) {
    throw new Error("Landing HTML must be present and at most 250,000 UTF-8 bytes.");
  }
  const $ = cheerio.load(html);
  $("template,script,style,noscript,nav,header,footer,aside,[hidden],[aria-hidden='true']").remove();
  const main = $("main").first();
  const root = main.length ? main : $("body").first();
  const headings = root.find("h2,h3").toArray();
  function findToolList(term: RegExp) {
    const heading = headings.find((node) => term.test($(node).text().trim()));
    if (!heading) return { found: false, tools: [] as string[], truncated: false };
    const section = $(heading).closest("section");
    const container = section.length ? section : $(heading).parent();
    const all = container.find("code,[data-mcp-tool]").toArray()
      .filter((node) => $(node).closest("pre").length === 0)
      .map((node) => $(node).attr("data-mcp-tool")?.trim() || $(node).text().trim())
      .filter((text) => isPublicToolName(text));
    return {
      found: true,
      tools: [...new Set(all)].slice(0, MAX_PRODUCT_CLAIM_TOOLS),
      truncated: [...new Set(all)].length > MAX_PRODUCT_CLAIM_TOOLS,
    };
  }
  const hosted = findToolList(/(?:public chatgpt capabilities|hosted(?: mcp)? tools|chatgpt tool list)/i);
  const local = findToolList(/(?:local(?: mcp)? capabilities|local(?: mcp)? tools)/i);
  // Use explicit short on-page statements rather than guessing from unrelated
  // marketing/nav/footer content or claiming all sales prose was analyzed.
  const paragraphs = root.find("p,li").toArray().slice(0, 220)
    .map((node) => $(node).text().replace(/\s+/gu, " ").trim().toLowerCase())
    .filter((text) => text.length > 0 && text.length <= 2000);
  const body = root.text().replace(/\s+/gu, " ").slice(0, 70_000);
  // Cheerio concatenates adjacent block elements without inserted whitespace.
  const siteLimit = /site\s*batch\s*up\s*to\s*(\d{1,12})\s*pages/i.exec(body);
  const number = siteLimit ? Number(siteLimit[1]) : undefined;
  return {
    hasMain: main.length > 0,
    hostedSectionFound: hosted.found,
    localSectionFound: local.found,
    hostedTools: hosted.tools,
    localTools: local.tools,
    ...(number && Number.isSafeInteger(number) ? { siteBatchLimit: number } : {}),
    localScreenshotClaim: paragraphs.some((p) => /\blocal\b/.test(p) &&
      /(?:screenshots?|screen captures?)/.test(p) &&
      !/(?:local[^\n]{0,80}(?:cannot|does not|doesn't)[^\n]{0,80}screenshot)/.test(p)),
    hostedReadOnlyClaim: paragraphs.some((p) => /\bhosted\b/.test(p) &&
      /\bread.only\b/.test(p)),
    hostedNoScreenshotsClaim: paragraphs.some((p) => /\bhosted\b/.test(p) &&
      /(?:cannot|does not|doesn't|no)\b/.test(p) && /\bscreenshots?\b/.test(p)),
    extractionTruncated: hosted.truncated || local.truncated || root.find("p,li").length > 220 ||
      body.length >= 70_000,
  };
}
