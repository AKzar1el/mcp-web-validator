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

test("aria-labelledby uses the directly referenced HTML alt or button value", () => {
  for (const [html, code] of [
    ['<img id="label" src="brand.png" alt="Brand logo"><iframe src="/details" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<map name="nav"><area id="label" href="/docs" alt="Documentation"></map><img src="chart.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
    ['<input id="label" type="image" src="search.png" alt="Search"><div role="img" aria-labelledby="label"></div>', "accessibility.image_alt.missing"],
    ['<input id="label" type="button" value="Account"><iframe src="/account" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<input id="label" type="submit" value="Submit"><img src="status.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
    ['<input id="label" type="reset" value="Reset"><svg role="img" aria-labelledby="label"></svg>', "accessibility.image_alt.missing"],
  ]) {
    assert.equal(auditSeoMetadata(html).find((issue) => issue.code === code), undefined, html);
  }
});

test("whitespace native alternatives do not resolve an aria-labelledby reference", () => {
  for (const html of [
    '<img id="label" src="brand.png" alt="  "><iframe src="/account" aria-labelledby="label"></iframe>',
    '<input id="label" type="button" value="  "><iframe src="/account" aria-labelledby="label"></iframe>',
  ]) {
    assert.ok(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), html);
  }
});


test("aria-labelledby includes a directly referenced editable text input value", () => {
  for (const [html, code] of [
    ['<input id="ref" type="text" value="Current answer"><img src="chart.png" aria-labelledby="ref">', "accessibility.image_alt.missing"],
    ['<input id="ref" value="Search query"><iframe src="/details" aria-labelledby="ref"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<input id="ref" type="search" value="Site audit"><div role="img" aria-labelledby="ref"></div>', "accessibility.image_alt.missing"],
    ['<input id="ref" type="email" value="user@example.com"><svg role="img" aria-labelledby="ref"></svg>', "accessibility.image_alt.missing"],
  ]) {
    assert.equal(auditSeoMetadata(html).find((issue) => issue.code === code), undefined, html);
  }
  for (const html of [
    '<input id="ref" type="text" value="  "><img src="chart.png" aria-labelledby="ref">',
    '<input id="ref" type="password" value="secret"><img src="chart.png" aria-labelledby="ref">',
    '<input id="ref" type="hidden" value="secret"><img src="chart.png" aria-labelledby="ref">',
    '<input id="ref" type="checkbox" value="Yes"><img src="chart.png" aria-labelledby="ref">',
  ]) {
    assert.ok(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), html);
  }
});
