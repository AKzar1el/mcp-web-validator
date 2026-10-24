import assert from "node:assert/strict";
import test from "node:test";
import { auditSeoMetadata } from "../dist/seo-auditor.js";

test("aria-labelledby accepts a directly referenced HTML title as the accessible name", () => {
  for (const [html, code] of [
    ['<span id="label" title="Search"></span><input type="image" src="search.png" aria-labelledby="label">', "accessibility.input_image_alt.missing_or_empty"],
    ['<span id="label" title="Account settings"></span><iframe src="/account" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<span id="label" title="Quarterly revenue chart"></span><img src="chart.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
    ['<span id="label" title="Revenue chart"></span><div role="img" aria-labelledby="label"></div>', "accessibility.image_alt.missing"],
    ['<span id="label" title="Revenue chart"></span><svg role="img" aria-labelledby="label"></svg>', "accessibility.image_alt.missing"],
    ['<span id="label" title="Documentation"></span><map name="nav"><area href="/docs" aria-labelledby="label"></map>', "accessibility.area_alt.missing_or_empty"],
  ]) {
    assert.equal(auditSeoMetadata(html).find((issue) => issue.code === code), undefined);
  }
});

test("aria-labelledby does not treat an SVG title attribute as HTML title fallback", () => {
  const html = '<svg><g id="label" title="Not an SVG accessible name"></g></svg><img src="chart.png" aria-labelledby="label">';
  assert.ok(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"));
});

test("aria-labelledby still uses descendant SVG title text", () => {
  const html = '<svg><g id="label"><title>SVG label</title></g></svg><img src="chart.png" aria-labelledby="label">';
  assert.equal(auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"), undefined);
});
