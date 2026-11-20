import {
  fetchPublicText, PublicHtmlFetchError, PublicHttpProbeBudgetError,
} from "../../network";
import { toPublicHttpUrl } from "../../audits";
import {
  analyzeSitemapInventory, sitemapIndexChildUrls, sitemapFromRobotsTxt,
  MAX_SITEMAP_DOCUMENT_BYTES,
  type SitemapInputDocument, type SitemapInventoryReview,
} from "./sitemap-inventory";

/**
 * V05 hosted point-in-time sitemap sample: one initial public sitemap and up to
 * two query-free same-origin child sitemap documents. No page GETs and no
 * raw XML or URL output. Every attempted GET consumes a rate-limit token.
 */
export async function probeSitemapInventory(
  siteUrl: string,
  sitemapUrl?: string,
  beforeRequest?: () => Promise<void>,
): Promise<SitemapInventoryReview> {
  const site = toPublicHttpUrl(siteUrl);
  if (!site || siteUrl.includes("?") || siteUrl.includes("#")) {
    throw new Error("Use one safe query-free public site URL.");
  }
  const origin = site.origin;
  let first = sitemapUrl ?? origin + "/sitemap.xml";
  if (!sitemapUrl) {
    try {
      const robots = await fetchPublicText(origin + "/robots.txt", {
        allowedOrigin: origin,
        acceptedContentTypes: ["text/plain"],
        maxBytes: 64_000, maxRedirects: 0, beforeRequest,
      });
      first = sitemapFromRobotsTxt(origin + "/", robots.text) ?? first;
    } catch (cause) {
      if (cause instanceof PublicHttpProbeBudgetError) throw cause;
      // Default to one safe, query-free same-origin sitemap path.
    }
  }
  const root = toPublicHttpUrl(first);
  if (!root || root.origin !== origin || first.includes("?") || first.includes("#")) {
    throw new Error("Sitemap URL must be a safe query-free same-origin URL.");
  }
  const queue = [root.href];
  const documents: SitemapInputDocument[] = [];
  const seen = new Set<string>();
  let incomplete = false;
  for (let i = 0; i < queue.length && documents.length < 3; i++) {
    const url = queue[i];
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const response = await fetchPublicText(url, {
        allowedOrigin: origin,
        acceptedContentTypes: ["application/xml", "text/xml", "text/plain"],
        maxBytes: MAX_SITEMAP_DOCUMENT_BYTES,
        maxRedirects: 0, allowGzipSitemap: true,
        beforeRequest,
      });
      const item: SitemapInputDocument = {
        sitemap_url: url, status_code: response.status,
        content: response.text,
        content_type: response.contentType === "text/plain"
          ? "text/plain" : "application/xml",
      };
      documents.push(item);
      if (i === 0) {
        const candidates = sitemapIndexChildUrls({ site_url: origin + "/",
          documents: [item] });
        for (const child of candidates) {
          if (queue.length >= 3) break;
          const safe = toPublicHttpUrl(child);
          if (safe && safe.origin === origin && !child.includes("?") &&
            !child.includes("#") && !queue.includes(safe.href)) queue.push(safe.href);
        }
      }
    } catch (cause) {
      if (cause instanceof PublicHttpProbeBudgetError) throw cause;
      const code = cause instanceof PublicHtmlFetchError ? cause.status : undefined;
      if (code !== undefined) {
        documents.push({ sitemap_url: url, content: "", status_code: code });
      } else {
        incomplete = true;
        if (i === 0) throw new Error("The public sitemap could not be inspected.");
      }
    }
  }
  if (!documents.length) throw new Error("No sitemap response was sampled.");
  const report = analyzeSitemapInventory({ site_url: origin + "/", documents },
    "live_public_sitemap_sample");
  if (incomplete) {
    report.error = "One or more sitemap documents were not fetched within bounded public HTTP limits.";
  }
  return report;
}
