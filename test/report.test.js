import assert from "node:assert/strict";
import test from "node:test";
import { createValidationReport } from "../dist/report.js";

test("report scoring does not penalize informational SEO findings", () => {
  const result = createValidationReport({
    htmlFilePath: "site|name.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [{ severity: "info", category: "SEO", message: "Optional social metadata." }],
    schemaIssues: [],
    links: [],
  });

  assert.equal(result.summary.seoScore, 100);
  assert.equal(result.summary.cssScore, null);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /site\\\|name\.html/);
});

test("report produces matching machine-readable counts", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: true,
    htmlMessages: [
      { type: "error", message: "Bad element", lastLine: 2 },
      { type: "info", message: "Consider a language attribute" },
    ],
    cssMessages: [{ type: "error", line: 3, message: "Unexpected token" }],
    seoIssues: [
      { severity: "error", category: "SEO", message: "Missing title" },
      { severity: "warning", category: "SEO", message: "Missing canonical" },
    ],
    schemaIssues: [{ severity: "error", category: "Schema", message: "Invalid JSON" }],
    links: [{ url: "https://example.com/missing", status: 404, ok: false }],
  });

  assert.deepEqual(
    {
      htmlErrors: result.summary.htmlErrors,
      htmlWarnings: result.summary.htmlWarnings,
      cssErrors: result.summary.cssErrors,
      seoErrors: result.summary.seoErrors,
      seoWarnings: result.summary.seoWarnings,
      schemaErrors: result.summary.schemaErrors,
      brokenLinks: result.summary.brokenLinks,
    },
    {
      htmlErrors: 1,
      htmlWarnings: 1,
      cssErrors: 1,
      seoErrors: 1,
      seoWarnings: 1,
      schemaErrors: 1,
      brokenLinks: 1,
    },
  );
});
