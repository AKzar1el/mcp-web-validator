import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureScreenshots } from "../dist/screenshot.js";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "mcp-web-validator-screenshot-smoke-"));

try {
  const targetPath = path.join(temporaryDirectory, "fixture.html");
  const outputDirectory = path.join(temporaryDirectory, "screenshots");
  await writeFile(targetPath, "<!doctype html><title>Screenshot smoke</title><h1>Screenshot smoke</h1>");

  const screenshots = await captureScreenshots(targetPath, outputDirectory, [
    { name: "smoke", width: 800, height: 600 },
  ]);

  assert.equal(screenshots.length, 1);
  assert.equal(screenshots[0]?.viewportName, "smoke");
  assert.ok((await stat(screenshots[0].outputPath)).size > 0);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
