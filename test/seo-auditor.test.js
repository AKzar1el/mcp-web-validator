import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSeoMetadata,
  auditSeoMetadataDetailed,
  MAX_AUDIT_ISSUES,
  validateSchemaMarkup,
  validateSchemaMarkupDetailed,
} from "../dist/seo-auditor.js";

function lengthIssue(html, prefix) {
  return auditSeoMetadata(html).find((issue) => issue.message.startsWith(prefix));
}

test("SEO editorial length diagnostics count visible graphemes instead of UTF-16 units", () => {
  const symbol = String.fromCodePoint(0x1f680);
  const shortPage = `<title>${symbol.repeat(20)}</title><meta name="description" content="${symbol.repeat(75)}">`;
  assert.match(lengthIssue(shortPage, "Title is")?.message ?? "", /^Title is 20 characters\. This is shorter/);
  assert.match(lengthIssue(shortPage, "Meta description is")?.message ?? "", /^Meta description is 75 characters\. This is shorter/);

  const ordinaryPage = `<title>${symbol.repeat(40)}</title><meta name="description" content="${symbol.repeat(140)}">`;
  assert.equal(lengthIssue(ordinaryPage, "Title is"), undefined);
  assert.equal(lengthIssue(ordinaryPage, "Meta description is"), undefined);

  const combiningMarkPage = `<title>${"e\u0301".repeat(20)}</title>`;
  assert.match(lengthIssue(combiningMarkPage, "Title is")?.message ?? "", /^Title is 20 characters\. This is shorter/);
});

test("SEO audit reports the full total while bounding returned findings", () => {
  const images = Array.from(
    { length: MAX_AUDIT_ISSUES + 5 },
    (_, index) => `<img src="image-${index}.png">`,
  ).join("");
  const html = `<html><head></head><body><h1>Page</h1>${images}</body></html>`;

  const detailed = auditSeoMetadataDetailed(html);
  assert.equal(detailed.issues.length, MAX_AUDIT_ISSUES);
  assert.ok(detailed.totalIssues > MAX_AUDIT_ISSUES);
  assert.equal(detailed.truncated, true);
  assert.equal(
    detailed.counts.error + detailed.counts.warning + detailed.counts.info,
    detailed.totalIssues,
  );
  assert.equal(auditSeoMetadata(html).length, MAX_AUDIT_ISSUES);
});

test("SEO audit bounds diagnostic element snippets from oversized page metadata", () => {
  const oversized = "A".repeat(10_000);
  const html = `<html><head><title>${oversized}</title><meta name="description" content="${oversized}"></head></html>`;
  const detailed = auditSeoMetadataDetailed(html);
  const titleIssue = detailed.issues.find((issue) => issue.code === "seo.title.length");
  const descriptionIssue = detailed.issues.find((issue) => issue.code === "seo.meta_description.length");

  assert.ok(titleIssue?.element && titleIssue.element.length <= 500);
  assert.ok(descriptionIssue?.element && descriptionIssue.element.length <= 500);
  assert.ok(titleIssue.element.endsWith("..."));
  assert.ok(descriptionIssue.element.endsWith("..."));
  assert.match(titleIssue.message, /Title is 10000 characters/);
  assert.match(descriptionIssue.message, /Meta description is 10000 characters/);
});

test("SEO audit bounds diagnostic messages containing oversized untrusted language tags", () => {
  const oversizedTag = "z".repeat(12_000);
  const detailed = auditSeoMetadataDetailed(`<html lang="${oversizedTag}"><head></head><body></body></html>`);
  const issue = detailed.issues.find((entry) => entry.code === "accessibility.page_language.invalid_primary_subtag");

  assert.equal(issue?.severity, "error");
  assert.ok(issue.message.length <= 1_000);
  assert.ok(issue.message.endsWith("..."));
  assert.equal(detailed.counts.error >= 1, true);
});

test("JSON-LD audit reports the full total while bounding returned findings", () => {
  const blockCount = MAX_AUDIT_ISSUES + 5;
  const html = Array.from(
    { length: blockCount },
    () => '<script type="application/ld+json">{</script>',
  ).join("");

  const detailed = validateSchemaMarkupDetailed(html);
  assert.equal(detailed.issues.length, MAX_AUDIT_ISSUES);
  assert.equal(detailed.totalIssues, blockCount);
  assert.equal(detailed.truncated, true);
  assert.deepEqual(detailed.counts, { error: blockCount, warning: 0, info: 0 });
  assert.equal(validateSchemaMarkup(html).length, MAX_AUDIT_ISSUES);
});

test("JSON-LD audit recognizes media-type parameters without matching unrelated script types", () => {
  const html = [
    '<script type="application/ld+json;profile=https://www.w3.org/ns/json-ld#frame">{</script>',
    '<script type="application/ld+jsonish">{</script>',
  ].join("");

  const detailed = validateSchemaMarkupDetailed(html);
  assert.equal(detailed.totalIssues, 1);
  assert.equal(detailed.issues.length, 1);
  assert.match(detailed.issues[0].message, /Invalid JSON-LD schema syntax/);
});

test("JSON-LD audit rejects non-document top-level JSON shapes", () => {
  const invalid = validateSchemaMarkupDetailed([
    '<script type="application/ld+json">42</script>',
    '<script type="application/ld+json">[42]</script>',
  ].join(""));
  assert.equal(invalid.totalIssues, 2);
  assert.deepEqual(invalid.issues.map((issue) => issue.code), [
    "schema.jsonld.invalid_document",
    "schema.jsonld.invalid_document",
  ]);

  const valid = validateSchemaMarkupDetailed([
    '<script type="application/ld+json">{}</script>',
    '<script type="application/ld+json">[{}]</script>',
  ].join(""));
  assert.equal(valid.totalIssues, 0);
});
test("JSON-LD audit rejects invalid top-level @graph entries without rejecting valid graphs", () => {
  const badGraphs = [
    { "@graph": "not nodes" },
    { "@graph": null },
    { "@graph": [{ "@type": "Thing" }, 42] },
    { "@graph": [[{ "@type": "Thing" }]] },
  ];
  const invalid = validateSchemaMarkupDetailed(badGraphs.map((value) =>
    `<script type="application/ld+json">${JSON.stringify(value)}</script>`,
  ).join(""));
  assert.equal(invalid.totalIssues, badGraphs.length);
  assert.deepEqual(invalid.issues.map((issue) => issue.code),
    badGraphs.map(() => "schema.jsonld.invalid_document"));

  const goodGraphs = [
    { "@graph": { "@id": "https://example.com/a" } },
    { "@graph": [{ "@type": "Thing" }, {}] },
    { "@graph": [] },
    { "@context": "https://schema.org", "@type": "Thing" },
  ];
  const valid = validateSchemaMarkupDetailed(goodGraphs.map((value) =>
    `<script type="application/ld+json">${JSON.stringify(value)}</script>`,
  ).join(""));
  assert.equal(valid.totalIssues, 0);
});
test("audit findings expose stable machine-readable rule codes", () => {
  const html = [
    "<html><head>",
    '<meta name="description" content="short">',
    '<meta name="viewport" content="width=device-width">',
    '<link rel="canonical" href="https://example.com/">',
    '<meta property="og:title" content="Example">',
    '<meta property="og:image" content="https://example.com/image.png">',
    "</head><body><h2>Page heading</h2><img src=hero.png>",
    '<script type="application/ld+json">{</script>',
    "</body></html>",
  ].join("");

  const seo = auditSeoMetadata(html);
  assert.equal(seo.find((issue) => issue.message.includes("<title>"))?.code, "seo.title.missing_or_empty");
  assert.equal(seo.find((issue) => issue.message.includes("<h1>"))?.code, "seo.h1.missing");
  assert.equal(seo.find((issue) => issue.category === "Accessibility")?.code, "accessibility.image_alt.missing");

  const schema = validateSchemaMarkup(html);
  assert.equal(schema[0]?.code, "schema.jsonld.invalid_json");
});

