import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectBrowserPlatform } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

import {
  captureScreenshots,
  resolveScreenshotBrowserExecutable,
  SCREENSHOT_BROWSER_BUILD_ID,
} from "../dist/screenshot.js";

async function assertProxyListenerClosed(proxyUrl) {
  assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(fetch(proxyUrl), (error) => {
    assert.equal(error?.cause?.code, "ECONNREFUSED");
    return true;
  });
}

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

test("screenshot cleanup preserves capture error and closes proxy when browser.close rejects", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-close-error-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "fixture.html");
  await fs.writeFile(targetPath, "<!doctype html><title>Fixture</title>");
  const captureError = new Error("Fixture page initialization failed");
  let proxyUrl;

  await assert.rejects(
    captureScreenshots(targetPath, directory, [{ name: "test", width: 375, height: 812 }], {
      async launch(url) {
        proxyUrl = url;
        return {
          async newPage() { throw captureError; },
          async close() { throw new Error("Fixture browser shutdown failed"); },
        };
      },
    }),
    (error) => error === captureError,
  );

  await assertProxyListenerClosed(proxyUrl);
});

test("screenshot cleanup reports browser close failure but still closes proxy after capture", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-close-success-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "fixture.html");
  await fs.writeFile(targetPath, "<!doctype html><title>Fixture</title>");
  const closeError = new Error("Fixture browser shutdown failed");
  let proxyUrl;

  await assert.rejects(
    captureScreenshots(targetPath, directory, [{ name: "test", width: 375, height: 812 }], {
      async launch(url) {
        proxyUrl = url;
        return {
          async newPage() {
            return {
              setDefaultNavigationTimeout() {},
              async setRequestInterception() {},
              on() {},
              async setViewport() {},
              async goto() {},
              async screenshot() {},
            };
          },
          async close() { throw closeError; },
        };
      },
    }),
    (error) => error === closeError,
  );

  await assertProxyListenerClosed(proxyUrl);
});

test("screenshot rejects main-document HTTP errors without creating captures", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-http-error-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "fixture.html");
  await fs.writeFile(targetPath, "<!doctype html><title>Fixture</title>");

  for (const status of [404, 503]) {
    let proxyUrl;
    let screenshotCalls = 0;
    let closeCalls = 0;
    const runtime = {
      async launch(url) {
        proxyUrl = url;
        return {
          async newPage() {
            return {
              setDefaultNavigationTimeout() {},
              async setRequestInterception() {},
              on() {},
              async setViewport() {},
              async goto() { return { status: () => status }; },
              async screenshot() { screenshotCalls += 1; },
            };
          },
          async close() { closeCalls += 1; },
        };
      },
    };

    await assert.rejects(
      captureScreenshots(targetPath, directory, [{ name: "test", width: 375, height: 812 }], runtime),
      new RegExp(`Screenshot navigation failed: HTTP ${status}`),
    );
    assert.equal(screenshotCalls, 0);
    assert.equal(closeCalls, 1);
    await assertProxyListenerClosed(proxyUrl);
  }
});

test("screenshot permits successful and non-HTTP document navigations", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-http-ok-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "fixture.html");
  await fs.writeFile(targetPath, "<!doctype html><title>Fixture</title>");

  for (const status of [200, null]) {
    let proxyUrl;
    let screenshotCalls = 0;
    const runtime = {
      async launch(url) {
        proxyUrl = url;
        return {
          async newPage() {
            return {
              setDefaultNavigationTimeout() {},
              async setRequestInterception() {},
              on() {},
              async setViewport() {},
              async goto() { return status === null ? null : { status: () => status }; },
              async screenshot() { screenshotCalls += 1; },
            };
          },
          async close() {},
        };
      },
    };
    const captures = await captureScreenshots(targetPath, directory, [{ name: "test", width: 375, height: 812 }], runtime);
    assert.equal(captures.length, 1);
    assert.equal(screenshotCalls, 1);
    await assertProxyListenerClosed(proxyUrl);
  }
});

test("screenshot failure after a successful viewport preserves completed output paths", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-web-validator-partial-screenshots-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "fixture.html");
  await fs.writeFile(targetPath, "<!doctype html><title>Fixture</title>");
  let navigationCount = 0;
  let proxyUrl;
  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 375, height: 812 },
  ];
  await assert.rejects(
    captureScreenshots(targetPath, directory, viewports, {
      async launch(url) {
        proxyUrl = url;
        return {
          async newPage() {
            return {
              setDefaultNavigationTimeout() {},
              async setRequestInterception() {},
              on() {},
              async setViewport() {},
              async goto() {
                if (++navigationCount === 2) throw new Error("fixture mobile navigation failed");
                return { status: () => 200 };
              },
              async screenshot({ path: outputPath }) { await fs.writeFile(outputPath, "fixture png"); },
            };
          },
          async close() {},
        };
      },
    }),
    (error) => {
      assert.match(error.message, /fixture mobile navigation failed/);
      assert.deepEqual(error.screenshots?.map(({ viewportName }) => viewportName), ["desktop"]);
      assert.equal(error.screenshots[0].outputPath, path.join(directory, "desktop_1440x900.png"));
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(directory, "desktop_1440x900.png"), "utf8"), "fixture png");
  await assert.rejects(fs.stat(path.join(directory, "mobile_375x812.png")), { code: "ENOENT" });
  await assertProxyListenerClosed(proxyUrl);
});
