import {
  fetchPublicText, fetchPublicHtml, PublicHtmlFetchError,
} from "../../network";
import { toPublicHttpUrl } from "../../audits";
import {
  analyzeCrawlerAccess, isAllowedForFetcher,
  MAX_CRAWLER_ROBOTS_BYTES, MAX_CRAWLER_HTML_BYTES,
  type CrawlerAccessPage, type CrawlerAccessReview, type CrawlerProfile,
} from "./crawler-access";

/**
 * Live V03 uses only the service's own User-Agent; it does not claim to
 * impersonate Googlebot/Bingbot or verify actual crawler access.
 *
 * Disallowed/unavailable robots stops the HTML request. Both fetch helpers
 * apply public-URL guards and charge the caller's per-request budget.
 */
export async function probeCrawlerAccess(
  url: string,
  profiles?: CrawlerProfile[],
  beforeRequest?: () => Promise<void>,
): Promise<CrawlerAccessReview> {
  const safe = toPublicHttpUrl(url);
  if (!safe || url.includes("?") || url.includes("#")) {
    throw new Error("Use one query-free public HTTP(S) URL.");
  }
  let robots_txt: string | undefined;
  let robots_status_code: number | undefined;
  try {
    const robots = await fetchPublicText(new URL("/robots.txt", safe.origin).href, {
      allowedOrigin: safe.origin,
      acceptedContentTypes: ["text/plain"],
      maxBytes: MAX_CRAWLER_ROBOTS_BYTES,
      maxRedirects: 0,
      beforeRequest,
    });
    robots_status_code = robots.status;
    robots_txt = robots.text;
  } catch (cause) {
    if (cause instanceof PublicHtmlFetchError && cause.status !== undefined) {
      robots_status_code = cause.status;
    } else if (cause instanceof Error && cause.name === "PublicHttpProbeBudgetError") {
      throw cause;
    }
  }
  const allowed = robots_txt !== undefined
    ? isAllowedForFetcher(robots_txt, safe.href)
    : robots_status_code === 404 || robots_status_code === 410;
  const page: CrawlerAccessPage = { url: safe.href };
  if (allowed === true) {
    try {
      const fetched = await fetchPublicHtml(safe.href, {
        allowedOrigin: safe.origin,
        allowRedirect: () => false,
        beforeRequest,
      });
      page.status_code = fetched.status;
      page.x_robots_tag = fetched.xRobotsTag ? [fetched.xRobotsTag] : [];
      if (new TextEncoder().encode(fetched.html).byteLength <= MAX_CRAWLER_HTML_BYTES) {
        page.html = fetched.html;
      }
    } catch (cause) {
      if (cause instanceof PublicHtmlFetchError && cause.status !== undefined) {
        page.status_code = cause.status;
      } else if (cause instanceof Error && cause.name === "PublicHttpProbeBudgetError") {
        throw cause;
      }
    }
  }
  return analyzeCrawlerAccess({
    site_url: safe.origin + "/",
    robots_txt, robots_status_code,
    pages: [page],
    ...(profiles ? { profiles } : {}),
  }, "live_public_crawler_probe");
}
