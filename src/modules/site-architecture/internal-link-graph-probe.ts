import { fetchPublicHttp, readResponseText, resolvePublicHttpUrl } from "../../network.js";
import { safeHttpResourceUrl } from "../http-crawl/non-html-directives.js";
import {
  isAllowedForFetcher, MAX_CRAWLER_ROBOTS_BYTES, analyzeCrawlerAccess,
} from "../http-crawl/crawler-access.js";
import {
  analyzeInternalLinkGraph, graphLiveTargets, MAX_GRAPH_HTML_BYTES,
  MAX_GRAPH_LIVE_PAGES, type GraphPageInput, type InternalLinkGraphReview,
} from "./internal-link-graph.js";

async function closeResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Already consumed or closed. */ }
}

/**
 * Bounded, guarded V06 live sampling. One robots.txt and at most three pages.
 * Never impersonate Googlebot; never follow redirects, query variants, JS,
 * off-origin links, or disallowed/unverified robots paths.
 */
export async function probeInternalLinkGraph(url: string): Promise<InternalLinkGraphReview> {
  const safe = safeHttpResourceUrl(url);
  if (!safe) throw new Error("Use one authorized, query-free public HTTP(S) entry URL.");
  await resolvePublicHttpUrl(safe);
  const origin = new URL(safe).origin;
  let robotsText: string | undefined;
  let robotsStatus: number | undefined;
  try {
    const { response } = await fetchPublicHttp(origin + "/robots.txt", {
      method: "GET", timeoutMs: 12_000, maxRedirects: 0,
      headers: { accept: "text/plain", "user-agent": "DigestSEO-Web-Validator/1.3" },
    });
    robotsStatus = response.status;
    try {
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (response.status === 200 && (!type || type === "text/plain")) {
        robotsText = await readResponseText(response, MAX_CRAWLER_ROBOTS_BYTES);
      }
    } finally { await closeResponse(response); }
  } catch { /* Unknown robots permission fails closed for further GETs. */ }

  const queue = [safe];
  const sampled = new Set<string>();
  const pages: GraphPageInput[] = [];
  for (let at = 0; at < queue.length && pages.length < MAX_GRAPH_LIVE_PAGES; at++) {
    const next = queue[at];
    if (sampled.has(next)) continue;
    sampled.add(next);
    const permission = robotsText !== undefined
      ? isAllowedForFetcher(robotsText, next)
      : robotsStatus === 404 || robotsStatus === 410 ? true : undefined;
    if (permission !== true) {
      pages.push({ url: next, ...(permission === false ? { robots_allowed: false } : {}) });
      continue;
    }
    const row: GraphPageInput = { url: next, robots_allowed: true };
    let html: string | undefined;
    try {
      const { response } = await fetchPublicHttp(next, {
        method: "GET", timeoutMs: 12_000, maxRedirects: 0,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "DigestSEO-Web-Validator/1.3",
        },
      });
      row.status_code = response.status;
      try {
        const xRobots = response.headers.get("x-robots-tag");
        if (xRobots) {
          const observed = analyzeCrawlerAccess({
            site_url: origin + "/", pages: [{
              url: next, status_code: response.status,
              x_robots_tag: [xRobots],
            }], profiles: ["googlebot-smartphone"],
          });
          if (observed.rows[0]?.indexing_state === "explicit_noindex") row.noindex = true;
        }
        const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
        if (response.status >= 200 && response.status < 300 &&
          (mime === "text/html" || mime === "application/xhtml+xml")) {
          try {
            const charset = /(?:^|;)\s*charset\s*=\s*"?([^;\s"]+)/iu
              .exec(response.headers.get("content-type") ?? "")?.[1];
            html = await readResponseText(response, MAX_GRAPH_HTML_BYTES, charset);
            row.html = html;
          } catch { /* HTML evidence absent instead of a false clean graph. */ }
        }
      } finally { await closeResponse(response); }
    } catch { /* Preserve unknown request outcome, not a fabricated HTTP error. */ }
    pages.push(row);
    if (html && pages.length < MAX_GRAPH_LIVE_PAGES) {
      for (const target of graphLiveTargets(html, next)) {
        if (queue.length >= MAX_GRAPH_LIVE_PAGES) break;
        if (sampled.has(target) || queue.includes(target)) continue;
        if (safeHttpResourceUrl(target) && new URL(target).origin === origin) queue.push(target);
      }
    }
  }
  const report = analyzeInternalLinkGraph({
    site_url: origin + "/", entry_urls: [safe], pages,
  }, "live_bounded_public_link_graph");
  if (robotsText === undefined && robotsStatus !== 404 && robotsStatus !== 410) {
    report.error = "Robots.txt permission could not be verified; no page requests were made.";
  }
  return report;
}
