import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectBrowserPlatform } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

import {
  resolveScreenshotBrowserExecutable,
  SCREENSHOT_BROWSER_BUILD_ID,
} from "../dist/screenshot.js";

test("published runtime avoids Puppeteer's install-time browser downloader", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const puppeteerCoreVersion = packageJson.dependencies?.["puppeteer-core"];
  const browsersVersion = packageJson.dependencies?.["@puppeteer/browsers"];

  assert.equal(packageJson.dependencies?.puppeteer, undefined);
  assert.match(puppeteerCoreVersion, /^\d+\.\d+\.\d+$/);
  assert.match(browsersVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.devDependencies?.puppeteer, puppeteerCoreVersion);
});

test("screenshot browser pin matches puppeteer-core's supported headless shell", () => {
  assert.equal(SCREENSHOT_BROWSER_BUILD_ID, PUPPETEER_REVISIONS["chrome-headless-shell"]);
});

test("first screenshot browser resolution can install the pinned headless shell lazily", async (t) => {
  const platform = detectBrowserPlatform();
  if (!platform) {
    t.skip("Current platform is unsupported by Puppeteer's browser manager");
    return;
  }

  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-browser-cache-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const fakeExecutable = path.join(cacheDir, "fake-headless-shell");
  let installCalls = 0;
  const resolved = await resolveScreenshotBrowserExecutable({
    cacheDir,
    platform,
    installer: async (options) => {
      installCalls += 1;
      assert.equal(options.buildId, SCREENSHOT_BROWSER_BUILD_ID);
      await fs.writeFile(fakeExecutable, "fixture");
      return { executablePath: fakeExecutable };
    },
  });

  assert.equal(resolved, fakeExecutable);
  assert.equal(installCalls, 1);
});

test("Linux screenshot sandbox errors give safe actionable diagnostics", async () => {
  const { explainScreenshotBrowserLaunchFailure } = await import("../dist/screenshot.js");
  const original = new Error("Failed to launch browser process! No usable sandbox!");
  const diagnostic = explainScreenshotBrowserLaunchFailure(original, "linux");
  assert.match(diagnostic.message, /AppArmor|user namespace/i);
  assert.match(diagnostic.message, /sandbox/i);
  assert.match(diagnostic.message, /do not disable|keep.*enabled/i);
  assert.equal(diagnostic.cause, original);
  const unrelated = new Error("Browser executable was not found");
  assert.equal(explainScreenshotBrowserLaunchFailure(unrelated, "linux"), unrelated);
  assert.equal(explainScreenshotBrowserLaunchFailure(original, "win32"), original);
});
