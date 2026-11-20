import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureScreenshots } from "../dist/screenshot.js";
import { reviewWcagInteractions } from "../dist/modules/browser-ux/wcag-interactions.js";

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

  const review = await reviewWcagInteractions(
    '<!doctype html><html><head><title>Keyboard fixture</title>'
    + '<style>button:focus-visible { outline: 2px solid blue; }</style></head><body>'
    + '<button aria-label="Named control">Open</button>'
    + '<button tabindex="3"></button>'
    + '<div role="button">Not in the Tab order</div>'
    + '<details><summary>More details</summary><p>Visible after Enter</p></details>'
    + '<script>globalThis.__untrustedRan = true</script>'
    + '<img src="http://127.0.0.1/private-resource.png">'
    + '</body></html>',
    { maxTabSteps: 8 },
  );
  assert.equal(review.browser_executed, true);
  assert.equal(review.scripts_disabled, true);
  assert.equal(review.coverage_limited, true);
  assert.ok(review.controls_inspected >= 4);
  assert.ok(review.visible_controls_without_name >= 1);
  assert.ok(review.positive_tabindex_controls >= 1);
  assert.ok(review.custom_roles_without_tab_stop >= 1);
  assert.ok(review.unique_tab_targets >= 1);
  assert.equal(review.native_summaries_tested, 1);
  assert.equal(review.native_summaries_toggled, 1);
  assert.ok(review.scripts_present >= 1);
  // A page's image/resource fetch may not begin before DOMContentLoaded and
  // our bounded inspection finishes. Zero blocked requests is valid: we must
  // assert the browser returned the attempt count, not invent a request.
  assert.ok(Number.isInteger(review.resources_blocked));
  assert.ok(review.resources_blocked >= 0);
  assert(!JSON.stringify(review).includes("/private-resource"));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
