import assert from "node:assert/strict";
import test from "node:test";
import {
  cssValidationContent,
  failureContent,
  htmlValidationContent,
  linkCheckContent,
  screenshotCaptureContent,
  seoAuditContent,
} from "../dist/presentation.js";

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
