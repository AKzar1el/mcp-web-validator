import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureScreenshots } from "../dist/screenshot.js";
import { reviewWcagInteractions } from "../dist/modules/browser-ux/wcag-interactions.js";
import { renderInlineHtml } from "../dist/modules/browser-ux/raw-rendered-probe.js";
import { inspectViewportParity } from "../dist/modules/browser-ux/viewport-parity-probe.js";
import { inspectOfflineLighthouseLab } from "../dist/modules/browser-ux/lighthouse-lab-probe.js";

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

  const compareOutputDirectory = path.join(temporaryDirectory, "compared");
  const compared = await captureScreenshots(
    targetPath,
    compareOutputDirectory,
    [{ name: "smoke", width: 800, height: 600 }],
    undefined,
    outputDirectory,
  );
  assert.equal(compared[0]?.visualDiff?.status, "compared");
  assert.equal(compared[0]?.visualDiff?.pixels_compared, 800 * 600);
  assert.ok(compared[0]?.visualDiff?.changed_percent >= 0);
  assert.ok(compared[0]?.visualDiff?.changed_percent <= 100);

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
    { maxTabSteps: 8, includeAxe: true },
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
  assert.equal(review.axe?.status, "complete");
  assert.ok(review.axe.violations >= 1);
  assert.ok(review.axe.rules.length >= 1);
  assert.equal(review.axe.coverage_limited, true);
  assert.equal(JSON.stringify(review).includes("127.0.0.1/private-resource"), false);
  assert(!JSON.stringify(review).includes("/private-resource"));
  const rendered = await renderInlineHtml(
    '<!doctype html><html><head><title>Source</title></head><body>'
    + '<main><div id="app">Unhydrated shell</div></main>'
    + '<script>document.getElementById("app").innerHTML = '
    + '"<h1>Hydrated title</h1><a href=/client-only>Client link</a>";</script>'
    + '<img src="https://example.com/external-blocked.png">'
    + '</body></html>',
    "https://example.com/",
  );
  assert.equal(rendered.browser_executed, true);
  assert.equal(rendered.inline_scripts_attempted, true);
  assert.equal(rendered.raw.h1_count, 0);
  assert.equal(rendered.rendered.h1_count, 1);
  assert.equal(rendered.link_targets_added, 1);
  assert.equal(rendered.coverage_limited, true);
  assert(!JSON.stringify(rendered).includes("/client-only"));

  const viewport = await inspectViewportParity(
    '<!doctype html><html><head>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Viewport test</title>'
    + '<script type="application/ld+json">{"@type":"WebPage"}</script>'
    + '<style>@media(max-width:600px){.desktop-nav{display:none}.wide{width:650px}}'
    + 'summary{padding:16px;display:list-item}</style></head><body>'
    + '<nav class="desktop-nav"><a href="/desktop-only-visible">Desktop</a></nav>'
    + '<main><h1>Identical primary heading</h1><p>'
    + 'Identical descriptive sample content stays in the DOM for desktop and '
    + 'mobile views despite layout-dependent visibility of navigation controls.'
    + '</p><details><summary>Safe disclosure</summary><p>Details text</p></details>'
    + '<div class="wide">Wide mobile CSS fixture</div>'
    + '<button aria-label="Keyboard fixture">Button</button></main>'
    + '<script>throw Error("this script must not execute")</script>'
    + '</body></html>',
    "https://example.com/",
  );
  assert.equal(viewport.browser_executed, true);
  assert.equal(viewport.scripts_disabled, true);
  assert.equal(viewport.mobile.width, 375);
  assert.equal(viewport.desktop.width, 1440);
  assert.equal(viewport.mobile.jsonld_blocks, 1);
  assert.equal(viewport.desktop.jsonld_blocks, 1);
  assert.equal(viewport.mobile_missing_dom_tokens, 0);
  assert.equal(viewport.mobile_missing_internal_links, 0);
  assert.equal(viewport.mobile.visible_nav_links, 0);
  assert.equal(viewport.desktop.visible_nav_links, 1);
  assert(viewport.mobile.horizontal_overflow_px >= 20);
  assert.equal(viewport.mobile.disclosure_toggled, true);
  assert.equal(viewport.desktop.disclosure_toggled, true);
  assert(viewport.findings.some((f) => f.code === "mobile_navigation_less"));
  assert(viewport.findings.some((f) => f.code === "mobile_horizontal_overflow"));
  assert(!JSON.stringify(viewport).includes("/desktop-only-visible"));

  const lab = await inspectOfflineLighthouseLab(
    '<!doctype html><html><head><title>V11 lab fixture</title>'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<style>body{font-family:Arial,sans-serif;margin:16px;}h1{font-size:34px;}</style>'
      + '</head><body><main><h1>V11 isolated test</h1>'
      + '<p>Real Lighthouse metrics from a static fixture with no external assets.</p>'
      + '<script>throw new Error("Untrusted V11 code must not run")</script>'
      + '<img src="http://127.0.0.1:49999/secret">'
      + '</main></body></html>',
    "mobile",
  );
  assert.equal(lab.browser_executed, true);
  assert.equal(lab.network_isolated, true);
  assert.equal(lab.scripts_disabled, true);
  assert.equal(lab.form_factor, "mobile");
  assert.equal(lab.status, "complete");
  assert.ok(lab.performance_score_percent !== null);
  assert.ok(lab.metrics.fcp_ms !== null);
  assert.ok(lab.metrics.lcp_ms !== null);
  assert.ok(lab.metrics.tbt_ms !== null);
  assert.ok(lab.metrics.speed_index_ms !== null);
  assert.ok(lab.metrics.cls !== null);
  assert(!JSON.stringify(lab).includes("Untrusted V11"));
  assert(!JSON.stringify(lab).includes("/secret"));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
