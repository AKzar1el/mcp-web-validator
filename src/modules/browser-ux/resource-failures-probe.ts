import {
  assertPublicHttpUrl, fetchPublicHttp, readResponseText, resolvePublicHttpUrl,
} from "../../network.js";
import {
  defaultScreenshotBrowserRuntime, type ScreenshotBrowserRuntime,
} from "../../screenshot.js";
import { startScreenshotTransportProxy } from "../../screenshot-proxy.js";
import { safeHttpResourceUrl } from "../http-crawl/non-html-directives.js";
import {
  isAllowedForFetcher, MAX_CRAWLER_ROBOTS_BYTES,
} from "../http-crawl/crawler-access.js";
import {
  analyzeResourceFailures, MAX_RESOURCE_BROWSER_MS, MAX_RESOURCE_OBSERVATIONS,
  RESOURCE_TYPES, type ResourceType, type ResourceFailureReason,
  type ResourceObservation, type ResourceFailureReview,
} from "./resource-failures.js";

/** Normalize browser failures to redacted reason groups; no error strings leak. */
export function classifyResourceNetworkFailure(
  raw: string | undefined,
): ResourceFailureReason {
  const value = (raw ?? "").toUpperCase();
  if (/NAME_NOT_RESOLVED|DNS|NAME_RESOLUTION/iu.test(value)) return "dns";
  if (/TIMED_OUT|TIMEOUT/iu.test(value)) return "timeout";
  if (/CERT_|SSL_|TLS_/iu.test(value)) return "tls";
  if (/CONNECTION_|NETWORK_CHANGED|INTERNET_DISCONNECTED/iu.test(value)) return "connection";
  if (/ABORTED|CANCELLED/iu.test(value)) return "canceled";
  return "other";
}
export function browserResourceType(value: string | undefined): ResourceType {
  return RESOURCE_TYPES.includes(value as ResourceType) ? value as ResourceType : "other";
}
/** Browser-side page scripts may issue mutations; never permit those methods. */
export function isReadOnlyBrowserResourceMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
async function cancel(response: Response) {
  try { await response.body?.cancel(); } catch { /* Already consumed. */ }
}