test("Open Graph audit requires all basic properties to have usable content", () => {
  const complete = auditSeoMetadata([
    "<html><head>",
    '<meta property="og:title" content="Example">',
    '<meta property="og:type" content="website">',
    '<meta property="og:image" content="https://example.com/image.png">',
    '<meta property="og:image" content="https://example.com/image-2.png">',
    '<meta property="og:url" content="https://example.com/">',
    "</head><body></body></html>",
  ].join(""));
  assert.equal(complete.find((issue) => issue.code === "seo.open_graph.missing"), undefined);

  for (const html of [
    '<meta property="og:title" content="Example"><meta property="og:image" content="https://example.com/image.png">',
    '<meta property="og:title" content="Example"><meta property="og:type" content="website"><meta property="og:image" content="   "><meta property="og:url" content="https://example.com/">',
  ]) {
    assert.deepEqual(auditSeoMetadata(html).find((issue) => issue.code === "seo.open_graph.missing"), {
      code: "seo.open_graph.missing",
      severity: "info",
      category: "SEO",
      message: "Open Graph basic metadata is incomplete or empty. Provide non-empty og:title, og:type, og:image, and og:url values.",
    });
  }
});

test("explicit HTML documents require a non-empty page language", () => {
  for (const html of [
    "<html><head><title>Example</title></head><body></body></html>",
    '<html lang=""><head><title>Example</title></head><body></body></html>',
    '<html lang="   "><head><title>Example</title></head><body></body></html>',
  ]) {
    assert.deepEqual(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.page_language.missing_or_empty"),
      {
        code: "accessibility.page_language.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "The document <html> element needs a non-empty lang attribute so assistive technologies can determine the page language.",
      },
    );
  }

  for (const html of [
    '<html lang="en"><head><title>Example</title></head><body></body></html>',
    "<title>HTML fragment</title><p>Fragment content</p>",
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.page_language.missing_or_empty"),
      undefined,
    );
  }
});

test("XHTML namespace permits xml:lang without requiring HTML lang", () => {
  const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr"><head><title>Exemple</title></head><body></body></html>';
  const issues = auditSeoMetadata(xhtml);
  assert.equal(issues.find((issue) => issue.code === "accessibility.page_language.missing_or_empty"), undefined);
  assert.equal(issues.find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), undefined);

  const html = '<html xml:lang="fr"><head><title>Example</title></head><body></body></html>';
  assert.ok(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.page_language.missing_or_empty"));
});

