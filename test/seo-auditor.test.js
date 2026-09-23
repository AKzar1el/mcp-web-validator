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

test("image submit buttons require non-empty functional alt text", () => {
  for (const html of [
    '<input type="image" src="search.png">',
    '<input type="IMAGE" src="search.png" alt="">',
    '<input type="image" src="search.png" alt="   ">',
  ]) {
    assert.deepEqual(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"),
      {
        code: "accessibility.input_image_alt.missing_or_empty",
        severity: "error",
        category: "Accessibility",
        message: "Image submit buttons need non-empty alt text that labels the button's function.",
      },
    );
  }

  for (const html of [
    '<input type="image" src="search.png" alt="Search">',
    '<input type="text" alt="">',
    '<template><input type="image" src="search.png"></template>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"),
      undefined,
    );
  }
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
        message: "Image-map links need alt text unless another area with the same href provides the label.",
      },
    );
  }

  for (const html of [
    '<map name="nav"><area href="/docs" alt="Documentation"></map>',
    '<map name="nav"><area shape="default"></map>',
    '<map name="nav"><area href="/docs" alt=""><area href="/docs" alt="Documentation"></map>',
    '<template><map name="nav"><area href="/docs"></map></template>',
  ]) {
    assert.equal(
      auditSeoMetadata(html).find((issue) => issue.code === "accessibility.area_alt.missing_or_empty"),
      undefined,
    );
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
