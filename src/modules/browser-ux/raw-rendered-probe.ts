/**
 * Local-only V07 Chromium evidence. Supplied or publicly fetched HTML is
 * loaded into a fresh offline browser, executing inline JS ONLY. No page URL
 * navigation, third-party or first-party subresources, cookies, credentials,
 * local files, screenshots or persistent browser profile.
 */
import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import {
  defaultScreenshotBrowserRuntime, type ScreenshotBrowserRuntime,
} from "../../screenshot.js";
import {
  fetchPublicHttp, readResponseText, resolvePublicHttpUrl,
} from "../../network.js";
import {
  isAllowedForFetcher, MAX_CRAWLER_ROBOTS_BYTES,
} from "../http-crawl/crawler-access.js";
import { safeHttpResourceUrl } from "../http-crawl/non-html-directives.js";
import {
  analyzeRawRendered, MAX_RENDER_HTML_BYTES, MAX_RENDER_BROWSER_MS,
  type RawRenderedReview, type RenderScope,
} from "./raw-rendered-diff.js";

const DENY_ALL_PROXY = "http://127.0.0.1:9";
const SERVICE_UA = "DigestSEO-Web-Validator/1.3";
// parse5's serializer is recursive; the byte cap alone does not bound its stack.
const MAX_RENDER_DOM_DEPTH = 512;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const guard = (value: string) => {
  const safe = safeHttpResourceUrl(value);
  if (!safe) throw new Error("Supply one safe public query-free HTTP(S) page URL.");
  return safe;
};
async function cancel(response: Response) {
  try { await response.body?.cancel(); } catch { /* Already exhausted. */ }
}

function assertSerializableDepth(root: AnyNode): void {
  const pending = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (depth > MAX_RENDER_DOM_DEPTH) {
      throw new Error("Normalized source HTML exceeds the render DOM depth cap.");
    }
    if ("children" in node) {
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }
  }
}

/**
 * Render supplied static HTML with scripts allowed, but external script/src,
 * embedded frames, meta refresh and all network requests blocked. A real
 * Google WRS render requires external assets and is NOT simulated here.
 */
export async function renderInlineHtml(
  rawHtml: string, pageUrl: string,
  runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
  scope: RenderScope = "isolated_inline_script_chromium",
): Promise<RawRenderedReview> {
  guard(pageUrl);
  if (typeof rawHtml !== "string" || !rawHtml.trim() ||
    bytes(rawHtml) > MAX_RENDER_HTML_BYTES) {
    throw new Error("Raw HTML exceeds the bounded render input limit.");
  }
  const $ = load(rawHtml);
  // Inline JavaScript is the only executable source allowed into Chromium.
  $("script[src],iframe,frame,frameset,object,embed,portal").remove();
  $('meta[http-equiv="refresh" i]').remove();
  assertSerializableDepth($.root()[0]!);
  const sanitized = $.html();
  if (bytes(sanitized) > MAX_RENDER_HTML_BYTES) {
    throw new Error("Normalized source HTML exceeds the render byte cap.");
  }
  let browser: Awaited<ReturnType<ScreenshotBrowserRuntime["launch"]>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pendingError: unknown;
  try {
    browser = await runtime.launch(DENY_ALL_PROXY);
    deadline = setTimeout(() => {
      void browser?.close().catch(() => {});
    }, MAX_RENDER_BROWSER_MS);
    deadline.unref?.();
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(8_000);
    await page.setViewport({ width: 960, height: 720, deviceScaleFactor: 1 });
    await page.setJavaScriptEnabled(true);
    // Block *all* requests, including localhost and first-party script assets.
    await page.setOfflineMode(true);
    let blocked = 0, scriptErrors = 0;
    page.on("pageerror", () => { scriptErrors++; });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      blocked++;
      void request.abort("blockedbyclient").catch(() => {});
    });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    await page.setContent(sanitized, { waitUntil: "domcontentloaded", timeout: 8_000 });
    // Give a bounded microtask/short-timer opportunity without waiting for
    // network idle. Browser work is capped by the separate close deadline.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const renderedHtml = await page.content();
    if (bytes(renderedHtml) > MAX_RENDER_HTML_BYTES) {
      throw new Error("The rendered DOM exceeded the bounded snapshot size.");
    }
    return analyzeRawRendered({
      page_url: pageUrl, raw_html: rawHtml, rendered_html: renderedHtml,
    }, {
      scope, browser_executed: true, inline_scripts_attempted: true,
      external_resources_blocked: blocked, script_errors_observed: scriptErrors,
    });
  } catch (cause) {
    pendingError = cause;
    throw cause;
  } finally {
    if (deadline) clearTimeout(deadline);
    try { if (browser) await browser.close(); }
    catch (cause) { if (!pendingError) throw cause; }
  }
}

/** Shared V07/V09 guarded single-public-HTML source fetch.
 * Exactly one robots.txt and one page GET; never follows redirects. */
export async function fetchGuardedPublicHtml(url: string): Promise<{
  page_url: string; raw_html: string;
}> {
  const safe = guard(url);
  await resolvePublicHttpUrl(safe);
  const origin = new URL(safe).origin;
  let robotsTxt: string | undefined;
  let robotsStatus: number | undefined;
  try {
    const { response } = await fetchPublicHttp(origin + "/robots.txt", {
      method: "GET", maxRedirects: 0, timeoutMs: 12_000,
      headers: { accept: "text/plain", "user-agent": SERVICE_UA },
    });
    robotsStatus = response.status;
    try {
      const type = response.headers.get("content-type")
        ?.split(";", 1)[0].trim().toLowerCase();
      if (response.status === 200 && (!type || type === "text/plain")) {
        robotsTxt = await readResponseText(response, MAX_CRAWLER_ROBOTS_BYTES);
      }
    } finally { await cancel(response); }
  } catch { /* Unknown robots permission is not assumed allowed. */ }

  const allowed = robotsTxt !== undefined
    ? isAllowedForFetcher(robotsTxt, safe)
    : robotsStatus === 404 || robotsStatus === 410 ? true : undefined;
  if (allowed !== true) {
    throw new Error("The public page is robots-disallowed or crawl permission is unknown.");
  }
  const { response } = await fetchPublicHttp(safe, {
    method: "GET", maxRedirects: 0, timeoutMs: 12_000,
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": SERVICE_UA },
  });
  let rawHtml: string;
  try {
    const mime = response.headers.get("content-type")
      ?.split(";", 1)[0].trim().toLowerCase();
    if (response.status !== 200 ||
      (mime !== "text/html" && mime !== "application/xhtml+xml") ||
      response.headers.get("cf-mitigated") === "challenge") {
      throw new Error("The public HTTP sample is not a complete ordinary HTML 200 response.");
    }
    const charset = /(?:^|;)\s*charset\s*=\s*"?([^;\s"]+)/iu
      .exec(response.headers.get("content-type") ?? "")?.[1];
    rawHtml = await readResponseText(response, MAX_RENDER_HTML_BYTES, charset, !charset);
  } finally { await cancel(response); }
  return { page_url: safe, raw_html: rawHtml };
}

/** Fetch one authorized public HTML response, robots-gated, then render
 * a resource-denied inline-script DOM sample in local Chromium. */
export async function reviewPublicInlineDom(
  url: string,
  runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
): Promise<RawRenderedReview> {
  const source = await fetchGuardedPublicHtml(url);
  return renderInlineHtml(source.raw_html, source.page_url, runtime,
    "isolated_public_html_inline_script_sample");
}
