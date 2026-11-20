import { fetchPublicHttp, readResponseText, resolvePublicHttpUrl } from "../../network.js";
import { gunzipSync } from "node:zlib";
import { safeHttpResourceUrl } from "./non-html-directives.js";
import {
  analyzeSitemapInventory, sitemapIndexChildUrls, sitemapFromRobotsTxt,
  MAX_SITEMAP_DOCUMENT_BYTES,
  type SitemapInputDocument, type SitemapInventoryReview,
} from "./sitemap-inventory.js";

/** Limit both compressed bytes and inflation before XML parsing. */
export async function readBoundedGzipSitemap(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let compressedBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      compressedBytes += part.value.byteLength;
      if (compressedBytes > MAX_SITEMAP_DOCUMENT_BYTES) {
        throw new Error("Sitemap compressed body exceeded its byte limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* Consumed or aborted. */ }
  }
  const compressed = Buffer.concat(chunks);
  // Some fetch clients transparently decompress Content-Encoding: gzip.
  const inflated = compressed[0] === 0x1f && compressed[1] === 0x8b
    ? gunzipSync(compressed, { maxOutputLength: MAX_SITEMAP_DOCUMENT_BYTES })
    : compressed;
  if (inflated.byteLength > MAX_SITEMAP_DOCUMENT_BYTES) {
    throw new Error("Sitemap uncompressed body exceeded its byte limit.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(inflated);
}

/**
 * V05 point-in-time bounded sitemap fetch, not a site crawl. Only the
 * authorized root and at most two safe same-origin index child sitemaps.
 */
export async function probeSitemapInventory(
  siteUrl: string, sitemapUrl?: string,
): Promise<SitemapInventoryReview> {
  const site = safeHttpResourceUrl(siteUrl);
  if (!site) throw new Error("Live sitemap requires a safe query-free public site URL.");
  await resolvePublicHttpUrl(site);
  const origin = new URL(site).origin;
  let initial = sitemapUrl ?? new URL("/sitemap.xml", origin).href;
  if (sitemapUrl === undefined) {
    try {
      const { response } = await fetchPublicHttp(origin + "/robots.txt", {
        method: "GET", maxRedirects: 0, timeoutMs: 12_000,
        headers: { accept: "text/plain", "user-agent": "mcp-web-validator-sitemap-inventory/1" },
      });
      try {
        if (response.ok && response.headers.get("content-type")
          ?.toLowerCase().startsWith("text/plain")) {
          const robots = await readResponseText(response, 64_000);
          initial = sitemapFromRobotsTxt(origin + "/", robots) ?? initial;
        }
      } finally {
        try { await response.body?.cancel(); } catch { /* Already consumed. */ }
      }
    } catch {
      // A missing/unavailable robots.txt is not permission to fetch private URLs;
      // only the configured safe root sitemap fallback is ever tried.
    }
  }
  if (!safeHttpResourceUrl(initial) || new URL(initial).origin !== origin) {
    throw new Error("Sitemap location must be a safe same-origin query-free URL.");
  }
  const queue = [initial];
  const seen = new Set<string>();
  const documents: SitemapInputDocument[] = [];
  let incomplete = false;
  for (let index = 0; index < queue.length && documents.length < 3; index++) {
    const url = queue[index];
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const { response } = await fetchPublicHttp(url, {
        method: "GET",
        maxRedirects: 0,
        timeoutMs: 12_000,
        headers: {
          accept: "application/xml,text/xml,text/plain;q=0.8",
          "user-agent": "mcp-web-validator-sitemap-inventory/1",
        },
      });
      const mime = response.headers.get("content-type")
        ?.split(";", 1)[0].trim().toLowerCase();
      let content = "";
      try {
        const compressed = url.toLowerCase().endsWith(".gz") &&
          (mime === "application/gzip" || mime === "application/x-gzip" ||
            mime === "application/octet-stream" || mime === "application/xml" ||
            mime === "text/xml");
        if (response.status >= 200 && response.status <= 299 && compressed) {
          content = await readBoundedGzipSitemap(response);
        } else if (response.status >= 200 && response.status <= 299 &&
          (mime === "application/xml" || mime === "text/xml" || mime === "text/plain")) {
          content = await readResponseText(response, MAX_SITEMAP_DOCUMENT_BYTES);
        } else if (response.status >= 200 && response.status <= 299) {
          incomplete = true;
        }
      } finally {
        try { await response.body?.cancel(); } catch { /* Already consumed or closed. */ }
      }
      documents.push({
        sitemap_url: url,
        content,
        status_code: response.status,
        content_type: mime === "text/plain" ? "text/plain" : "application/xml",
      });
      if (index === 0 && content) {
        const discovered = sitemapIndexChildUrls({ site_url: origin + "/",
          documents: [documents[0]] });
        for (const child of discovered) {
          if (queue.length >= 3) break;
          if (safeHttpResourceUrl(child) && new URL(child).origin === origin &&
            !queue.includes(child)) queue.push(child);
        }
      }
    } catch {
      incomplete = true;
      if (index === 0) throw new Error("The public sitemap cannot be sampled within network and byte limits.");
    }
  }
  if (!documents.length) throw new Error("No sitemap response was observed.");
  const review = analyzeSitemapInventory({ site_url: origin + "/", documents },
    "live_public_sitemap_sample");
  if (incomplete) {
    review.error = "One or more sitemap documents could not be read within the safe network and representation limits.";
  }
  return review;
}
