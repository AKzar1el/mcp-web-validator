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

test("report keeps redirects visible without counting them as broken links", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      { url: "https://example.test/ok", status: 200, ok: true },
      { url: "https://example.test/no-content", status: 204, ok: true },
      ...[301, 302, 307, 308].map((status) => ({
        url: `https://example.test/${status}`,
        status,
        ok: true,
        message: "Redirect not followed",
      })),
      { url: "https://example.test/missing", status: 404, ok: false },
      { url: "https://example.test/gone", status: 410, ok: false },
      { url: "https://example.test/error", status: 500, ok: false },
      { url: "https://example.test/blocked", status: "blocked", ok: false },
      { url: "https://example.test/failed", status: "failed", ok: false },
    ],
  });

  assert.equal(result.summary.linksChecked, 11);
  assert.equal(result.summary.brokenLinks, 5);
  assert.equal(result.summary.linkScore, 0);
  assert.match(result.report, /5 broken or unreachable, 4 redirects to review of 11 checked/);
  assert.match(result.report, /\| https:\/\/example\.test\/301 \| 301 \| Yes \| Redirect not followed \|/);

  const redirectsOnly = createValidationReport({
    htmlFilePath: "redirects.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/redirect", status: 301, ok: true, message: "Redirect not followed" }],
  });
  assert.equal(redirectsOnly.summary.brokenLinks, 0);
  assert.equal(redirectsOnly.summary.linkScore, 100);
});
