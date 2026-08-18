import assert from "node:assert/strict";
import test from "node:test";
import { generateValidationReport } from "../dist/index.js";
import { reportContent } from "../dist/presentation.js";

const html = "<!doctype html><html><head><title>Test</title></head><body><h1>Test</h1></body></html>";
const htmlMessages = [{ type: "error", message: "Missing language attribute" }];
const cssMessages = [{ type: "error", line: 1, message: "Unexpected token" }];
const seoIssues = [{ severity: "warning", category: "SEO", message: "Missing description" }];
const schemaIssues = [{ severity: "error", category: "Schema", message: "Invalid JSON-LD" }];
const links = [{ url: "https://example.com/", status: 200, ok: true }];

function reportDependencies(overrides = {}) {
  return {
    readTextFile: async (filePath) => filePath.endsWith(".css") ? "body {}" : html,
    validateHtmlContent: async () => htmlMessages,
    validateCssContent: async () => cssMessages,
    auditSeoMetadata: () => seoIssues,
    validateSchemaMarkup: () => schemaIssues,
    checkBrokenLinks: async () => links,
    ...overrides,
  };
}

async function runReport(overrides, options = {}) {
  return generateValidationReport(
    { htmlFilePath: "page.html", ...options },
    reportDependencies(overrides),
  );
}

test("validation report keeps all-success results and treats omitted CSS as not audited", async () => {
  const withoutCss = await runReport({});
  assert.deepEqual(withoutCss.failedChecks, []);
  assert.equal(withoutCss.summary.cssScore, null);
  assert.equal(typeof withoutCss.summary.overallScore, "number");

  const withCss = await runReport({}, { cssFilePath: "page.css" });
  assert.deepEqual(withCss.failedChecks, []);
  assert.deepEqual(withCss.htmlMessages, htmlMessages);
  assert.deepEqual(withCss.cssMessages, cssMessages);
  assert.deepEqual(withCss.seoIssues, seoIssues);
  assert.deepEqual(withCss.schemaIssues, schemaIssues);
  assert.deepEqual(withCss.links, links);
  assert.equal(typeof withCss.summary.overallScore, "number");
});

test("validation report keeps local and link results when HTML validation fails", async () => {
  const report = await runReport({
    validateHtmlContent: async () => { throw new Error("Nu HTML Checker unavailable"); },
  });

  assert.deepEqual(report.failedChecks, ["html"]);
  assert.equal(report.summary.htmlScore, null);
  assert.equal(report.summary.overallScore, null);
  assert.deepEqual(report.seoIssues, seoIssues);
  assert.deepEqual(report.schemaIssues, schemaIssues);
  assert.deepEqual(report.links, links);
  assert.match(report.errors?.[0] ?? "", /HTML validation was unavailable/);
  assert.match(reportContent(report), /Partial validation report: HTML validation was unavailable; remaining checks completed/);
});

test("validation report keeps independent results when CSS validation or CSS reading fails", async () => {
  const validationFailure = await runReport({
    validateCssContent: async () => { throw new Error("CSS validator unavailable"); },
  }, { cssFilePath: "page.css" });

  assert.deepEqual(validationFailure.failedChecks, ["css"]);
  assert.equal(validationFailure.summary.cssScore, null);
  assert.deepEqual(validationFailure.htmlMessages, htmlMessages);
  assert.deepEqual(validationFailure.seoIssues, seoIssues);
  assert.deepEqual(validationFailure.schemaIssues, schemaIssues);
  assert.deepEqual(validationFailure.links, links);

  let cssValidationCalled = false;
  const readFailure = await runReport({
    readTextFile: async (filePath) => {
      if (filePath.endsWith(".css")) throw new Error("CSS file is unreadable");
      return html;
    },
    validateCssContent: async () => {
      cssValidationCalled = true;
      return cssMessages;
    },
  }, { cssFilePath: "page.css" });

  assert.deepEqual(readFailure.failedChecks, ["css"]);
  assert.equal(cssValidationCalled, false);
  assert.deepEqual(readFailure.htmlMessages, htmlMessages);
  assert.match(readFailure.errors?.[0] ?? "", /CSS file is unreadable/);
});

test("validation report keeps successful checks when link checking fails", async () => {
  const report = await runReport({
    checkBrokenLinks: async () => { throw new Error("Link checker timed out"); },
  });

  assert.deepEqual(report.failedChecks, ["links"]);
  assert.equal(report.summary.linkScore, null);
  assert.deepEqual(report.htmlMessages, htmlMessages);
  assert.deepEqual(report.seoIssues, seoIssues);
  assert.deepEqual(report.schemaIssues, schemaIssues);
  assert.match(report.errors?.[0] ?? "", /Link checker timed out/);
});

test("validation report records unexpected local analysis failures without losing other checks", async () => {
  const report = await runReport({
    auditSeoMetadata: () => { throw new Error("SEO analysis failed"); },
    validateSchemaMarkup: () => { throw new Error("Schema analysis failed"); },
  });

  assert.deepEqual(report.failedChecks, ["seo", "schema"]);
  assert.equal(report.summary.seoScore, null);
  assert.equal(report.summary.overallScore, null);
  assert.deepEqual(report.htmlMessages, htmlMessages);
  assert.deepEqual(report.links, links);
  assert.equal(report.errors?.length, 2);
});

test("validation report preserves remaining results and discloses every failed check", async () => {
  const report = await runReport({
    validateHtmlContent: async () => { throw new Error("HTML unavailable"); },
    validateCssContent: async () => { throw new Error("CSS unavailable"); },
    checkBrokenLinks: async () => { throw new Error("Links unavailable"); },
  }, { cssFilePath: "page.css" });

  assert.deepEqual(report.failedChecks, ["html", "css", "links"]);
  assert.equal(report.summary.overallScore, null);
  assert.deepEqual(report.seoIssues, seoIssues);
  assert.deepEqual(report.schemaIssues, schemaIssues);
  assert.equal(report.errors?.length, 3);
  assert.match(report.report, /Partial validation report/);
  assert.match(reportContent(report), /HTML validation, CSS validation, link checking were unavailable/);
});

test("validation report still rejects a fatal HTML file read failure", async () => {
  await assert.rejects(
    runReport({ readTextFile: async () => { throw new Error("HTML file is unreadable"); } }),
    /HTML file is unreadable/,
  );
});