test("XHTML namespace uses xml:lang when HTML lang is blank", () => {
  for (const lang of ["", "   "]) {
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="fr"><head><title>Exemple</title></head></html>`;
    const issues = auditSeoMetadata(xhtml);
    assert.equal(issues.find((issue) => issue.code === "accessibility.page_language.missing_or_empty"), undefined);
    assert.equal(issues.find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), undefined);
  }
});

test("explicit HTML documents require a known primary language subtag", () => {
  for (const [lang, primary] of [
    ["em-US", "em"],
    ["#1", "#1"],
    ["eng", "eng"],
  ]) {
    assert.deepEqual(
      auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`)
        .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"),
      {
        code: "accessibility.page_language.invalid_primary_subtag",
        severity: "error",
        category: "Accessibility",
        message: `The document <html> lang attribute uses unknown primary language subtag "${primary}". Use a primary language subtag registered by IANA.`,
      },
    );
  }

  for (const lang of ["FR", "en-US-GB", "de-hello", "osd", "qaa"]) {
    assert.equal(
      auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`)
        .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"),
      undefined,
    );
  }

  assert.equal(
    auditSeoMetadata("<title>HTML fragment</title><p>Fragment content</p>")
      .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"),
    undefined,
  );
});

test("RFC 5646 registered i-* grandfathered page languages are valid exact tags", () => {
  for (const lang of [
    "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon",
    "i-lux", "i-mingo", "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu",
    "I-KLINGON",
  ]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head></html>`);
    assert.equal(issues.some((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), false, lang);
  }

  for (const lang of ["i", "i-", "i-unknown", "i-default-extra", "i-klingon-x-foo"]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head></html>`);
    assert.equal(issues.some((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), true, lang);
  }
});

test("well-formed private-use BCP 47 page languages are advisory, not invalid", () => {
  for (const lang of ["x-foo", "X-Foo-12345678"]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`);
    assert.equal(issues.some((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), false);
    assert.equal(issues.find((issue) => issue.code === "accessibility.page_language.private_use")?.severity, "info");
  }
  for (const lang of ["x", "x-", "x-foo--bar", "x-123456789"]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`);
    assert.ok(issues.some((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"), lang);
  }
});

test("page languages reject malformed BCP 47 subtag structure", () => {
  for (const lang of ["en--US", "en-", "en-US_Latn", "en-abcdefghi", "en-\u00fc"]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head></html>`);
    assert.equal(
      issues.find((issue) => issue.code === "accessibility.page_language.malformed_subtag")?.severity,
      "error",
      lang,
    );
  }
  for (const lang of ["en-US", "sl-SI", "zh-Hant-TW", "de-1996", "x-example", "i-klingon"]) {
    const issues = auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head></html>`);
    assert.equal(issues.some((issue) => issue.code === "accessibility.page_language.malformed_subtag"), false, lang);
  }
});

test("image submit buttons require a non-empty accessible name", () => {
  for (const html of [
    '<input type="image" src="search.png">',
    '<input type="IMAGE" src="search.png" alt="">',
    '<input type="image" src="search.png" alt="   ">',
    '<input type="image" src="search.png" aria-label="   ">',
    '<span id="blank-label">   </span><input type="image" src="search.png" aria-labelledby="blank-label">',
    '<template><span id="template-label">Search</span></template><input type="image" src="search.png" aria-labelledby="template-label">',
  ]) {
    assert.deepEqual(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"),
      {
        code: "accessibility.input_image_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image submit buttons need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
      },
    );
  }

  for (const html of [
    '<input type="image" src="search.png" alt="Search">',
    '<input type="image" src="search.png" aria-label="Search">',
    '<input type="image" src="search.png" alt="" title="Search">',
      '<span id="search-label">Search</span><input type="image" src="search.png" aria-labelledby="search-label">',
    '<input type="text" alt="">',
    '<template><input type="image" src="search.png"></template>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"),
      undefined,
    );
  }
});

test("iframes exposed to accessibility require a non-empty accessible name", () => {
  for (const html of [
    '<iframe src="/account"></iframe>',
    '<iframe src="/account" name="Account settings"></iframe>',
    '<iframe src="/account" title="   "></iframe>',
    '<iframe src="/account" aria-label="   "></iframe>',
    '<iframe src="/account" tabindex="-1"></iframe>',
    '<iframe src="/account" tabindex="-2"></iframe>',
    '<span id="blank-frame-label">   </span><iframe src="/account" aria-labelledby="blank-frame-label"></iframe>',
  ]) {
    assert.deepEqual(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"),
      {
        code: "accessibility.iframe_name.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Iframe elements exposed to assistive technologies need a non-empty accessible name. Provide title, aria-label, or aria-labelledby.",
      },
    );
  }

  for (const html of [
    '<iframe src="/account" title="Account settings"></iframe>',
    '<iframe src="/account" tabindex="-1" title="Account settings"></iframe>',
    '<iframe src="/account" aria-label="Account settings"></iframe>',
    '<span id="frame-label">Account settings</span><iframe src="/account" aria-labelledby="frame-label"></iframe>',
    '<iframe src="/account" aria-hidden="true"></iframe>',
    '<div aria-hidden="true"><iframe src="/account"></iframe></div>',
    '<iframe src="/account" role="none"></iframe>',
    '<iframe src="/account" role="presentation"></iframe>',
    '<template><iframe src="/account"></iframe></template>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"),
      undefined,
    );
  }
});

test("presentational iframe roles do not suppress naming when they conflict with focus or global ARIA", () => {
  for (const html of [
    '<iframe src="/account" role="none" tabindex="0"></iframe>',
    '<iframe src="/account" role="presentation" tabindex="-1"></iframe>',
    '<iframe src="/account" role="none" contenteditable="true"></iframe>',
    '<iframe src="/account" role="presentation" aria-describedby="context"></iframe>',
    '<iframe src="/account" role="none" aria-label="   "></iframe>',
  ]) {
    const issue = auditSeoMetadata(html).find((entry) => entry.code === "accessibility.iframe_name.missing_or_empty");
    assert.equal(issue?.severity, "error", html);
  }

  for (const html of [
    '<iframe src="/account" role="none" contenteditable="false"></iframe>',
    '<iframe src="/account" role="presentation" tabindex="0" title="Account settings"></iframe>',
    '<iframe src="/account" role="presentation" aria-describedby="context" aria-label="Account settings"></iframe>',
  ]) {
    const issue = auditSeoMetadata(html).find((entry) => entry.code === "accessibility.iframe_name.missing_or_empty");
    assert.equal(issue, undefined, html);
  }
});

test("aria-labelledby accepts a directly referenced aria-label as the accessible name", () => {
  for (const [html, code] of [
    ['<span id="label" aria-label="Search"></span><input type="image" src="search.png" aria-labelledby="label">', "accessibility.input_image_alt.missing_or_empty"],
    ['<span id="label" aria-label="Account settings"></span><iframe src="/account" aria-labelledby="label"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<span id="label" aria-label="Quarterly revenue chart"></span><img src="chart.png" aria-labelledby="label">', "accessibility.image_alt.missing"],
    ['<span id="label" aria-label="Revenue chart"></span><div role="img" aria-labelledby="label"></div>', "accessibility.image_alt.missing"],
    ['<span id="label" aria-label="Revenue chart"></span><svg role="img" aria-labelledby="label"></svg>', "accessibility.image_alt.missing"],
    ['<span id="label" aria-label="Documentation"></span><map name="nav"><area href="/docs" aria-labelledby="label"></map>', "accessibility.area_alt.missing_or_empty"],
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === code),
      undefined,
    );
  }
});
test("visible aria-labelledby targets exclude hidden descendant-only text", () => {
  for (const hidden of [
    "hidden",
    'aria-hidden="true"',
    'style="display: none"',
    'style="visibility: hidden"',
    'style="content-visibility: hidden"',
  ]) {
    const html = `<span id="ref"><b ${hidden}>Invisible</b></span><img src="chart.png" aria-labelledby="ref">`;
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), true, html);
  }
  for (const html of [
    '<span id="ref" hidden><b hidden>Directly referenced hidden subtree</b></span><img src="chart.png" aria-labelledby="ref">',
    '<span id="ref"><b hidden>Invisible</b><b>Visible name</b></span><img src="chart.png" aria-labelledby="ref">',
  ]) {
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), false, html);
  }
});
test("aria-labelledby does not use text from non-rendered descendants", () => {
  for (const [control, code] of [
    ['<img src="chart.png" aria-labelledby="ref">', "accessibility.image_alt.missing"],
    ['<iframe src="/account" aria-labelledby="ref"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<input type="image" src="submit.png" aria-labelledby="ref">', "accessibility.input_image_alt.missing_or_empty"],
    ['<span role="img" aria-labelledby="ref"></span>', "accessibility.image_alt.missing"],
  ]) {
    for (const descendant of [
      '<script>Invisible label</script>',
      '<style>Invisible label</style>',
      '<template>Invisible label</template>',
    ]) {
      const html = `<span id="ref">${descendant}</span>${control}`;
      assert.equal(auditSeoMetadata(html).some((issue) => issue.code === code), true, html);
      const mixed = `<span id="ref">${descendant}<b>Visible label</b></span>${control}`;
      assert.equal(auditSeoMetadata(mixed).some((issue) => issue.code === code), false, mixed);
    }
  }
});
test("visible aria-labelledby targets exclude inert descendant-only text", () => {
  for (const [control, code] of [
    ['<img src="chart.png" aria-labelledby="ref">', "accessibility.image_alt.missing"],
    ['<iframe src="/account" aria-labelledby="ref"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<input type="image" src="search.png" aria-labelledby="ref">', "accessibility.input_image_alt.missing_or_empty"],
    ['<span role="img" aria-labelledby="ref"></span>', "accessibility.image_alt.missing"],
  ]) {
    const html = `<span id="ref"><b inert>Excluded label</b></span>${control}`;
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === code), true, html);
    const mixed = `<span id="ref"><b inert>Excluded</b><b>Visible label</b></span>${control}`;
    assert.equal(auditSeoMetadata(mixed).some((issue) => issue.code === code), false, mixed);
  }
  const hiddenRoot = '<span id="ref" inert><b>Directly referenced inert label</b></span><img src="chart.png" aria-labelledby="ref">';
  assert.equal(auditSeoMetadata(hiddenRoot).some((issue) => issue.code === "accessibility.image_alt.missing"), false);
});
test("referenced label text honors winning inline CSS declarations and visibility inheritance", () => {
  for (const label of [
    '<b style="display: none; display: block">Visible label</b>',
    '<b style="display: block !important; display: none">Visible label</b>',
    '<b style="display: block ! important; display: none">Visible label</b>',
    '<b style="visibility: hidden; visibility: visible">Visible label</b>',
    '<b style="visibility: visible !important; visibility: hidden">Visible label</b>',
    '<b style="content-visibility: hidden; content-visibility: visible">Visible label</b>',
    '<span style="visibility: hidden"><b style="visibility: visible">Visible label</b></span>',
  ]) {
    const html = `<span id="ref">${label}</span><img src="chart.png" aria-labelledby="ref">`;
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), false, html);
  }
  for (const label of [
    '<b style="display: block; display: none">Hidden label</b>',
    '<b style="display: none !important; display: block">Hidden label</b>',
    '<b style="display: none ! important; display: block">Hidden label</b>',
    '<b style="visibility: visible; visibility: hidden">Hidden label</b>',
    '<b style="visibility: hidden !important; visibility: visible">Hidden label</b>',
    '<b style="content-visibility: visible; content-visibility: hidden">Hidden label</b>',
    '<span style="visibility: hidden"><b>Hidden label</b></span>',
  ]) {
    const html = `<span id="ref">${label}</span><img src="chart.png" aria-labelledby="ref">`;
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), true, html);
  }
});
test("inline CSS-hidden elements and subtrees do not produce accessibility naming errors", () => {
  for (const [html, code] of [
    ['<img src="hidden.png" style="visibility: hidden">', "accessibility.image_alt.missing"],
    ['<div style="visibility: collapse"><img src="hidden.png"></div>', "accessibility.image_alt.missing"],
    ['<div style="content-visibility: hidden"><iframe src="/private"></iframe></div>', "accessibility.iframe_name.missing_or_empty"],
    ['<input type="image" src="hidden.png" style="content-visibility: hidden">', "accessibility.input_image_alt.missing_or_empty"],
    ['<img src="hidden.png" style="visibility: hidden !important; visibility: visible">', "accessibility.image_alt.missing"],
    ['<img src="hidden.png" style="visibility: hidden ! important; visibility: visible">', "accessibility.image_alt.missing"],
    ['<div style="content-visibility: hidden"><img src="hidden.png" style="content-visibility: visible"></div>', "accessibility.image_alt.missing"],
    ['<img src="hidden.png" style="visibility: visible; visibility: hidden">', "accessibility.image_alt.missing"],
  ]) {
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === code), false, html);
  }
});

test("inline visibility overrides and later declarations keep exposed images auditable", () => {
  for (const html of [
    '<div style="visibility: hidden"><img src="visible.png" style="visibility: visible"></div>',
    '<div style="visibility: hidden"><div style="visibility: visible"><img src="visible.png"></div></div>',
    '<img src="visible.png" style="visibility: hidden; visibility: visible">',
    '<img src="visible.png" style="display: none; display: block">',
    '<img src="visible.png" style="content-visibility: hidden; content-visibility: visible">',
  ]) {
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.image_alt.missing"), true, html);
  }
});

test("inert elements and descendants are excluded from accessible-name checks", () => {
  for (const [html, code] of [
    ['<img src="hidden.png" inert>', "accessibility.image_alt.missing"],
    ['<section inert><img src="hidden.png"></section>', "accessibility.image_alt.missing"],
    ['<section inert=""><iframe src="/private"></iframe></section>', "accessibility.iframe_name.missing_or_empty"],
    ['<div inert="false"><input type="image" src="submit.png"></div>', "accessibility.input_image_alt.missing_or_empty"],
    ['<div inert><div aria-hidden="false"><img src="hidden.png"></div></div>', "accessibility.image_alt.missing"],
    ['<div inert><span role="img"></span></div>', "accessibility.image_alt.missing"],
  ]) {
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === code), false, html);
  }

  for (const [html, code] of [
    ['<div inert><img src="hidden.png"></div><img src="visible.png">', "accessibility.image_alt.missing"],
    ['<div inert><iframe src="/private"></iframe></div><iframe src="/public"></iframe>', "accessibility.iframe_name.missing_or_empty"],
    ['<div inert><input type="image" src="hidden.png"></div><input type="image" src="visible.png">', "accessibility.input_image_alt.missing_or_empty"],
  ]) {
    assert.equal(auditSeoMetadata(html).some((issue) => issue.code === code), true, html);
  }
});

test("closed dialogs exclude their content from accessibility naming checks", () => {
  const imageNamesMissing = (html) => auditSeoMetadata(html)
    .filter((issue) => issue.code === "accessibility.image_alt.missing").length;

  for (const html of [
    '<dialog><img src="closed.png"></dialog>',
    '<dialog aria-modal="true"><div role="img"></div></dialog>',
    '<dialog><section><img src="nested.png"></section></dialog>',
    '<dialog open><dialog><img src="closed-inner.png"></dialog></dialog>',
  ]) {
    assert.equal(imageNamesMissing(html), 0, html);
  }

  for (const html of [
    '<dialog open><img src="open.png"></dialog>',
    '<dialog open="false"><img src="open.png"></dialog>',
    '<dialog><img src="closed.png"></dialog><img src="outside.png">',
  ]) {
    assert.equal(imageNamesMissing(html), 1, html);
  }
  assert.equal(auditSeoMetadata('<dialog><iframe src="/closed"></iframe></dialog>')
    .some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), false);
  assert.equal(auditSeoMetadata('<dialog open><iframe src="/open"></iframe></dialog>')
    .some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), true);
});

test("initially hidden popovers exclude descendants from accessible-name checks", () => {
  const missingImageNames = (html) => auditSeoMetadata(html)
    .filter((issue) => issue.code === "accessibility.image_alt.missing").length;

  for (const html of [
    '<div popover><img src="auto.png"></div>',
    '<div popover="manual"><img src="manual.png"></div>',
    '<div popover="hint"><section><img src="hint.png"></section></div>',
    '<div popover="invalid"><img src="fallback-manual.png"></div>',
    '<div popover><span aria-hidden="false" role="img"></span></div>',
  ]) {
    assert.equal(missingImageNames(html), 0, html);
  }

  for (const html of [
    '<div popover><img src="hidden.png"></div><img src="visible.png">',
    '<button popovertarget="panel"><img src="trigger.png"></button><div popover id="panel"></div>',
    '<div data-popover="manual"><img src="ordinary.png"></div>',
  ]) {
    assert.equal(missingImageNames(html), 1, html);
  }
  assert.equal(auditSeoMetadata('<div popover><iframe src="/hidden"></iframe></div>')
    .some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), false);
  assert.equal(auditSeoMetadata('<iframe src="/visible"></iframe>')
    .some((issue) => issue.code === "accessibility.iframe_name.missing_or_empty"), true);
});

test("closed details expose only their first summary to accessible-name checks", () => {
  const missingImageNames = (html) => auditSeoMetadata(html)
    .filter((issue) => issue.code === "accessibility.image_alt.missing").length;

  for (const html of [
    '<details><summary>More</summary><img src="hidden.png"></details>',
    '<details><img src="no-summary.png"></details>',
    '<details><summary>First</summary><summary><img src="second.png"></summary></details>',
    '<details open><summary>Outer</summary><details><summary>Inner</summary><img src="nested.png"></details></details>',
  ]) {
    assert.equal(missingImageNames(html), 0, html);
  }

  for (const html of [
    '<details open><summary>More</summary><img src="visible.png"></details>',
    '<details open="false"><summary>More</summary><img src="visible.png"></details>',
    '<details><summary><img src="summary.png"></summary><img src="hidden.png"></details>',
    '<details><p>Before</p><summary><img src="summary.png"></summary><img src="hidden.png"></details>',
  ]) {
    assert.equal(missingImageNames(html), 1, html);
  }
});

test("ordinary images accept an explicit empty alt as decorative", () => {
  const decorative = auditSeoMetadata('<img src="divider.png" alt="">');
  assert.equal(
    decorative.find((issue) => issue.code === "accessibility.image_alt.empty"),
    undefined,
  );

  assert.equal(
    auditSeoMetadata('<img src="missing.png">')
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
    "error",
  );
  assert.equal(
    auditSeoMetadata('<img src="blank.png" alt="   ">')
      .find((issue) => issue.code === "accessibility.image_alt.empty")?.severity,
    "error",
  );
});

test("whitespace-only alt text is an error only when no other accessible name exists", () => {
  for (const html of [
    '<img src="blank.png" alt=" \t ">',
    '<img src="blank.png" alt="   " role="img">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.empty")?.severity,
      "error",
      html,
    );
  }

  for (const html of [
    '<img src="logo.png" alt="   " aria-label="Company logo">',
    '<span id="label">Company logo</span><img src="logo.png" alt="   " aria-labelledby="label">',
    '<img src="logo.png" alt="   " title="Company logo">',
    '<img src="divider.png" alt=" " aria-hidden="true">',
    '<img src="divider.png" alt="">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.empty"),
      undefined,
      html,
    );
  }
});

test("explicit semantic image roles require a non-empty accessible name even with empty alt", () => {
  for (const html of [
    '<img src="logo.png" alt="" role="img">',
    '<img src="logo.png" alt="" role="image">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
      "error",
    );
  }

  for (const html of [
    '<img src="divider.png" alt="">',
    '<img src="divider.png" alt="" role="none">',
    '<img src="divider.png" alt="" role="presentation">',
    '<img src="logo.png" alt="" role="img" aria-label="Company logo">',
    '<span id="logo-label">Company logo</span><img src="logo.png" alt="" role="image" aria-labelledby="logo-label">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }
});

test("ordinary images accept alternate accessible-name sources", () => {
  for (const html of [
    '<img src="chart.png" aria-label="Quarterly revenue chart">',
    '<span id="chart-label">Quarterly revenue chart</span><img src="chart.png" aria-labelledby="chart-label">',
    '<img src="chart.png" title="Quarterly revenue chart">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }

  assert.equal(
    auditSeoMetadata('<img src="unnamed.png">')
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
    "error",
  );
});

test("generic elements with semantic image roles require a non-empty accessible name", () => {
  for (const html of [
    '<div role="img"></div>',
    '<span role="image"></span>',
    '<section role="img"></section>',
    '<p role="img"></p>',
    '<i role="image"></i>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
      "error",
    );
  }

  for (const html of [
    '<div role="img" aria-label="Company logo"></div>',
    '<span id="chart-label">Revenue chart</span><div role="image" aria-labelledby="chart-label"></div>',
    '<span role="img" title="Status icon"></span>',
    '<section role="img" aria-label="Network diagram"></section>',
    '<p id="name">Regional sales</p><i role="img" aria-labelledby="name"></i>',
    '<article role="img" hidden></article>',
    '<section role="img" aria-hidden="true"></section>',
    '<div role="img" aria-hidden="true"></div>',
    '<div aria-hidden="true"><span role="image"></span></div>',
    '<template><div role="img"></div></template>',
    '<div></div>',
    '<span role="button"></span>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }
});

test("role fallbacks use the first valid non-abstract ARIA role", () => {
  for (const html of [
    '<div role="not-a-role img"></div>',
    '<span role="command image"></span>',
    '<svg role="bogus graphics-document"></svg>',
    '<img src="logo.png" alt="" role="range img">',
    '<img src="focusable.png" role="bogus presentation" tabindex="0">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
      "error",
    );
  }

  for (const html of [
    '<div role="button img"></div>',
    '<div role="sectionheader img"></div>',
    '<div role="doc-cover img"></div>',
    '<svg role="graphics-object graphics-symbol"></svg>',
    '<img src="divider.png" role="bogus presentation">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }
});
test("explicit SVG image roles require a non-empty accessible name", () => {
  for (const html of [
    '<svg role="img"></svg>',
    '<svg role="graphics-document"><title>   </title></svg>',
    '<svg><circle role="graphics-symbol"></circle></svg>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
      "error",
    );
  }

  for (const html of [
    '<svg role="img"><title>Quarterly chart</title></svg>',
    '<svg role="graphics-document" aria-label="Process diagram"></svg>',
    '<span id="chart-label">Revenue chart</span><svg role="img" aria-labelledby="chart-label"></svg>',
    '<svg role="img" aria-hidden="true"></svg>',
    '<div aria-hidden="true"><svg role="graphics-document"></svg></div>',
    '<template><svg role="img"></svg></template>',
    '<svg><circle role="graphics-symbol" aria-label="Data point"></circle></svg>',
    '<svg></svg>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }
});
test("presentational images are outside accessible-name applicability unless presentation conflicts", () => {
  for (const html of [
    '<img src="spacer.png" role="none">',
    '<img src="divider.png" role="presentation">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }

  for (const html of [
    '<img src="focusable.png" role="none" tabindex="0">',
    '<span id="details">Details</span><img src="described.png" role="presentation" aria-describedby="details">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
      "error",
    );
  }
});

test("aria-hidden images and image submit buttons are outside accessible-name applicability", () => {
  for (const html of [
    '<img src="decorative.png" aria-hidden="true">',
    '<div aria-hidden="true"><img src="nested.png"></div>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.image_alt.missing"),
      undefined,
    );
  }

  for (const html of [
    '<input type="image" src="search.png" aria-hidden="true">',
    '<div aria-hidden="true"><input type="image" src="nested-search.png"></div>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"),
      undefined,
    );
  }

  assert.equal(
    auditSeoMetadata('<img src="visible.png" aria-hidden="false">')
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity,
    "error",
  );
  assert.equal(
    auditSeoMetadata('<input type="image" src="visible-search.png" aria-hidden="false">')
      .find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty")?.severity,
    "error",
  );
});
test("statically hidden images and image buttons do not require an accessible name", () => {
  for (const html of [
    '<img hidden src="hidden.png">',
    '<section hidden><img src="nested.png"></section>',
    '<div style="display:none"><img src="hidden-by-css.png"></div>',
    '<div style="DISPLAY : none !important"><input type="image" src="hidden-action.png"></div>',
  ]) {
    const issues = auditSeoMetadata(html);
    assert.equal(issues.some((issue) => ["accessibility.image_alt.missing", "accessibility.input_image_alt.missing_or_empty"].includes(issue.code)), false);
  }
  assert.ok(auditSeoMetadata('<img src="visible.png" style="display:block">').some((issue) => issue.code === "accessibility.image_alt.missing"));
});
test("image-map links require usable alt text", () => {
  for (const html of [
    '<map name="nav"><area href="/docs"></map>',
    '<map name="nav"><area href="/docs" alt=""></map>',
    '<map name="nav"><area href="/docs" alt="   "></map>',
  ]) {
    assert.deepEqual(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.area_alt.missing_or_empty"),
      {
        code: "accessibility.area_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image-map links need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
      },
    );
  }

  for (const html of [
    '<map name="nav"><area href="/docs" alt="Documentation"></map>',
    '<span id="map-label">Documentation</span><map name="nav"><area href="/docs" aria-labelledby="map-label"></map>',
    '<map name="nav"><area href="/docs" aria-label="Documentation"></map>',
    '<map name="nav"><area href="/docs" title="Documentation"></map>',
    '<map name="nav"><area href="/docs" aria-hidden="true"></map>',
    '<div aria-hidden="true"><map name="nav"><area href="/docs"></map></div>',
    '<map name="nav"><area shape="default"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" alt="Documentation"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" aria-label="Documentation"></map>',
    '<span id="docs-label">Documentation</span><map name="nav"><area href="/docs" alt=""><area href="/docs" aria-labelledby="docs-label"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" title="Documentation"></map>',
    '<template><map name="nav"><area href="/docs"></map></template>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.area_alt.missing_or_empty"),
      undefined,
    );
  }
  for (const html of [
    '<map name="nav"><area href="/docs" alt=""><area href="/other" aria-label="Other"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" aria-hidden="true" aria-label="Hidden"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" title=" "></map>',
  ]) {
    assert.ok(auditSeoMetadata(html).some((issue) => issue.code === "accessibility.area_alt.missing_or_empty"));
  }
});

test("canonical audit distinguishes an optional missing preference from an unusable declaration", () => {
  const valid = auditSeoMetadata('<link rel="Alternate CANONICAL" href="https://example.com/page">');
  assert.equal(valid.find((issue) => issue.code === "seo.canonical.missing"), undefined);

  const absent = auditSeoMetadata("");
  assert.deepEqual(absent.find((issue) => issue.code === "seo.canonical.missing"), {
    code: "seo.canonical.missing",
    severity: "info",
    category: "SEO",
    message: "No rel=\"canonical\" preference is declared. This is optional unless the page needs an explicit canonicalization signal.",
  });

  const empty = auditSeoMetadata('<link rel="canonical" href="   ">');
  assert.deepEqual(empty.find((issue) => issue.code === "seo.canonical.missing"), {
    code: "seo.canonical.missing",
    severity: "warning",
    category: "SEO",
    message: "Canonical link is present but its href is empty. Provide a usable canonical target or remove the declaration.",
  });
});

test("canonical audit reports non-empty href values that cannot be parsed as URLs", () => {
  for (const href of ["https://", "http://[::1", "mailto:owner@example.com", "javascript:alert(1)", "data:text/plain,hello", "ftp://example.org/page"]) {
    const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`);
    assert.deepEqual(issues.find((issue) => issue.code === "seo.canonical.invalid_url"), {
      code: "seo.canonical.invalid_url",
      severity: "warning",
      category: "SEO",
      message: "Canonical link href is not a usable HTTP(S) URL. Provide an HTTP(S) canonical target or remove the declaration.",
    });
    assert.equal(issues.find((issue) => issue.code === "seo.canonical.unusable"), undefined);
    assert.equal(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended"), undefined);
  }

  for (const href of ["https://example.com/page", "/page", "../page", "//example.com/page"]) {
    assert.equal(
      auditSeoMetadata(`<link rel="canonical" href="${href}">`)
        .find((issue) => issue.code === "seo.canonical.invalid_url"),
      undefined,
    );
  }
});

