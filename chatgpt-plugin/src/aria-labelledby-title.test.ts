import { describe, expect, it } from "vitest";
import { auditSeoMetadata } from "./audits";

describe("aria-labelledby referenced title", () => {
  it("accepts title on a directly referenced HTML label element", () => {
    for (const [html, code] of [
      ['<span id="label" title="Search"></span><input type="image" src="search.png" aria-labelledby="label">', "accessibility.input_image_alt.missing_or_empty"],
      ['<span id="label" title="Account settings"></span><iframe src="/account" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
      ['<span id="label" title="Quarterly revenue chart"></span><img src="chart.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
      ['<span id="label" title="Revenue chart"></span><div role="img" aria-labelledby="label"></div>', "accessibility.image_alt.missing"],
      ['<span id="label" title="Revenue chart"></span><svg role="img" aria-labelledby="label"></svg>', "accessibility.image_alt.missing"],
      ['<span id="label" title="Documentation"></span><map name="nav"><area href="/docs" aria-labelledby="label"></map>', "accessibility.area_alt.missing_or_empty"],
    ] as const) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === code)).toBeUndefined();
    }
  });

  it("does not treat an SVG title attribute as HTML title fallback", () => {
    const html = '<svg><g id="label" title="Not an SVG accessible name"></g></svg><img src="chart.png" aria-labelledby="label">';
    expect(auditSeoMetadata(html).issues.some((issue) => issue.code === "accessibility.image_alt.missing")).toBe(true);
  });

  it("still uses descendant SVG title text", () => {
    const html = '<svg><g id="label"><title>SVG label</title></g></svg><img src="chart.png" aria-labelledby="label">';
    expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")).toBeUndefined();
  });

  it("uses the directly referenced HTML alt or button value", () => {
    for (const [html, code] of [
      ['<img id="label" src="brand.png" alt="Brand logo"><iframe src="/details" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
      ['<map name="nav"><area id="label" href="/docs" alt="Documentation"></map><img src="chart.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
      ['<input id="label" type="image" src="search.png" alt="Search"><div role="img" aria-labelledby="label"></div>', "accessibility.image_alt.missing"],
      ['<input id="label" type="button" value="Account"><iframe src="/account" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
      ['<input id="label" type="submit" value="Submit"><img src="status.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
      ['<input id="label" type="reset" value="Reset"><svg role="img" aria-labelledby="label"></svg>', "accessibility.image_alt.missing"],
    ] as const) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === code), html).toBeUndefined();
    }
  });

  it("does not resolve whitespace native alternatives", () => {
    for (const html of [
      '<img id="label" src="brand.png" alt="  "><iframe src="/account" aria-labelledby="label"></iframe>',
      '<input id="label" type="button" value="  "><iframe src="/account" aria-labelledby="label"></iframe>',
    ]) {
      expect(auditSeoMetadata(html).issues.some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), html).toBe(true);
    }
  });
  it("excludes hidden descendants of visible references but preserves directly referenced hidden roots", () => {
    for (const hidden of [
      "hidden",
      'aria-hidden="true"',
      'style="display: none"',
      'style="visibility: hidden"',
      'style="content-visibility: hidden"',
    ]) {
      const html = `<span id="ref"><b ${hidden}>Invisible</b></span><img src="chart.png" aria-labelledby="ref">`;
      expect(auditSeoMetadata(html).issues.some((issue) => issue.code === "accessibility.image_alt.missing"), html).toBe(true);
    }
    for (const html of [
      '<span id="ref" hidden><b hidden>Directly referenced hidden subtree</b></span><img src="chart.png" aria-labelledby="ref">',
      '<span id="ref"><b hidden>Invisible</b><b>Visible name</b></span><img src="chart.png" aria-labelledby="ref">',
    ]) {
      expect(auditSeoMetadata(html).issues.some((issue) => issue.code === "accessibility.image_alt.missing"), html).toBe(false);
    }
  });
});
