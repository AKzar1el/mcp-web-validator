import puppeteer from "puppeteer";
import * as path from "path";
import * as fs from "fs/promises";

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
  const viewports = customViewports && customViewports.length > 0 ? customViewports : DEFAULT_VIEWPORTS;

  // Resolve target to file:// URL if it is a local file path
  let targetUrl = targetPath;
  if (!targetPath.startsWith("http://") && !targetPath.startsWith("https://")) {
    const absolutePath = path.resolve(targetPath);
    targetUrl = `file://${absolutePath.replace(/\\/g, "/")}`;
  }

  // Ensure output directory exists
  await fs.mkdir(outputDirectory, { recursive: true });

  // Launch browser in headless mode
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const results: ScreenshotResult[] = [];

  try {
    const page = await browser.newPage();

    for (const vp of viewports) {
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1
      });

      // Load URL (wait until network is idle or DOM loaded)
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      // Short wait for any animations or layout adjustments to settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      const fileName = `${vp.name}_${vp.width}x${vp.height}.png`;
      const outputPath = path.join(outputDirectory, fileName);

      await page.screenshot({
        path: outputPath,
        fullPage: false // Captures above the fold viewport
      });

      results.push({
        viewportName: vp.name,
        width: vp.width,
        height: vp.height,
        outputPath: path.resolve(outputPath)
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}
