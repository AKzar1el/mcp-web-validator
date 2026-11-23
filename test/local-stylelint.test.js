import assert from "node:assert/strict";
import test from "node:test";
import { lintCssLocally } from "../dist/stylelint-validator.js";

test("local Stylelint reports concrete rule failures without echoing source CSS", async () => {
  const privateMarker = "private-selector-should-not-leak-6324";
  const report = await lintCssLocally(
    "." + privateMarker + " { color: #ggg; color: red; mystery-property: 20q; }",
  );
  assert.ok(report.total >= 2);
  assert.ok(report.counts.error >= 2);
  assert.ok(report.messages.some((item) => item.message.includes("color-no-invalid-hex")));
  assert.ok(report.messages.some((item) =>
    item.message.includes("declaration-block-no-duplicate-properties")));
  assert.ok(report.messages.every((item) => !JSON.stringify(item).includes(privateMarker)));
});

test("normal modern CSS is not reported broken by a minimal local lint profile", async () => {
  const report = await lintCssLocally(
    "@container (min-width: 400px) { .grid { display: grid; gap: 1rem; color: rebeccapurple; } }",
  );
  assert.equal(report.counts.error, 0);
  assert.equal(report.total, 0);
});

test("oversized local CSS fails rather than returning a clean report", async () => {
  await assert.rejects(lintCssLocally("a".repeat(128_001)), /byte limit/);
});

test("local CSS diagnostics honor message caps and full severity totals", async () => {
  const css = Array.from({ length: 245 }, (_, i) =>
    ".a" + i + " { color: #ggg; }").join("\n");
  const report = await lintCssLocally(css);
  assert.equal(report.total, 245);
  assert.equal(report.counts.error, 245);
  assert.equal(report.messages.length, 200);
  assert.equal(report.truncated, true);
});
