import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSeoMetadata,
  auditSeoMetadataDetailed,
  MAX_AUDIT_ISSUES,
  validateSchemaMarkup,
  validateSchemaMarkupDetailed,
} from "../dist/seo-auditor.js";

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
