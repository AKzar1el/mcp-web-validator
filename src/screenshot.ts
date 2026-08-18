import puppeteer from "puppeteer";
import * as path from "path";
import * as fs from "fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPublicHttpUrl, getErrorMessage } from "./network.js";

export interface ViewportConfig {
  name: string;
  width: number;
  height: number;
}

export interface ScreenshotResult {
  viewportName: string;
  width: number;
  height: number;
  outputPath: string;
}

const DEFAULT_VIEWPORTS: ViewportConfig[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 }
];

const MAX_VIEWPORTS = 10;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 7_680;
const SAFE_VIEWPORT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const NAVIGATION_TIMEOUT_MS = 30_000;

interface InterceptedRequest {
  url(): string;
  isInterceptResolutionHandled(): boolean;
  continue(): Promise<unknown>;
  abort(errorCode?: string): Promise<unknown>;
}

function validateViewports(viewports: ViewportConfig[]): ViewportConfig[] {
  if (viewports.length === 0 || viewports.length > MAX_VIEWPORTS) {
    throw new Error(`Between 1 and ${MAX_VIEWPORTS} viewports are required`);
  }

  const outputNames = new Set<string>();
  return viewports.map((viewport, index) => {
    if (!viewport || typeof viewport !== "object") {
      throw new Error(`Viewport #${index + 1} must be an object`);
    }
    if (typeof viewport.name !== "string" || !SAFE_VIEWPORT_NAME.test(viewport.name)) {
      throw new Error(
        `Viewport #${index + 1} name must match ${SAFE_VIEWPORT_NAME.source}`,
      );
    }
    for (const [label, value] of [["width", viewport.width], ["height", viewport.height]] as const) {
      if (
        !Number.isSafeInteger(value)
        || value < MIN_VIEWPORT_DIMENSION
        || value > MAX_VIEWPORT_DIMENSION
      ) {
        throw new Error(
          `Viewport #${index + 1} ${label} must be an integer between ${MIN_VIEWPORT_DIMENSION} and ${MAX_VIEWPORT_DIMENSION}`,
        );
      }
    }

    const outputName = `${viewport.name}_${viewport.width}x${viewport.height}.png`.toLowerCase();
    if (outputNames.has(outputName)) {
      throw new Error(`Duplicate viewport output filename: ${outputName}`);
    }
    outputNames.add(outputName);
    return { name: viewport.name, width: viewport.width, height: viewport.height };
  });
}

function resolveContainedOutputPath(outputDirectory: string, fileName: string): string {
  const outputPath = path.resolve(outputDirectory, fileName);
  const relativePath = path.relative(outputDirectory, outputPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Screenshot output path escapes the requested output directory");
  }
  return outputPath;
}

function isPathWithinDirectory(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function assertLocalScreenshotRequestAllowed(requestUrl: URL, localDirectory: string): Promise<void> {
  if (requestUrl.hostname) {
    throw new Error("Blocked local file request with a host name");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(fileURLToPath(requestUrl));
  } catch (error: unknown) {
    throw new Error(`Blocked local file request: ${getErrorMessage(error)}`);
  }

  if (!isPathWithinDirectory(localDirectory, resolvedPath)) {
    throw new Error("Blocked local file request outside the selected file directory");
  }
}

async function assertScreenshotRequestAllowed(requestUrl: string, localDirectory?: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    throw new Error("Blocked invalid page request URL");
  }

  if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
    await assertPublicHttpUrl(parsedUrl);
    return;
  }

  if (parsedUrl.protocol === "data:" || parsedUrl.protocol === "blob:") {
    return;
  }

  if (parsedUrl.protocol === "file:" && localDirectory) {
    await assertLocalScreenshotRequestAllowed(parsedUrl, localDirectory);
    return;
  }

  throw new Error(`Blocked unsupported page request protocol ${parsedUrl.protocol}`);
}

async function resolveScreenshotRequest(
  request: InterceptedRequest,
  localDirectory: string | undefined,
  onBlocked: (message: string) => void,
): Promise<void> {
  if (request.isInterceptResolutionHandled()) {
    return;
  }

  try {
    await assertScreenshotRequestAllowed(request.url(), localDirectory);
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    await request.continue();
  } catch (error: unknown) {
    onBlocked(getErrorMessage(error));
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    await request.abort("blockedbyclient");
  }
}

/**
 * Captures screenshots of a local HTML file or remote URL at different viewport sizes.
 * @param targetPath Local file path or HTTP(S) URL
 * @param outputDirectory Absolute path to save screenshots
 * @param customViewports Optional custom viewport settings
 */
export async function captureScreenshots(
  targetPath: string,
  outputDirectory: string,
  customViewports?: ViewportConfig[]
): Promise<ScreenshotResult[]> {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error("targetPath must be a non-empty string");
  }
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw new Error("outputDirectory must be a non-empty string");
  }

  const viewports = validateViewports(
    customViewports && customViewports.length > 0 ? customViewports : DEFAULT_VIEWPORTS,
  );
  const resolvedOutputDirectory = path.resolve(outputDirectory);

  // Resolve target to file:// URL if it is a local file path
  let targetUrl: string;
  let localDirectory: string | undefined;
  if (/^https?:\/\//i.test(targetPath)) {
    targetUrl = (await assertPublicHttpUrl(targetPath)).href;
  } else {
    const absolutePath = path.resolve(targetPath);
    const resolvedPath = await fs.realpath(absolutePath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Screenshot target is not a regular file: ${resolvedPath}`);
    }
    localDirectory = path.dirname(resolvedPath);
    targetUrl = pathToFileURL(resolvedPath).href;
  }

  // Ensure output directory exists
  await fs.mkdir(resolvedOutputDirectory, { recursive: true });

  // Launch browser in headless mode
  const browser = await puppeteer.launch({
    headless: true,
  });

  const results: ScreenshotResult[] = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    let blockedRequestMessage: string | undefined;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void resolveScreenshotRequest(request, localDirectory, (message) => {
        blockedRequestMessage ??= message;
      }).catch(() => {
        // Puppeteer will surface navigation failures; avoid an unhandled listener rejection.
      });
    });

    for (const vp of viewports) {
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1
      });

      // Load URL (wait until network is idle or DOM loaded)
      try {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error: unknown) {
        if (blockedRequestMessage) {
          throw new Error(`Screenshot navigation blocked: ${blockedRequestMessage}`);
        }
        throw new Error(`Screenshot navigation failed: ${getErrorMessage(error)}`);
      }

      // Short wait for any animations or layout adjustments to settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      const fileName = `${vp.name}_${vp.width}x${vp.height}.png`;
      const outputPath = resolveContainedOutputPath(resolvedOutputDirectory, fileName);

      await page.screenshot({
        path: outputPath,
        fullPage: false // Captures above the fold viewport
      });

      results.push({
        viewportName: vp.name,
        width: vp.width,
        height: vp.height,
        outputPath
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}
