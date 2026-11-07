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
      cssWarnings: result.summary.cssWarnings,
      seoErrors: result.summary.seoErrors,
      seoWarnings: result.summary.seoWarnings,
      schemaErrors: result.summary.schemaErrors,
      brokenLinks: result.summary.brokenLinks,
    },
    {
      htmlErrors: 1,
      htmlWarnings: 1,
      cssErrors: 1,
      cssWarnings: 0,
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
  assert.equal(result.summary.brokenLinks, 3);
  assert.equal(result.summary.unverifiedLinks, 2);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /3 confirmed HTTP failures, 2 unverified, 4 redirects to review of 11 checked/);
  assert.match(result.report, /Link integrity \| Incomplete \| N\/A/);
  assert.match(result.report, /\| https:\/\/example\.test\/blocked \| blocked \| Unverified \|/);
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
  assert.equal(redirectsOnly.summary.unverifiedLinks, 0);
  assert.equal(redirectsOnly.summary.linkScore, 100);
});

test("report link details never default to Accessible for failures or unverified checks", () => {
  const result = createValidationReport({
    htmlFilePath: "fallback-details.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      { url: "https://example.test/ok", status: 200, ok: true },
      { url: "https://example.test/redirect", status: 301, ok: true },
      { url: "https://example.test/missing", status: 404, ok: false },
      { url: "https://example.test/error", status: 500, ok: false },
      { url: "https://example.test/limited", status: 429, ok: false },
      { url: "https://example.test/blocked", status: "blocked", ok: false },
      { url: "https://example.test/failed", status: "failed", ok: false },
      { url: "https://example.test/custom", status: 410, ok: false, message: "Gone by owner" },
    ],
  });

  assert.match(result.report, /\| https:\/\/example\.test\/ok \| 200 \| Yes \| Accessible \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/redirect \| 301 \| Yes \| Redirect not followed \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/missing \| 404 \| No \| HTTP response indicated failure \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/error \| 500 \| No \| HTTP response indicated failure \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/limited \| 429 \| Unverified \| Destination availability not verified \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/blocked \| blocked \| Unverified \| Destination availability not verified \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/failed \| failed \| Unverified \| Destination availability not verified \|/);
  assert.match(result.report, /\| https:\/\/example\.test\/custom \| 410 \| No \| Gone by owner \|/);
});

test("report does not penalize or falsely clear checks blocked by policy or network failures", () => {
  const result = createValidationReport({
    htmlFilePath: "partial-links.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      { url: "https://example.test/good", status: 200, ok: true },
      { url: "https://localhost/", status: "blocked", ok: false, message: "Private address" },
      { url: "https://example.test/timeout", status: "failed", ok: false, message: "Timed out" },
    ],
  });
  assert.equal(result.summary.linksChecked, 3);
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 2);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /0 confirmed HTTP failures, 2 unverified/);
  assert.doesNotMatch(result.report, /No links checked/);
});

test("report treats HTTP 429 rate limits as unverified rather than broken destinations", () => {
  const result = createValidationReport({
    htmlFilePath: "rate-limited.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/rate-limited", status: 429, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 unverified/);
  assert.match(result.report, /Incomplete link verification/);
});

test("report withholds link health scores for HTTP 431 request header rejections", () => {
  const result = createValidationReport({
    htmlFilePath: "header-limited.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/header-limited", status: 431, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 unverified/);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /\| https:\/\/example\.test\/header-limited \| 431 \| Unverified \|/);
});

test("report withholds scores for HTTP 451 legal access restrictions", () => {
  const result = createValidationReport({
    htmlFilePath: "legal-access.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/legal", status: 451, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /\| https:\/\/example\.test\/legal \| 451 \| Unverified \|/);
});

test("report withholds scores for authenticated or forbidden link destinations", () => {
  for (const status of [401, 403]) {
    const result = createValidationReport({
      htmlFilePath: "restricted.html",
      cssAudited: false,
      htmlMessages: [],
      cssMessages: [],
      seoIssues: [],
      schemaIssues: [],
      links: [
        { url: "https://example.test/restricted", status, ok: false },
        { url: "https://example.test/missing", status: 404, ok: false },
      ],
    });
    assert.equal(result.summary.brokenLinks, 1);
    assert.equal(result.summary.unverifiedLinks, 1);
    assert.equal(result.summary.linkScore, null);
    assert.equal(result.summary.overallScore, null);
    assert.match(result.report, /Incomplete link verification/);
  }
});

test("report with HTTP 304 withholds link score without marking a redirect or failure", () => {
  const result = createValidationReport({
    htmlFilePath: "not-modified.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/not-modified", status: 304, ok: false }],
  });

  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /0 redirects to review of 1 checked/);
  assert.doesNotMatch(result.report, /1 redirect to review/);
});