export interface ResourceBrowserOptions {
  includeThirdParty?: boolean;
}
export async function inspectPublicResourceLoading(
  inputUrl: string,
  options: ResourceBrowserOptions = {},
  runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
): Promise<ResourceFailureReview> {
  const url = safeHttpResourceUrl(inputUrl);
  if (!url) throw new Error("Use a safe, query-free public HTTP(S) page URL.");
  if (options.includeThirdParty !== undefined &&
    typeof options.includeThirdParty !== "boolean") {
    throw new Error("The third-party request option must be Boolean.");
  }
  const site = await resolvePublicHttpUrl(url);
  const origin = site.url.origin;
  let robots: string | undefined;
  let robotsStatus: number | undefined;
  try {
    const { response } = await fetchPublicHttp(origin + "/robots.txt", {
      method: "GET", maxRedirects: 0, timeoutMs: 12_000,
      headers: { accept: "text/plain", "user-agent": "DigestSEO-Web-Validator/1.3" },
    });
    robotsStatus = response.status;
    try {
      const mime = response.headers.get("content-type")
        ?.split(";", 1)[0].trim().toLowerCase();
      if (response.status === 200 && (!mime || mime === "text/plain")) {
        robots = await readResponseText(response, MAX_CRAWLER_ROBOTS_BYTES);
      }
    } finally { await cancel(response); }
  } catch { /* Unverified robots access fails closed. */ }
  const allowed = robots !== undefined
    ? isAllowedForFetcher(robots, url)
    : robotsStatus === 404 || robotsStatus === 410 ? true : undefined;
  if (allowed !== true) throw new Error("Robots access is disallowed or unverified.");

  let proxyPolicyBlocks = 0;
  const proxy = await startScreenshotTransportProxy(() => { proxyPolicyBlocks++; });
  let browser: Awaited<ReturnType<ScreenshotBrowserRuntime["launch"]>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pendingError: unknown;
  const observations: ResourceObservation[] = [];
  const mapped = new WeakMap<object, { index: number; started: number }>();
  const responseStatuses = new WeakMap<object, number>();
  let additionalBudgetBlocked = 0;
  let navigationCompleted = false;
  const permittedOrigins = new Set<string>([origin]);

  try {
    browser = await runtime.launch(proxy.url);
    deadline = setTimeout(() => {
      void browser?.close().catch(() => {});
    }, MAX_RESOURCE_BROWSER_MS);
    deadline.unref?.();
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(12_000);
    await page.setViewport({ width: 1200, height: 850, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const type = browserResourceType(request.resourceType());
      let target: URL | undefined;
      try { target = new URL(request.url()); }
      catch { /* Invalid URL is blocked and counted without echo. */ }
      const external = target && target.origin !== origin;
      if (observations.length >= MAX_RESOURCE_OBSERVATIONS) {
        additionalBudgetBlocked = Math.min(1_000_000, additionalBudgetBlocked + 1);
        void request.abort("blockedbyclient").catch(() => {});
        return;
      }
      const row: ResourceObservation = {
        resource_type: type,
        origin: !target ? "unknown" : external ? "third_party" : "same_origin",
        outcome: "pending",
      };
      const index = observations.push(row) - 1;
      mapped.set(request, { index, started: Date.now() });
      const deny = () => {
        row.outcome = "tool_blocked";
        void request.abort("blockedbyclient").catch(() => {});
      };
      if (!target || !["https:", "http:"].includes(target.protocol) ||
        target.username || target.password || target.port ||
        !isReadOnlyBrowserResourceMethod(request.method()) ||
        (type === "document" && target.href !== url) ||
        type === "media" || (external && options.includeThirdParty !== true)) {
        deny();
        return;
      }
      if (external && target && !permittedOrigins.has(target.origin)) {
        if (permittedOrigins.size >= 4) { deny(); return; }
        permittedOrigins.add(target.origin);
      }
      // The screenshot proxy also performs DNS-pinned public-address checks.
      // Validate before continuing each browser request, preventing local/SSRF
      // fetches while retaining the HTTPS proxy's safe network behavior.
      void assertPublicHttpUrl(target.href).then(() => {
        if (!request.isInterceptResolutionHandled()) {
          return request.continue();
        }
      }).catch(() => deny());
    });
    page.on("response", (response) => {
      const req = response.request();
      const info = mapped.get(req);
      if (!info) return;
      const row = observations[info.index];
      if (row.outcome !== "pending") return;
      // Receiving response headers does not prove a complete body download.
      // Puppeteer's requestfinished event establishes a completed HTTP fetch.
      responseStatuses.set(req, response.status());
    });
    page.on("requestfinished", (request) => {
      const info = mapped.get(request);
      if (!info) return;
      const row = observations[info.index];
      const status = responseStatuses.get(request);
      if (row.outcome === "pending" && status !== undefined) {
        row.outcome = "http";
        row.status_code = status;
        row.duration_ms = Math.max(0, Date.now() - info.started);
      }
    });
    page.on("requestfailed", (request) => {
      const info = mapped.get(request);
      if (!info) return;
      const row = observations[info.index];
      if (row.outcome === "tool_blocked") return;
      row.outcome = "transport_failed";
      row.status_code = undefined;
      row.duration_ms = Math.max(0, Date.now() - info.started);
      row.failure_reason = classifyResourceNetworkFailure(
        request.failure()?.errorText);
    });

    try {
      const main = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 12_000,
      });
      navigationCompleted = Boolean(main);
    } catch {
      // Keep observed HTTP responses/transport failures rather than
      // fabricating a success, timeout status or page content.
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (observations.length === 0) {
      throw new Error("The browser emitted no observable requests.");
    }
    const result = analyzeResourceFailures({
      observations, additional_budget_blocked: additionalBudgetBlocked,
      navigation_completed: navigationCompleted,
    }, "guarded_public_browser_resources");
    // Proxy blocks are a tool/network safeguard, not proof that a resource
    // from the site returned an HTTP error. Do not propagate private targets.
    if (proxyPolicyBlocks) {
      result.error = "Some URLs were rejected by the guarded public HTTP proxy; affected browser requests require independent verification.";
    }
    return result;
  } catch (cause) {
    pendingError = cause;
    throw cause;
  } finally {
    if (deadline) clearTimeout(deadline);
    let cleanupFailure: unknown;
    try {
      if (browser) await browser.close();
    } catch (cause) {
      if (!pendingError) cleanupFailure = cause;
    }
    try { await proxy.close(); }
    catch (cause) { if (!pendingError && !cleanupFailure) cleanupFailure = cause; }
    if (cleanupFailure) throw cleanupFailure;
  }
}