test("canonical audit warns about credentials embedded in HTTP URLs", () => {
  for (const href of ["https://user:pass@example.com/page", "https://user@example.com/page"]) {
    const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`);
    assert.deepEqual(issues.find((issue) => issue.code === "seo.canonical.embedded_credentials"), {
      code: "seo.canonical.embedded_credentials",
      severity: "warning",
      category: "SEO",
      message: "Canonical URL embeds user credentials. Remove the username and password to avoid exposing secrets or relying on authenticated canonical targets.",
    });
  }
});

test("canonical audit reports ambiguous and Google-ignored canonical declarations", () => {
  const multiple = auditSeoMetadata([
    "<html><head>",
    '<link rel="canonical" href="https://example.com/a">',
    '<link rel="canonical" href="https://example.com/b">',
    "</head><body></body></html>",
  ].join(""));
  assert.deepEqual(multiple.find((issue) => issue.code === "seo.canonical.multiple"), {
    code: "seo.canonical.multiple",
    severity: "warning",
    category: "SEO",
    message: "Multiple usable canonical link relations are declared. Keep one unambiguous canonical target.",
  });

  for (const attribute of ['hreflang="en"', 'lang="en"', 'media="print"', 'type="text/html"']) {
    const ignored = auditSeoMetadata(`<link rel="canonical" href="https://example.com/page" ${attribute}>`);
    assert.deepEqual(ignored.find((issue) => issue.code === "seo.canonical.unusable"), {
      code: "seo.canonical.unusable",
      severity: "warning",
      category: "SEO",
      message: "Canonical link is present but uses attributes Google ignores for canonicalization. Use a plain rel=\"canonical\" link in <head>.",
    });
  }
});

test("canonical audit warns when the canonical href contains a URL fragment", () => {
  for (const href of ["#section", "https://example.com/page#section", "/page#section"]) {
    const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`);
    assert.deepEqual(issues.find((issue) => issue.code === "seo.canonical.fragment_unsupported"), {
      code: "seo.canonical.fragment_unsupported",
      severity: "warning",
      category: "SEO",
      message: "Canonical URL contains a fragment. Google generally does not support URL fragments for canonicalization; remove the #fragment from the canonical href.",
    });
  }

  const relative = auditSeoMetadata('<link rel="canonical" href="/page">');
  assert.equal(relative.find((issue) => issue.code === "seo.canonical.fragment_unsupported"), undefined);
});

