import test from "node:test";
import assert from "node:assert/strict";
import * as screenshotModule from "../dist/screenshot.js";

test("MCPB screenshot capture uses Puppeteer's bundled headless shell", () => {
  assert.equal(screenshotModule.SCREENSHOT_HEADLESS_MODE, "shell");
});
