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


test("canonical detection follows HTML rel token semantics and requires a non-empty href", () => {
  const valid = auditSeoMetadata('<link rel="Alternate CANONICAL" href="https://example.com/page">');
  assert.equal(valid.find((issue) => issue.code === "seo.canonical.missing"), undefined);

  const empty = auditSeoMetadata('<link rel="canonical" href="   ">');
  assert.deepEqual(empty.find((issue) => issue.code === "seo.canonical.missing"), {
    code: "seo.canonical.missing",
    severity: "warning",
    category: "SEO",
    message: "Missing or empty canonical link target. Add a non-empty href to <link rel=\"canonical\"> when this page needs an explicit canonical signal.",
  });
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
test("title-length warnings keep the editorial thresholds without claiming a fixed Google limit", () => {
  const shortTitle = "s".repeat(29);
  const longTitle = "l".repeat(61);
  const shortIssue = lengthIssue(`<title>${shortTitle}</title>`, "Title is");
  const longIssue = lengthIssue(`<title>${longTitle}</title>`, "Title is");

  assert.deepEqual(shortIssue, {
    code: "seo.title.length",
    severity: "warning",
    category: "SEO",
    message: "Title is 29 characters. This is shorter than the audit's common editorial range; review whether it describes the page clearly.",
    element: `<title>${shortTitle}</title>`,
  });
  assert.deepEqual(longIssue, {
    code: "seo.title.length",
    severity: "warning",
    category: "SEO",
    message: "Title is 61 characters. This is longer than the audit's common editorial range; Google title links may be shortened or rewritten depending on context and device.",
    element: `<title>${longTitle}</title>`,
  });
  assert.doesNotMatch(longIssue.message, /will truncate|under 60|character limit/i);

  assert.equal(lengthIssue(`<title>${"a".repeat(30)}</title>`, "Title is"), undefined);
  assert.equal(lengthIssue(`<title>${"a".repeat(60)}</title>`, "Title is"), undefined);
});

test("meta-description warnings keep the editorial thresholds without claiming a fixed Google limit", () => {
  const shortDescription = "s".repeat(119);
  const longDescription = "l".repeat(161);
  const shortIssue = lengthIssue(`<meta name="description" content="${shortDescription}">`, "Meta description is");
  const longIssue = lengthIssue(`<meta name="description" content="${longDescription}">`, "Meta description is");

  assert.deepEqual(shortIssue, {
    code: "seo.meta_description.length",
    severity: "warning",
    category: "SEO",
    message: "Meta description is 119 characters. This is shorter than the audit's common editorial range; review whether it provides a useful page summary.",
    element: `<meta name="description" content="${shortDescription}">`,
  });
  assert.deepEqual(longIssue, {
    code: "seo.meta_description.length",
    severity: "warning",
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
