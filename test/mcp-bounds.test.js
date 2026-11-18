import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedMcpArray,
  boundedMcpIssues,
  boundedMcpReport,
  jsonBytes,
  MAX_MCP_STRUCTURED_BYTES,
} from "../dist/mcp-bounds.js";
import { createValidationReport } from "../dist/report.js";

test("byte-budgeted diagnostic arrays preserve complete counts", () => {
  const issues = Array.from({ length: 100 }, (_, i) => ({
    code: `seo.image.alt.${i}`,
    severity: "error",
    category: "SEO",
    message: "Missing alt text " + "z".repeat(350),
    element: `<img src="/image-${i}.png">`,
  }));
  const bounded = boundedMcpIssues({
    issues,
    totalIssues: 100,
    counts: { error: 100, warning: 0, info: 0 },
    truncated: false,
  });
  assert.ok(bounded.issues.length > 0 && bounded.issues.length < issues.length);
  assert.equal(bounded.totalIssues, 100);
  assert.deepEqual(bounded.counts, { error: 100, warning: 0, info: 0 });
  assert.equal(bounded.truncated, true);
  assert.ok(jsonBytes(bounded.issues) <= MAX_MCP_STRUCTURED_BYTES);
  assert.deepEqual(boundedMcpArray([{ message: "x".repeat(20_000) }]), []);
});

test("oversized combined reports retain totals and scores without transport failures", () => {
  const htmlMessages = Array.from({ length: 420 }, (_, i) => ({
    type: "error",
    lastLine: i + 1,
    lastColumn: 10,
    message: "An image must have an alt attribute " + "z".repeat(200),
    extract: `<img src="long-file-${i}.png">`,
  }));
  const seoIssues = Array.from({ length: 420 }, (_, i) => ({
    code: "seo.image.alt.missing",
    severity: "error",
    category: "Accessibility",
    message: "Missing alternative text " + "x".repeat(260),
    element: `<img src="/img-${i}.png">`,
  }));
  const schemaIssues = Array.from({ length: 420 }, (_, i) => ({
    code: "schema.jsonld.invalid_json",
    severity: "error",
    category: "Schema",
    message: "Invalid JSON syntax " + "q".repeat(260),
  }));
  const links = Array.from({ length: 25 }, (_, i) => ({
    url: `http://127.0.0.1/private/${i}/${"p".repeat(1800)}`,
    status: "blocked",
    ok: false,
    message: "Private address blocked",
  }));
  const report = createValidationReport({
    htmlFilePath: "synthetic-large.html",
    cssAudited: false,
    htmlMessages,
    htmlTotalMessages: 420,
    htmlCounts: { error: 420, warning: 0, info: 0 },
    cssMessages: [],
    seoIssues,
    seoTotalIssues: 420,
    seoCounts: { error: 420, warning: 0, info: 0 },
    schemaIssues,
    schemaTotalIssues: 420,
    schemaCounts: { error: 420, warning: 0, info: 0 },
    links,
  });
  assert.ok(jsonBytes(report) > MAX_MCP_STRUCTURED_BYTES);
  const limited = boundedMcpReport(report, "Synthetic summary: many errors were detected.");
  assert.ok(jsonBytes(limited) <= MAX_MCP_STRUCTURED_BYTES);
  assert.deepEqual(limited.summary, report.summary);
  assert.equal(limited.summary.htmlErrors, 420);
  assert.equal(limited.summary.seoErrors, 420);
  assert.equal(limited.summary.schemaErrors, 420);
  assert.equal(limited.summary.linksChecked, 25);
  assert.equal(limited.htmlTotalMessages, 420);
  assert.equal(limited.seoTotalIssues, 420);
  assert.equal(limited.schemaTotalIssues, 420);
  assert.equal(limited.htmlTruncated, true);
  assert.equal(limited.seoTruncated, true);
  assert.equal(limited.schemaTruncated, true);
  assert.ok(limited.htmlMessages.length < 420);
  assert.ok(limited.seoIssues.length < 420);
  assert.ok(limited.schemaIssues.length < 420);
  assert.ok(limited.links.length < 25);
  assert.match(limited.report, /condensed/);
  assert.match(limited.report, /links \d+\/25/);
});

test("small reports retain their complete original content", () => {
  const normal = createValidationReport({
    htmlFilePath: "normal.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [],
  });
  assert.equal(boundedMcpReport(normal, "Normal report"), normal);
});
