import { fetchPublicHttp, readResponseText, resolvePublicHttpUrl } from "../../network.js";
import {
  analyzeCrawlerAccess, isAllowedForFetcher,
  MAX_CRAWLER_HTML_BYTES, MAX_CRAWLER_ROBOTS_BYTES,
  type CrawlerAccessReview, type CrawlerProfile, type CrawlerAccessPage,
} from "./crawler-access.js";
import { safeHttpResourceUrl } from "./non-html-directives.js";

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Already closed. */ }
}

/**
 * Live V03 fetch: one robots.txt and at most one public page. No bot-UA
 * impersonation. No fetch if robots is unavailable or blocks our own UA.
 */
export async function probeCrawlerAccess(
  input: string,
  profiles?: CrawlerProfile[],
): Promise<CrawlerAccessReview> {
  const safe = safeHttpResourceUrl(input);
  if (!safe) throw new Error("Use one safe query-free public page URL.");
  await resolvePublicHttpUrl(safe);
  const target = new URL(safe);
  const robotsUrl = new URL("/robots.txt", target.origin);
  let robots_txt: string | undefined;
  let robots_status_code: number | undefined;
  try {
    const { response } = await fetchPublicHttp(robotsUrl, {
      method: "GET", timeoutMs: 12_000, maxRedirects: 0,
      headers: { accept: "text/plain", "user-agent": "DigestSEO-Web-Validator/1.3" },
    });
    robots_status_code = response.status;
    if (response.status === 200) {
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (!type || type === "text/plain") {
        robots_txt = await readResponseText(response, MAX_CRAWLER_ROBOTS_BYTES);
      } else await cancel(response);
    } else await cancel(response);
  } catch {
    // Robots availability cannot be presumed from a transport failure.
  }

  const allowed = robots_txt !== undefined
    ? isAllowedForFetcher(robots_txt, safe)
    : robots_status_code === 404 || robots_status_code === 410;
  const page: CrawlerAccessPage = { url: safe };
  if (allowed === true) {
    try {
      const { response } = await fetchPublicHttp(safe, {
        method: "GET", timeoutMs: 12_000, maxRedirects: 0,
        headers: { accept: "text/html,application/xhtml+xml",
          "user-agent": "DigestSEO-Web-Validator/1.3" },
      });
      page.status_code = response.status;
      page.x_robots_tag = response.headers.has("x-robots-tag")
        ? [response.headers.get("x-robots-tag") ?? ""] : [];
      const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (response.status >= 200 && response.status < 300 &&
        (mime === "text/html" || mime === "application/xhtml+xml")) {
        try {
          const charset = /(?:^|;)\s*charset\s*=\s*"?([^;\s"]+)/i
            .exec(response.headers.get("content-type") ?? "")?.[1];
          page.html = await readResponseText(response, MAX_CRAWLER_HTML_BYTES, charset);
        } catch { /* Unknown HTML evidence is safer than a false clean result. */ }
      } else await cancel(response);
    } catch {
      // Keep page HTTP and indexing evidence unknown after a failed request.
    }
  }
  return analyzeCrawlerAccess({
    site_url: target.origin + "/", robots_txt, robots_status_code,
    pages: [page], ...(profiles ? { profiles } : {}),
  }, "live_public_crawler_probe");
}
