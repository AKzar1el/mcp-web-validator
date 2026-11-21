/**
 * V11-LAB: execute the real Lighthouse engine against one inert HTML sample,
 * through a one-off loopback proxy that serves only a synthetic invalid domain.
 * No arbitrary localhost, public network or page-origin requests are forwarded.
 */
import * as http from "node:http";
import * as net from "node:net";
import { load } from "cheerio";
import {
  defaultScreenshotBrowserRuntime,
  type ScreenshotBrowserRuntime,
} from "../../screenshot.js";
import {
  analyzeLighthouseLabResult,
  MAX_LAB_BROWSER_MS, MAX_LAB_HTML_BYTES, MAX_LAB_PROXY_REQUESTS,
  type LabFactor, type LabReview, type LighthouseResultLike,
} from "./lighthouse-lab.js";

const LAB_URL = "http://v11-lighthouse.invalid/";
const LOCALHOST = "127.0.0.1";
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** Lighthouse 13 requires Node >=22.19; optional runtime stays absent on older Node. */
export function lighthouseSupportedNode(version: string = process.versions.node): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!parts) return false;
  const major = Number(parts[1]), minor = Number(parts[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

export function sanitizeLighthouseLabHtml(html: string): string {
  if (typeof html !== "string" || !html.trim() ||
      byteLength(html) > MAX_LAB_HTML_BYTES) {
    throw new Error("Provide between 1 and 180,000 UTF-8 bytes of static HTML");
  }
  const $ = load(html);
  $("script,iframe,frame,frameset,object,embed,portal,applet,base").remove();
  $('meta[http-equiv="refresh" i]').remove();
  $("link[href]").remove();
  $("*").each((_, element) => {
    if (!("attribs" in element) || !element.attribs) return;
    for (const name of Object.keys(element.attribs)) {
      if (/^on[a-z]+$/iu.test(name) || ["srcdoc", "formaction"].includes(name.toLowerCase())) {
        $(element).removeAttr(name);
      }
    }
  });
  const sanitized = $.html();
  if (byteLength(sanitized) > MAX_LAB_HTML_BYTES) {
    throw new Error("Normalized static HTML exceeds the Lighthouse lab byte limit");
  }
  return sanitized;
}
export interface LabProxy {
  url: string;
  deniedRequests(): number;
  servedRequests(): number;
  close(): Promise<void>;
}
export async function startOfflineLighthouseProxy(html: string): Promise<LabProxy> {
  const body = new TextEncoder().encode(html);
  const sockets = new Set<net.Socket>();
  let denied = 0;
  let served = 0;
  let attempted = 0;
  const deny = (response: http.ServerResponse, status = 403) => {
    denied = Math.min(MAX_LAB_PROXY_REQUESTS, denied + 1);
    response.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store" });
    response.end();
  };
  const server = http.createServer((request, response) => {
    attempted++;
    if (attempted > MAX_LAB_PROXY_REQUESTS ||
        !["GET", "HEAD"].includes(request.method ?? "") ||
        request.url !== LAB_URL ||
        request.headers["proxy-authorization"] !== undefined) {
      deny(response, attempted > MAX_LAB_PROXY_REQUESTS ? 429 : 403);
      return;
    }
    served++;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": String(body.byteLength),
      // The synthetic fixture can load inline styles but no executable script,
      // network fetch, form action or frame. DevTools evaluation is unaffected.
      "Content-Security-Policy":
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  server.on("connect", (_request, socket) => { denied++; socket.destroy(); });
  server.on("upgrade", (_request, socket) => { denied++; socket.destroy(); });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, LOCALHOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not bind an isolated loopback Lighthouse lab proxy");
  }
  let closed = false;
  return {
    url: `http://${LOCALHOST}:${address.port}`,
    deniedRequests: () => Math.min(MAX_LAB_PROXY_REQUESTS, denied),
    servedRequests: () => served,
    async close() {
      if (closed) return;
      closed = true;
      const completion = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await completion;
    },
  };
}
type LighthouseRunner = (
  url: string, flags: Record<string, unknown>,
) => Promise<{ lhr: LighthouseResultLike } | undefined>;
export interface LabRuntime {
  browser: ScreenshotBrowserRuntime;
  lighthouse: LighthouseRunner;
}
async function defaultLighthouseRunner(url: string, flags: Record<string, unknown>) {
  // This is an optional local-only dependency: dynamically load it at
  // runtime rather than forcing TypeScript to resolve it on Node 22.12 CI.
  const packageName = "lighthouse";
  const loaded = await import(packageName);
  const lighthouse = loaded.default as LighthouseRunner;
  return lighthouse(url, flags);
}
export async function inspectOfflineLighthouseLab(
  html: string,
  factor: LabFactor = "mobile",
  runtime: LabRuntime = { browser: defaultScreenshotBrowserRuntime, lighthouse: defaultLighthouseRunner },
): Promise<LabReview> {
  if (!lighthouseSupportedNode() && runtime.lighthouse === defaultLighthouseRunner) {
    throw new Error("The optional Lighthouse 13 runtime requires Node.js >=22.19");
  }
  if (!["mobile", "desktop"].includes(factor)) throw new Error("Invalid Lighthouse form factor");
  const sample = sanitizeLighthouseLabHtml(html);
  const proxy = await startOfflineLighthouseProxy(sample);
  let browser: Awaited<ReturnType<ScreenshotBrowserRuntime["launch"]>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pendingError: unknown;
  try {
    browser = await runtime.browser.launch(proxy.url);
    const endpoint = new URL(browser.wsEndpoint());
    const port = Number(endpoint.port);
    if (endpoint.protocol !== "ws:" || endpoint.hostname !== LOCALHOST ||
        !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("The isolated browser did not supply a local debugging endpoint");
    }
    const flags: Record<string, unknown> = {
      port, hostname: LOCALHOST, onlyCategories: ["performance"],
      output: "json", logLevel: "silent", throttlingMethod: "simulate",
      maxWaitForLoad: 15_000, disableFullPageScreenshot: true,
      formFactor: factor,
      screenEmulation: factor === "mobile"
        ? { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false }
        : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        void browser?.close().catch(() => {});
        reject(new Error("Lighthouse lab browser deadline exceeded"));
      }, MAX_LAB_BROWSER_MS);
      deadline.unref?.();
    });
    // Closing Chrome alone may not resolve a stuck Lighthouse promise. The
    // explicit race guarantees a bounded MCP response even in that case.
    const result = await Promise.race([runtime.lighthouse(LAB_URL, flags), timeout]);
    if (proxy.servedRequests() === 0) {
      throw new Error("Lighthouse did not load the isolated static document");
    }
    return analyzeLighthouseLabResult(result?.lhr, factor, proxy.deniedRequests());
  } catch (cause) {
    pendingError = cause;
    throw cause;
  } finally {
    if (deadline) clearTimeout(deadline);
    let cleanupFailure: unknown;
    try { if (browser) await browser.close(); }
    catch (cause) { if (!pendingError) cleanupFailure = cause; }
    try { await proxy.close(); }
    catch (cause) { if (!pendingError && !cleanupFailure) cleanupFailure = cause; }
    if (cleanupFailure) throw cleanupFailure;
  }
}
