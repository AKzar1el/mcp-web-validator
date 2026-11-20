import {
  fetchPublicHtml, fetchPublicText, PublicHtmlFetchError, PublicHttpProbeBudgetError,
} from "../../network";
import { toPublicHttpUrl } from "../../audits";
import {
  isAllowedForFetcher, analyzeCrawlerAccess, MAX_CRAWLER_ROBOTS_BYTES,
} from "../http-crawl/crawler-access";
import {
  analyzeInternalLinkGraph, graphLiveTargets, MAX_GRAPH_LIVE_PAGES,
  type GraphPageInput, type InternalLinkGraphReview,
} from "./internal-link-graph";

/**
 * V06 hosted public sample: one robots.txt plus at most three guarded page GETs.
 * No Googlebot impersonation, browser, scheduled crawl, page storage or
 * indexing verdict; per-request limiter provided by the MCP registration.
 */
export async function probeInternalLinkGraph(
  value: string,
  beforeRequest?: () => Promise<void>,
): Promise<InternalLinkGraphReview> {
  const site = toPublicHttpUrl(value);
  if (!site || value.includes("?") || value.includes("#")) {
    throw new Error("Use a safe, query-free authorized public entry URL.");
  }
  const origin = site.origin;
  let robotsText: string | undefined;
  let robotsStatus: number | undefined;
  try {
    const robots = await fetchPublicText(origin + "/robots.txt", {
      allowedOrigin: origin, acceptedContentTypes: ["text/plain"],
      maxBytes: MAX_CRAWLER_ROBOTS_BYTES, maxRedirects: 0, beforeRequest,
    });
    robotsStatus = robots.status;
    robotsText = robots.text;
  } catch (cause) {
    if (cause instanceof PublicHttpProbeBudgetError) throw cause;
    if (cause instanceof PublicHtmlFetchError && cause.status !== undefined) {
      robotsStatus = cause.status;
    }
  }
  const queue = [site.href];
  const visited = new Set<string>();
  const pages: GraphPageInput[] = [];
  for (let index = 0; index < queue.length && pages.length < MAX_GRAPH_LIVE_PAGES; index++) {
    const url = queue[index];
    if (visited.has(url)) continue;
    visited.add(url);
    const allowed = robotsText !== undefined
      ? isAllowedForFetcher(robotsText, url)
      : robotsStatus === 404 || robotsStatus === 410 ? true : undefined;
    if (allowed !== true) {
      pages.push({ url, ...(allowed === false ? { robots_allowed: false } : {}) });
      continue;
    }
    const page: GraphPageInput = { url, robots_allowed: true };
    let html: string | undefined;
    try {
      const result = await fetchPublicHtml(url, {
        allowedOrigin: origin, allowRedirect: () => false, beforeRequest,
      });
      page.status_code = result.status;
      page.html = result.html;
      html = result.html;
      if (result.xRobotsTag) {
        const headers = analyzeCrawlerAccess({
          site_url: origin + "/",
          pages: [{ url, status_code: result.status, x_robots_tag: [result.xRobotsTag] }],
          profiles: ["googlebot-smartphone"],
        });
        if (headers.rows[0]?.indexing_state === "explicit_noindex") page.noindex = true;
      }
    } catch (cause) {
      if (cause instanceof PublicHttpProbeBudgetError) throw cause;
      if (cause instanceof PublicHtmlFetchError && cause.status !== undefined) {
        page.status_code = cause.status;
      }
    }
    pages.push(page);
    if (html && pages.length < MAX_GRAPH_LIVE_PAGES) {
      for (const target of graphLiveTargets(html, url)) {
        if (queue.length >= MAX_GRAPH_LIVE_PAGES) break;
        if (queue.includes(target) || visited.has(target)) continue;
        const next = toPublicHttpUrl(target);
        if (next && next.origin === origin && !target.includes("?") && !target.includes("#")) {
          queue.push(next.href);
        }
      }
    }
  }
  const result = analyzeInternalLinkGraph({
    site_url: origin + "/", pages, entry_urls: [site.href],
  }, "live_bounded_public_link_graph");
  if (robotsText === undefined && robotsStatus !== 404 && robotsStatus !== 410) {
    result.error = "Robots.txt access could not be verified; page fetches were not attempted.";
  }
  return result;
}