test("canonical audit recommends absolute href values while preserving relative canonical support", () => {
  for (const href of ["/page", "page", "../page", "//example.com/page"]) {
    const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`);
    assert.deepEqual(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended"), {
      code: "seo.canonical.relative_not_recommended",
      severity: "info",
      category: "SEO",
      message: "Canonical href is relative. Google supports relative canonical URLs but recommends absolute URLs to avoid long-term canonicalization mistakes.",
    });
  }

  for (const html of [
    '<link rel="canonical" href="https://example.com/page">',
    '<link rel="canonical" href="/page#section">',
    '<link rel="canonical" href="/page" media="print">',
  ]) {
    const issues = auditSeoMetadata(html);
    assert.equal(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended"), undefined);
  }
});

test("robots meta audit reports noindex-equivalent directives that affect Google Search", () => {
  for (const html of [
    '<meta name="robots" content="NOINDEX, follow">',
    '<body><meta name="GoogleBot" content="none"></body>',
    '<meta name="robots" content="index, follow"><meta name="googlebot" content="noindex">',
  ]) {
    assert.deepEqual(auditSeoMetadata(html).find((issue) => issue.code === "seo.robots.noindex"), {
      code: "seo.robots.noindex",
      severity: "warning",
      category: "SEO",
      message: "A robots directive prevents Google from indexing this page. Confirm that noindex is intentional.",
    });
  }

  const allowed = auditSeoMetadata('<meta name="robots" content="index, follow, max-image-preview:none">');
  assert.equal(allowed.find((issue) => issue.code === "seo.robots.noindex"), undefined);
});

test("robots audit uses supplied X-Robots-Tag headers without assuming a network fetch", () => {
  const html = '<meta name="robots" content="index, follow">';
  const expected = {
    code: "seo.robots.noindex",
    severity: "warning",
    category: "SEO",
    message: "A robots directive prevents Google from indexing this page. Confirm that noindex is intentional.",
  };
  for (const header of [
    "noindex",
    "FOLLOW, NONE",
    "googlebot: noindex, follow",
    "bingbot: noindex\ngooglebot: noindex",
    "max-snippet: 120, noindex",
    "max-image-preview: large, noindex",
    "max-video-preview: 30, noindex",
    "unavailable_after: 25 Jun 2027 15:00:00 GMT, noindex",
  ]) {
    assert.deepEqual(auditSeoMetadata(html, header).find((issue) => issue.code === "seo.robots.noindex"), expected);
  }
  for (const header of [
    "",
    "index, follow",
    "bingbot: noindex",
    "bingbot: noindex, follow",
    "bingbot: max-snippet: 20, noindex",
    "googlebot-image: noindex",
    "noindex-something",
  ]) {
    assert.equal(auditSeoMetadata(html, header).find((issue) => issue.code === "seo.robots.noindex"), undefined);
  }
  assert.equal(auditSeoMetadata(html).find((issue) => issue.code === "seo.robots.noindex"), undefined);
  const both = auditSeoMetadataDetailed('<meta name="robots" content="noindex">', "googlebot: noindex");
  assert.equal(both.issues.filter((issue) => issue.code === "seo.robots.noindex").length, 1);
});

test("folded X-Robots-Tag scopes are reported as ambiguous without inventing Google noindex", () => {
  const folded = new Headers();
  folded.append("X-Robots-Tag", "bingbot: noindex");
  folded.append("X-Robots-Tag", "noindex");
  assert.equal(folded.get("X-Robots-Tag"), "bingbot: noindex, noindex");

  const expected = {
    code: "seo.robots.x_robots_tag.scope_ambiguous",
    severity: "info",
    category: "SEO",
    message: "X-Robots-Tag contains a potentially ambiguous noindex after a non-Googlebot scope. Combined HTTP header fields may hide a separate global directive; inspect the origin response headers.",
  };
  for (const header of [folded.get("X-Robots-Tag"), "bingbot: nofollow, none", "bingbot: none, none"]) {
    const issues = auditSeoMetadata("<title>Page</title>", header);
    assert.equal(issues.find((issue) => issue.code === "seo.robots.noindex"), undefined);
    assert.deepEqual(issues.find((issue) => issue.code === expected.code), expected);
  }
  for (const header of ["bingbot: noindex, follow", "bingbot: noindex\nnoindex", "googlebot: noindex, follow", "noindex", "max-image-preview:none, follow"]) {
    assert.equal(auditSeoMetadata("<title>Page</title>", header)
      .find((issue) => issue.code === expected.code), undefined);
  }
});

test("SEO and JSON-LD audits ignore inert template contents", () => {
  const html = [
    "<html><head></head><body>",
    "<template>",
    '<meta name="robots" content="noindex">',
    "<h1>Template heading</h1>",
    '<img src="template.png">',
    '<script type="application/ld+json">{</script>',
    "</template>",
    "<h1>Visible heading</h1>",
    '<img src="visible.png" alt="Visible">',
    "</body></html>",
  ].join("");

  const seo = auditSeoMetadata(html);
  assert.equal(seo.find((issue) => issue.code === "seo.robots.noindex"), undefined);
  assert.equal(seo.find((issue) => issue.code === "seo.h1.multiple"), undefined);
  assert.equal(seo.find((issue) => issue.code === "accessibility.image_alt.missing"), undefined);

  const schema = validateSchemaMarkupDetailed(html);
  assert.equal(schema.totalIssues, 0);
  assert.deepEqual(schema.issues, []);
});

test("meta description name matching follows HTML ASCII case-insensitive semantics", () => {
  const description = "D".repeat(140);
  const issues = auditSeoMetadata(`<meta name="Description" content="${description}">`);

  assert.equal(
    issues.find((issue) => issue.code === "seo.meta_description.missing_or_empty"),
    undefined,
  );
  assert.equal(issues.find((issue) => issue.code === "seo.meta_description.length"), undefined);
});

test("SEO audit reports ambiguous duplicate primary metadata without merging values", () => {
  const title = "T".repeat(40);
  const description = "D".repeat(140);
  const issues = auditSeoMetadata([
    "<html><head>",
    `<title>${title}</title>`,
    `<title>${"U".repeat(40)}</title>`,
    `<meta name="description" content="${description}">`,
    `<meta name="description" content="${"E".repeat(140)}">`,
    "</head><body></body></html>",
  ].join(""));

  assert.deepEqual(issues.find((issue) => issue.code === "seo.title.multiple"), {
    code: "seo.title.multiple",
    severity: "warning",
    category: "SEO",
    message: "Multiple <title> elements are declared in the document head. Keep one unambiguous page title.",
  });
  assert.deepEqual(issues.find((issue) => issue.code === "seo.meta_description.multiple"), {
    code: "seo.meta_description.multiple",
    severity: "warning",
    category: "SEO",
    message: "Multiple meta descriptions are declared in the document head. Keep one unambiguous page description.",
  });
  assert.equal(issues.find((issue) => issue.code === "seo.title.length"), undefined);
  assert.equal(issues.find((issue) => issue.code === "seo.meta_description.length"), undefined);
});

test("viewport meta name matching follows HTML ASCII case-insensitive semantics", () => {
  const issues = auditSeoMetadata('<meta name="ViewPort" content="width=device-width">');

  assert.equal(issues.find((issue) => issue.code === "seo.viewport.missing"), undefined);
});

test("viewport meta without usable content is reported instead of treated as configured", () => {
  for (const html of ['<meta name="viewport">', '<meta name="viewport" content="   ">']) {
    assert.deepEqual(auditSeoMetadata(html).find((issue) => issue.code === "seo.viewport.unusable"), {
      code: "seo.viewport.unusable",
      severity: "error",
      category: "SEO",
      message: "Viewport meta tag is present but its content is empty. Provide viewport settings such as width=device-width.",
    });
  }
});

test("viewport metadata that restricts 200% zoom is reported", () => {
  for (const html of [
    '<meta name="viewport" content="width=device-width, user-scalable=no">',
    '<meta name="viewport" content="width=device-width, user-scalable=0.5">',
    '<meta name="viewport" content="width=device-width, user-scalable=invalid">',
    '<meta name="viewport" content="width=device-width, maximum-scale=1.5">',
    '<meta name="viewport" content="width=device-width, maximum-scale=yes">',
    '<meta name="viewport" content="width=device-width, maximum-scale=no">',
    '<meta name="viewport" content="width=device-width, maximum-scale=invalid">',
  ]) {
    assert.deepEqual(auditSeoMetadata(html).find((issue) => issue.code === "accessibility.viewport.zoom_restricted"), {
      code: "accessibility.viewport.zoom_restricted",
      severity: "warning",
      category: "Accessibility",
      message: "Viewport metadata restricts user zoom below 200%. Ensure user-scalable permits zoom and maximum-scale allows at least 2x zoom.",
    });
  }
});

test("viewport zoom audit preserves non-restricting controls", () => {
  for (const html of [
    '<meta name="viewport" content="width=device-width, user-scalable=yes">',
    '<meta name="viewport" content="width=device-width, user-scalable=2">',
    '<meta name="viewport" content="width=device-width, user-scalable=-2">',
    '<meta name="viewport" content="width=device-width, user-scalable=device-width">',
    '<meta name="viewport" content="width=device-width, maximum-scale=2">',
    '<meta name="viewport" content="width=device-width, maximum-scale=-1">',
    '<meta name="viewport" content="width=device-width, maximum-scale=device-width">',
    '<meta name="viewport" content="width=device-width">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.viewport.zoom_restricted"),
      undefined,
    );
  }
});

test("delayed meta refresh directives are reported", () => {
  for (const html of [
    '<meta http-equiv="refresh" content="30">',
    '<meta http-equiv="REFRESH" content="30; URL=https://example.com/next">',
    '<meta http-equiv="refresh" content="72000">',
  ]) {
    assert.deepEqual(auditSeoMetadata(html).find((issue) => issue.code === "accessibility.meta_refresh.delayed"), {
      code: "accessibility.meta_refresh.delayed",
      severity: "warning",
      category: "Accessibility",
      message: "Meta refresh uses a delay between 1 second and 20 hours. Prefer an immediate redirect or user-controlled navigation.",
    });
  }
});

test("meta refresh audit follows first valid directive semantics and preserves safe controls", () => {
  const delayedAfterInvalid = [
    '<meta http-equiv="refresh" content="0: https://example.com/invalid">',
    '<meta http-equiv="refresh" content="5; https://example.com/next">',
  ].join("");
  assert.equal(
    auditSeoMetadata(delayedAfterInvalid).find((issue) => issue.code === "accessibility.meta_refresh.delayed")?.severity,
    "warning",
  );

  for (const html of [
    '<meta http-equiv="refresh" content="0; URL=https://example.com/next"><meta http-equiv="refresh" content="5">',
    '<meta http-equiv="refresh" content="72001">',
    '<meta http-equiv="refresh" content="+5; https://example.com/invalid">',
    '<template><meta http-equiv="refresh" content="5"></template><meta http-equiv="refresh" content="0">',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.meta_refresh.delayed"),
      undefined,
    );
  }
});
test("page metadata checks ignore body and SVG lookalikes outside the document head", () => {
  const description = "D".repeat(140);
  const issues = auditSeoMetadata([
    "<html><head></head><body>",
    '<svg><title>Decorative icon title that is not the page title</title></svg>',
    `<meta name="description" content="${description}">`,
    '<meta name="viewport" content="width=device-width">',
    '<link rel="canonical" href="https://example.com/body-only">',
    '<meta property="og:title" content="Body-only title">',
    '<meta property="og:image" content="https://example.com/body-only.png">',
    "<h1>Page heading</h1>",
    "</body></html>",
  ].join(""));

  assert.equal(issues.find((issue) => issue.code === "seo.title.missing_or_empty")?.severity, "error");
  assert.equal(issues.find((issue) => issue.code === "seo.meta_description.missing_or_empty")?.severity, "error");
  assert.equal(issues.find((issue) => issue.code === "seo.viewport.missing")?.severity, "error");
  assert.equal(issues.find((issue) => issue.code === "seo.canonical.missing")?.severity, "info");
  assert.equal(issues.find((issue) => issue.code === "seo.open_graph.missing")?.severity, "info");
});

test("title-length guidance keeps editorial thresholds without claiming a fixed Google limit", () => {
  const shortTitle = "s".repeat(29);
  const longTitle = "l".repeat(61);
  const shortIssue = lengthIssue(`<title>${shortTitle}</title>`, "Title is");
  const longIssue = lengthIssue(`<title>${longTitle}</title>`, "Title is");

  assert.deepEqual(shortIssue, {
    code: "seo.title.length",
    severity: "info",
    category: "SEO",
    message: "Title is 29 characters. This is shorter than the audit's common editorial range; review whether it describes the page clearly.",
    element: `<title>${shortTitle}</title>`,
  });
  assert.deepEqual(longIssue, {
    code: "seo.title.length",
    severity: "info",
    category: "SEO",
    message: "Title is 61 characters. This is longer than the audit's common editorial range; Google title links may be shortened or rewritten depending on context and device.",
    element: `<title>${longTitle}</title>`,
  });
  assert.doesNotMatch(longIssue.message, /will truncate|under 60|character limit/i);

  assert.equal(lengthIssue(`<title>${"a".repeat(30)}</title>`, "Title is"), undefined);
  assert.equal(lengthIssue(`<title>${"a".repeat(60)}</title>`, "Title is"), undefined);
});

test("meta-description guidance keeps editorial thresholds without claiming a fixed Google limit", () => {
  const shortDescription = "s".repeat(119);
  const longDescription = "l".repeat(161);
  const shortIssue = lengthIssue(`<meta name="description" content="${shortDescription}">`, "Meta description is");
  const longIssue = lengthIssue(`<meta name="description" content="${longDescription}">`, "Meta description is");

  assert.deepEqual(shortIssue, {
    code: "seo.meta_description.length",
    severity: "info",
    category: "SEO",
    message: "Meta description is 119 characters. This is shorter than the audit's common editorial range; review whether it provides a useful page summary.",
    element: `<meta name="description" content="${shortDescription}">`,
  });
  assert.deepEqual(longIssue, {
    code: "seo.meta_description.length",
    severity: "info",
    category: "SEO",
    message: "Meta description is 161 characters. This is longer than the audit's common editorial range; displayed snippets may be shortened depending on the query and device.",
    element: `<meta name="description" content="${longDescription}">`,
  });
  assert.doesNotMatch(longIssue.message, /will truncate|under 160|character limit/i);

  assert.equal(
    lengthIssue(`<meta name="description" content="${"a".repeat(120)}">`, "Meta description is"),
    undefined,
  );
  assert.equal(
    lengthIssue(`<meta name="description" content="${"a".repeat(160)}">`, "Meta description is"),
    undefined,
  );
});

test("heading-count findings avoid unsupported exact-one-H1 SEO penalties", () => {
  const head = `<head><title>${"T".repeat(40)}</title><meta name="description" content="${"D".repeat(140)}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com/"><meta property="og:title" content="Example"><meta property="og:image" content="https://example.com/image.png"></head>`;

  const missing = auditSeoMetadata(`<html>${head}<body><h2>Page title</h2></body></html>`)
    .find((issue) => issue.message.includes("<h1>"));
  assert.deepEqual(missing, {
    code: "seo.h1.missing",
    severity: "warning",
    category: "SEO",
    message: "No <h1> heading found. Review whether the page has a clear main heading and a meaningful heading hierarchy.",
  });

  const multiple = auditSeoMetadata(`<html>${head}<body><h1>Primary</h1><h1>Secondary</h1></body></html>`)
    .find((issue) => issue.message.includes("<h1>"));
  assert.deepEqual(multiple, {
    code: "seo.h1.multiple",
    severity: "info",
    category: "SEO",
    message: "Found multiple (2) <h1> headings. Multiple H1s are not inherently an SEO error; ensure the heading hierarchy is meaningful and the main visual title is clear.",
  });
});
