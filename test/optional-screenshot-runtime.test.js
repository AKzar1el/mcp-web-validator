import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectBrowserPlatform } from "@puppeteer/browsers";

import {
  resolveScreenshotBrowserExecutable,
  SCREENSHOT_BROWSER_BUILD_ID,
} from "../dist/screenshot.js";

test("published runtime avoids Puppeteer's install-time browser downloader", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.dependencies?.puppeteer, undefined);
  assert.equal(packageJson.dependencies?.["puppeteer-core"], "25.7.0");
  assert.equal(packageJson.dependencies?.["@puppeteer/browsers"], "3.2.0");
  assert.equal(packageJson.devDependencies?.puppeteer, "25.7.0");
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