test("report treats ambiguous HTTP 300 as incomplete verification rather than a redirect", () => {
  const result = createValidationReport({
    htmlFilePath: "multiple-choices.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/choices", status: 300, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /0 redirects to review of 1 checked/);
});

test("report withholds link score on HTTP 408 instead of claiming a broken URL", () => {
  const result = createValidationReport({
    htmlFilePath: "request-timeout.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/slow", status: 408, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /0 confirmed HTTP failures/);
});

test("report treats HTTP 425 Too Early as unverified instead of a broken URL", () => {
  const result = createValidationReport({
    htmlFilePath: "too-early.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/too-early", status: 425, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /0 confirmed HTTP failures/);
});

test("report withholds scores for HTTP 426 protocol upgrade requirements", () => {
  const result = createValidationReport({
    htmlFilePath: "protocol-upgrade.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/upgrade", status: 426, ok: false }],
  });
  assert.equal(result.summary.brokenLinks, 0);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /Incomplete link verification/);
  assert.match(result.report, /0 confirmed HTTP failures/);
});

test("report withholds link and overall scores for negotiation, precondition and lock refusals", () => {
  const result = createValidationReport({
    htmlFilePath: "conditional-access.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [406, 412, 423, 500].map((status) => ({
      url: `https://example.test/${status}`, status, ok: false,
    })),
  });
  assert.equal(result.summary.brokenLinks, 1);
  assert.equal(result.summary.unverifiedLinks, 3);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 confirmed HTTP failures, 3 unverified/i);
  assert.match(result.report, /Incomplete link verification/);
});

test("report withholds link score for temporary HTTP gateway/service outages while retaining confirmed failures", () => {
  const result = createValidationReport({
    htmlFilePath: "temporary-outages.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      ...[502, 503, 504].map((status) => ({ url: `https://example.test/${status}`, status, ok: false })),
      { url: "https://example.test/500", status: 500, ok: false },
    ],
  });
  assert.equal(result.summary.brokenLinks, 1);
  assert.equal(result.summary.unverifiedLinks, 3);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 confirmed HTTP failures, 3 unverified/i);
  assert.match(result.report, /Incomplete link verification/);
});

test("report does not call proxy-auth or misdirected responses confirmed broken links", () => {
  const result = createValidationReport({
    htmlFilePath: "upstream-routing.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      { url: "https://example.test/407", status: 407, ok: false },
      { url: "https://example.test/421", status: 421, ok: false },
      { url: "https://example.test/500", status: 500, ok: false },
    ],
  });
  assert.equal(result.summary.brokenLinks, 1);
  assert.equal(result.summary.unverifiedLinks, 2);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 confirmed HTTP failures, 2 unverified/i);
  assert.match(result.report, /Incomplete link verification/);
});

test("report withholds broken-link scoring for network authentication challenges", () => {
  const result = createValidationReport({
    htmlFilePath: "network-login.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [
      { url: "https://example.test/network-login", status: 511, ok: false },
      { url: "https://example.test/server-failure", status: 500, ok: false },
    ],
  });
  assert.equal(result.summary.brokenLinks, 1);
  assert.equal(result.summary.unverifiedLinks, 1);
  assert.equal(result.summary.linkScore, null);
  assert.equal(result.summary.overallScore, null);
  assert.match(result.report, /1 confirmed HTTP failures, 1 unverified/i);
  assert.match(result.report, /\| Unverified \| Destination availability not verified/);
});

test("report keeps Cloudflare 520-524 unverified but treats 500 and 525-526 as failures", () => {
  const result = createValidationReport({
    htmlFilePath: "edge-failures.html", cssAudited: false,
    htmlMessages: [], cssMessages: [], seoIssues: [], schemaIssues: [],
    links: [500, 520, 521, 522, 523, 524, 525, 526].map((status) => ({
      url: `https://example.test/${status}`, status, ok: false,
    })),
  });
  assert.equal(result.summary.brokenLinks, 3);
  assert.equal(result.summary.unverifiedLinks, 5);
  assert.equal(result.summary.linkScore, null);
  assert.match(result.report, /3 confirmed HTTP failures, 5 unverified/i);
});

test("report surfaces CSS warnings without counting them as CSS errors", () => {
  const result = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: true,
    htmlMessages: [],
    cssMessages: [
      {
        type: "warning",
        line: 1,
        message: "You are encouraged to offer a generic family as a last alternative",
        context: "p",
      },
    ],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/ok", status: 200, ok: true }],
  });

  assert.equal(result.summary.cssErrors, 0);
  assert.equal(result.summary.cssWarnings, 1);
  assert.equal(result.summary.cssScore, 100);
  assert.match(result.report, /CSS: 0 error\(s\), 1 warning\(s\)/);
  assert.match(result.report, /\| 1 \| warning \| p \| You are encouraged/);
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
  assert.match(result.report, /CSS: 0 error\(s\), 0 warning\(s\), 1 known validator limitation\(s\)/);
  assert.match(result.report, /1 known validator limitation/);
  assert.match(result.report, /original Jigsaw diagnostic is preserved/i);
});
