import assert from "node:assert/strict";
import test from "node:test";
import { createValidationReport } from "../dist/report.js";
import { auditSeoMetadata } from "../dist/seo-auditor.js";

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

test("report scoring does not penalize title and meta-description editorial length guidance", () => {
  const seoIssues = auditSeoMetadata([
    '<html lang="en"><head>',
    `<title>${"T".repeat(61)}</title>`,
    `<meta name="description" content="${"D".repeat(161)}">`,
    '<meta name="viewport" content="width=device-width">',
    '<link rel="canonical" href="https://example.com/">',
    '<meta property="og:title" content="Example">',
    '<meta property="og:image" content="https://example.com/image.png">',
    "</head><body><h1>Example</h1></body></html>",
  ].join(""));
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues,
    schemaIssues: [],
    links: [],
  });

  assert.equal(seoIssues.filter((issue) => issue.code.endsWith(".length")).length, 2);
  assert.equal(result.summary.seoWarnings, 0);
  assert.equal(result.summary.seoScore, 100);
});

test("report scoring does not penalize informational Nu HTML diagnostics", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [
      {
        type: "info",
        message: "Trailing slash on void elements has no effect.",
      },
    ],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [],
  });

  assert.equal(result.summary.htmlErrors, 0);
  assert.equal(result.summary.htmlWarnings, 0);
  assert.equal(result.summary.htmlScore, 100);
});

test("report prose labels the Nu warning counter as warnings rather than all other diagnostics", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [
      { type: "info", subType: "warning", message: "Consider adding a lang attribute." },
      { type: "info", message: "Trailing slash on void elements has no effect." },
    ],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [],
  });

  assert.equal(result.summary.htmlWarnings, 1);
  assert.match(result.report, /HTML: 0 error\(s\), 1 warning\(s\)/);
  assert.doesNotMatch(result.report, /HTML: 0 error\(s\), 1 other diagnostic\(s\)/);
});

test("report produces matching machine-readable counts", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: true,
    htmlMessages: [
      { type: "error", message: "Bad element", lastLine: 2 },
      { type: "info", subType: "warning", message: "Consider a language attribute" },
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

test("report does not count HTTP 304 as a redirect", () => {
  const result = createValidationReport({
    htmlFilePath: "not-modified.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/not-modified", status: 304, ok: true }],
  });

  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.linkScore, 100);
  assert.match(result.report, /0 redirects to review of 1 checked/);
  assert.doesNotMatch(result.report, /1 redirect to review/);
});

test("report withholds CSS and overall scores for known upstream validator limitations", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: true,
    htmlMessages: [],
    cssMessages: [
      {
        type: "error",
        line: 1,
        message: "Unrecognized at-rule “@container”",
        compatibility: "known-validator-limitation",
      },
    ],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/ok", status: 200, ok: true }],
  });

  assert.equal(result.summary.cssErrors, 0);
  assert.equal(result.summary.cssCompatibilityLimitations, 1);
  assert.equal(result.summary.cssScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /CSS validation \| Compatibility-limited \| N\/A/);
  assert.match(result.report, /CSS: 0 error\(s\), 1 known validator limitation\(s\)/);
  assert.match(result.report, /1 known validator limitation/);
  assert.match(result.report, /original Jigsaw diagnostic is preserved/i);
});
