import assert from "node:assert/strict";
import test from "node:test";
import {
  cssValidationContent,
  failureContent,
  htmlValidationContent,
  linkCheckContent,
  reportContent,
  schemaValidationContent,
  screenshotCaptureContent,
  screenshotPartialCaptureContent,
  seoAuditContent,
} from "../dist/presentation.js";
import { createValidationReport } from "../dist/report.js";

const hostileProse =
  '**bold** <img src="https://evil.test/pixel"> [link](https://evil.test) ![pixel](https://evil.test/pixel) `code` \\path';

function assertProseIsEscaped(output) {
  assert.doesNotMatch(output, /<img\b/i);
  assert.ok(!output.includes("**bold**"));
  assert.ok(!output.includes("[link]("));
  assert.ok(!output.includes("![pixel]("));
  assert.ok(output.includes('&lt;img src="https://evil\\.test/pixel"&gt;'));
  assert.ok(output.includes("\\*\\*bold\\*\\*"));
  assert.ok(output.includes("\\!\\[pixel\\]\\(https://evil\\.test/pixel\\)"));
}

test("finding and failure narration escapes hostile Markdown and inline HTML", () => {
  const css = cssValidationContent([
    { type: "error", line: 7, message: hostileProse, context: hostileProse },
  ]);
  assert.match(css, /^### CSS validation: attention needed/m);
  assert.match(css, /\*\*Fix first\*\*/);
  assert.match(css, /\*\*Error\*\*/);
  assertProseIsEscaped(css);

  const failure = failureContent(
    "CSS validation",
    hostileProse,
    "Retry after checking the validator.",
  );
  assert.match(failure, /^### CSS validation: could not finish/m);
  assertProseIsEscaped(failure);
});

test("narration strips terminal control characters from untrusted diagnostics and URLs", () => {
  const hostile = "Issue \u001b[31mred\u001b[0m \u0007bell \u0008backspace \u009bCSI";
  const outputs = [
    htmlValidationContent([{ type: "error", message: hostile, lastLine: 2 }]),
    linkCheckContent([{
      url: "https://example.test/path\u001b[2J",
      status: "failed",
      ok: false,
      message: hostile,
    }]),
    failureContent("HTML validation", hostile, "Retry with safe input."),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    assert.match(output, /backspace/);
    assert.match(output, /red/);
  }
});

test("narration strips bidirectional formatting controls without removing RTL text", () => {
  const rtl = "\u0645\u0631\u062d\u0628\u0627";
  const hostile = `Issue \u202ereversed\u202c \u2066isolated\u2069 \u200e${rtl}\u061c`;
  const outputs = [
    htmlValidationContent([{ type: "error", message: hostile }]),
    linkCheckContent([{ url: `https://example.test/\u202espoof`, status: "failed", ok: false, message: hostile }]),
    failureContent("HTML validation", hostile, "Retry after checking the input."),
  ];
  for (const output of outputs) {
    assert.doesNotMatch(output, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    assert.ok(output.includes(rtl), "natural RTL letters must remain visible");
  }
});

test("all action-based narrations use the shared escaping boundary", () => {
  const html = htmlValidationContent([{ type: "error", message: hostileProse, lastLine: 3 }]);
  const seo = seoAuditContent(
    [{ severity: "error", category: "SEO", message: hostileProse, element: "<title>safe location</title>" }],
    1,
    false,
  );
  const links = linkCheckContent([
    {
      url: "https://example.test/path",
      status: "failed",
      ok: false,
      message: hostileProse,
    },
  ]);

  for (const output of [html, seo, links]) {
    assertProseIsEscaped(output);
  }
});

test("HTML narration promotes Nu info+warning diagnostics as warnings", () => {
  const output = htmlValidationContent([
    { type: "info", subType: "warning", message: "Consider adding a lang attribute." },
    { type: "info", message: "Trailing slash on void elements has no effect." },
  ]);

  assert.match(output, /\*\*Warning\*\*: Consider adding a lang attribute/);
  assert.match(output, /\*\*Check\*\*: Trailing slash on void elements has no effect/);
});

test("informational-only HTML narration does not instruct users to fix nonexistent errors", () => {
  const output = htmlValidationContent([
    { type: "info", message: "Trailing slash on void elements has no effect." },
  ]);

  assert.match(output, /^### HTML validation: review suggested/m);
  assert.match(output, /\*\*Review\*\*/);
  assert.doesNotMatch(output, /\*\*Fix first\*\*/);
  assert.match(output, /review the informational diagnostic/i);
  assert.doesNotMatch(output, /Fix the errors/i);
});

test("informational-only SEO narration is review guidance rather than attention-needed work", () => {
  const output = seoAuditContent(
    [{ severity: "info", category: "SEO", message: "No canonical preference is declared." }],
    1,
    false,
  );

  assert.match(output, /^### SEO audit: review suggested/m);
  assert.match(output, /\*\*Review\*\*/);
  assert.doesNotMatch(output, /\*\*Fix first\*\*/);
  assert.match(output, /review the suggestions/i);
  assert.doesNotMatch(output, /Address errors first/i);
});

test("SEO narration uses full severity counts when structured findings are truncated", () => {
  const issues = Array.from({ length: 200 }, (_, index) => ({
    severity: "warning",
    category: "SEO",
    message: `Issue ${index + 1}`,
  }));
  const output = seoAuditContent(
    issues,
    205,
    true,
    { error: 0, warning: 205, info: 0 },
  );

  assert.match(output, /0 errors, 205 warnings, and 0 suggestions/);
  assert.match(output, /first 200 of 205 findings/i);
});

test("CSS narration treats known Jigsaw parser gaps as review items while preserving the diagnostic", () => {
  const output = cssValidationContent([
    {
      type: "error",
      line: 1,
      message: "Unrecognized at-rule “@container”",
      compatibility: "known-validator-limitation",
    },
  ]);

  assert.match(output, /^### CSS validation: review suggested/m);
  assert.match(output, /known validator limitation/i);
  assert.match(output, /Unrecognized/);
  assert.match(output, /\*\*Check\*\*/);
  assert.match(output, /\*\*Review\*\*/);
  assert.doesNotMatch(output, /\*\*Fix first\*\*/);
  assert.doesNotMatch(output, /\*\*Error\*\*/);
});

test("CSS narration presents Jigsaw warnings as review items instead of errors", () => {
  const output = cssValidationContent([
    {
      type: "warning",
      line: 1,
      message: "You are encouraged to offer a generic family as a last alternative",
      context: "p",
    },
  ]);

  assert.match(output, /^### CSS validation: review suggested/m);
  assert.match(output, /0 CSS errors, 1 CSS warning/);
  assert.match(output, /\*\*Warning\*\*/);
  assert.match(output, /\*\*Review\*\*/);
  assert.doesNotMatch(output, /\*\*Fix first\*\*/);
  assert.doesNotMatch(output, /\*\*Error\*\*/);
});

test("report narration separates known CSS limitations from trusted CSS errors", () => {
  const reportData = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: true,
    htmlMessages: [],
    cssMessages: [
      {
        type: "error",
        line: 1,
        message: "Unrecognized at-rule @container",
        compatibility: "known-validator-limitation",
      },
    ],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/ok", status: 200, ok: true }],
  });
  const output = reportContent(reportData);

  assert.match(output, /0 CSS errors, 0 CSS warnings; 1 known validator limitation/);
  assert.doesNotMatch(output, /0 CSS errors, including 1 known validator limitation/);
});
test("link narration treats redirects as review items instead of broken links", () => {
  const output = linkCheckContent([
    { url: "https://example.test/redirect", status: 301, ok: true, message: "Redirect not followed" },
    { url: "https://example.test/missing", status: 404, ok: false },
  ]);

  assert.match(output, /^### Link check: attention needed/m);
  assert.match(output, /1 link returned an HTTP failure; 1 redirect needs review/i);
  assert.match(output, /301 redirect; destination was not followed/);
  assert.match(output, /Link returned HTTP 404/);

  const redirectsOnly = linkCheckContent([
    { url: "https://example.test/redirect", status: 308, ok: true, message: "Redirect not followed" },
  ]);
  assert.match(redirectsOnly, /^### Link check: review suggested/m);
  assert.match(redirectsOnly, /no confirmed HTTP failures; 1 redirect needs review/i);
  assert.match(redirectsOnly, /\*\*Review\*\*/);
  assert.doesNotMatch(redirectsOnly, /\*\*Fix first\*\*/);
  assert.doesNotMatch(redirectsOnly, /Link returned HTTP 308/);
});

test("link and report narration distinguish unverified checks from HTTP failures", () => {
  const links = [
    { url: "https://example.test/missing", status: 404, ok: false },
    { url: "https://example.test/blocked", status: "blocked", ok: false, message: "Address blocked" },
    { url: "https://example.test/timeout", status: "failed", ok: false, message: "Timeout" },
  ];
  const linkOutput = linkCheckContent(links);
  assert.match(linkOutput, /1 link returned an HTTP failure; 2 checks unverified/i);
  assert.match(linkOutput, /could not be verified .*blocked/i);
  assert.doesNotMatch(linkOutput, /3 links? (?:is|are) broken/i);

  const reportData = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links,
  });
  const reportOutput = reportContent(reportData);
  assert.match(reportOutput, /^### Validation report: partial/m);
  assert.match(reportOutput, /overall heuristic score is withheld.*2 unverified link checks/i);
  assert.match(reportOutput, /1 confirmed HTTP failure, 2 unverified/i);
  assert.doesNotMatch(reportOutput, /null\/100/);
});

test("report narration with unfollowed redirects withholds scores without calling checked links absent", () => {
  const reportData = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [],
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [{ url: "https://example.test/moved", status: 301, ok: true }],
  });
  assert.equal(reportData.summary.overallScore, null);
  assert.equal(reportData.summary.linkScore, null);

  const output = reportContent(reportData);
  assert.match(output, /^### Validation report: partial/m);
  assert.match(output, /overall heuristic score is withheld.*redirect/i);
  assert.match(output, /1 redirect to review of 1 link/i);
  assert.doesNotMatch(output, /null\/100|no eligible links checked/i);
});

test("report narration never interpolates null scores when diagnostic counts are incomplete", () => {
  const reportData = createValidationReport({
    htmlFilePath: "index.html",
    cssAudited: false,
    htmlMessages: [{ type: "error", message: "Invalid markup" }],
    htmlTotalMessages: 2,
    htmlTruncated: true,
    cssMessages: [],
    seoIssues: [],
    schemaIssues: [],
    links: [],
  });
  assert.equal(reportData.summary.overallScore, null);

  const output = reportContent(reportData);
  assert.match(output, /^### Validation report: partial/m);
  assert.match(output, /overall heuristic score is unavailable.*incomplete/i);
  assert.doesNotMatch(output, /null\/100/i);
});

test("link narration treats HTTP 304 as unverified, not a redirect or broken link", () => {
  const output = linkCheckContent([
    { url: "https://example.test/not-modified", status: 304, ok: false },
  ]);

  assert.match(output, /^### Link check: partial/m);
  assert.match(output, /1 check unverified/i);
  assert.match(output, /could not be verified/i);
  assert.doesNotMatch(output, /304 redirect/i);
  assert.doesNotMatch(output, /1 link returned an HTTP failure/i);
});

test("link narration treats HTTP 300 as unverified, not a redirect or broken link", () => {
  const output = linkCheckContent([
    { url: "https://example.test/choices", status: 300, ok: false },
  ]);
  assert.match(output, /^### Link check: partial/m);
  assert.match(output, /1 check unverified/i);
  assert.doesNotMatch(output, /300 redirect/i);
  assert.doesNotMatch(output, /1 link returned an HTTP failure/i);
});

test("link narration treats HTTP 408 as an unverified timeout, not a broken URL", () => {
  const output = linkCheckContent([
    { url: "https://example.test/slow", status: 408, ok: false },
  ]);
  assert.match(output, /^### Link check: partial/m);
  assert.match(output, /1 check unverified/i);
  assert.match(output, /could not be verified/i);
  assert.doesNotMatch(output, /1 link returned an HTTP failure/i);
});

test("link narration treats HTTP 425 Too Early as partial verification, not a broken URL", () => {
  const output = linkCheckContent([
    { url: "https://example.test/too-early", status: 425, ok: false },
  ]);
  assert.match(output, /^### Link check: partial/m);
  assert.match(output, /1 check unverified/i);
  assert.doesNotMatch(output, /1 link returned an HTTP failure/i);
});

test("link narration keeps server outages unverified without hiding confirmed missing links", () => {
  const outageOnly = linkCheckContent(
    [502, 503, 504].map((status) => ({ url: `https://example.test/${status}`, status, ok: false })),
  );
  assert.match(outageOnly, /^### Link check: partial/m);
  assert.match(outageOnly, /3 checks unverified/i);
  assert.doesNotMatch(outageOnly, /links? returned an HTTP failure/i);

  const mixed = linkCheckContent([
    { url: "https://example.test/404", status: 404, ok: false },
    { url: "https://example.test/503", status: 503, ok: false },
  ]);
  assert.match(mixed, /1 link returned an HTTP failure; 1 check unverified/i);
});

test("link narration distinguishes proxy challenges and misdirected requests from broken URLs", () => {
  const partial = linkCheckContent(
    [407, 421].map((status) => ({ url: `https://example.test/${status}`, status, ok: false })),
  );
  assert.match(partial, /^### Link check: partial/m);
  assert.match(partial, /2 checks unverified/i);
  assert.doesNotMatch(partial, /links? returned an HTTP failure/i);
  const mixed = linkCheckContent([
    { url: "https://example.test/404", status: 404, ok: false },
    { url: "https://example.test/407", status: 407, ok: false },
  ]);
  assert.match(mixed, /1 link returned an HTTP failure; 1 check unverified/i);
});

test("link narration treats HTTP 511 network authentication as unverified, not a broken destination", () => {
  const partial = linkCheckContent([{ url: "https://example.test/network-login", status: 511, ok: false }]);
  assert.match(partial, /^### Link check: partial/m);
  assert.match(partial, /1 check unverified/i);
  assert.doesNotMatch(partial, /1 link returned an HTTP failure/i);
  const mixed = linkCheckContent([
    { url: "https://example.test/network-login", status: 511, ok: false },
    { url: "https://example.test/missing", status: 404, ok: false },
  ]);
  assert.match(mixed, /1 link returned an HTTP failure; 1 check unverified/i);
});

test("link narration distinguishes Cloudflare edge failures from origin and TLS failures", () => {
  const links = [500, 520, 521, 522, 523, 524, 525, 526].map((status) => ({
    url: `https://example.test/${status}`, status, ok: false,
  }));
  const output = linkCheckContent(links);
  assert.match(output, /2 links returned HTTP failures; 6 checks unverified/i);
});

test("link narration treats HTTP 429 as a partial check instead of a broken URL", () => {
  const output = linkCheckContent([
    { url: "https://example.test/limited", status: 429, ok: false, message: "Rate limited" },
  ]);
  assert.match(output, /^### Link check: partial/m);
  assert.match(output, /1 check unverified/i);
  assert.match(output, /\*\*Review\*\*/);
  assert.doesNotMatch(output, /\*\*Fix first\*\*/);
  assert.match(output, /could not be verified/i);
  assert.match(output, /429/);
  assert.match(output, /no confirmed HTTP failures/i);
  assert.doesNotMatch(output, /1 link returned an HTTP failure/i);
});

test("user-derived URLs, snippets, and paths remain inside unbreakable code spans", () => {
  const source = "https://example.test/`source`/[link](https://evil.test)";
  const html = htmlValidationContent([], source);
  assert.ok(html.includes("``https://example.test/`source`/[link](https://evil.test)``"));

  const outputDirectory = "C:\\demo`name\\![pixel](https://evil.test)<img>";
  const screenshot = screenshotCaptureContent(1, outputDirectory);
  assert.ok(screenshot.includes(`\`\`${outputDirectory}\`\``));

  const element = "`<img src=https://evil.test>`";
  const seo = seoAuditContent(
    [{ severity: "warning", category: "SEO", message: "Review this element.", element }],
    1,
    false,
  );
  assert.ok(seo.includes("`` `<img src=https://evil.test>` ``"));
});

test("partial screenshots report retained files without claiming the whole capture succeeded", () => {
  const output = screenshotPartialCaptureContent(1, "C:\\screenshots", "mobile navigation failed");
  assert.match(output, /^### Screenshot capture: partial/m);
  assert.match(output, /Saved 1 PNG screenshot/);
  assert.match(output, /mobile navigation failed/);
  assert.match(output, /retry the unfinished viewport/i);
  assert.doesNotMatch(output, /status: complete/i);
});

test("JSON-LD narration counts parameterized media types that the schema parser accepts", () => {
  const output = schemaValidationContent(
    [],
    0,
    false,
    '<script type="Application/LD+JSON; profile=https://www.w3.org/ns/json-ld#frame">{"@context":"https://schema.org"}</script>',
  );

  assert.match(output, /^### JSON-LD syntax: clean/m);
  assert.match(output, /1 JSON-LD block parsed without syntax errors/);
  assert.doesNotMatch(output, /No JSON-LD script blocks were found/);
});

test("JSON-LD narration excludes inert template scripts from parsed block counts", () => {
  const inertScript = '<template><script type="application/ld+json">{invalid</script></template>';
  const activeScript = '<script type="application/ld+json">{"@context":"https://schema.org"}</script>';

  const inertOnly = schemaValidationContent([], 0, false, inertScript);
  assert.match(inertOnly, /^### JSON-LD syntax: not present/m);
  assert.match(inertOnly, /No JSON-LD script blocks were found/);
  assert.doesNotMatch(inertOnly, /parsed without syntax errors/);

  const mixed = schemaValidationContent([], 0, false, inertScript + activeScript);
  assert.match(mixed, /^### JSON-LD syntax: clean/m);
  assert.match(mixed, /1 JSON-LD block parsed without syntax errors/);
  assert.doesNotMatch(mixed, /2 JSON-LD blocks/);
});
