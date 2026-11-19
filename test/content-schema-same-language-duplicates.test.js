import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSameLanguageDuplicates,
  MIN_MAIN_CONTENT_WORDS,
  MAX_CONTENT_DUPLICATE_PAIRS,
} from "../dist/modules/content-schema/same-language-duplicates.js";
import { observeMainContent } from "../dist/modules/content-schema/extract-main-content.js";

const words = Array.from({ length: MIN_MAIN_CONTENT_WORDS + 55 }, (_, i) => `uniqueconcept${i}`);
const documentText = words.join(" ");
const make = (url, text = documentText, language = "en", source = "main") =>
  ({ url, text, language, source });
const analyze = (pages, opts) => analyzeSameLanguageDuplicates(pages, opts);

test("P1-01 identifies exact duplicated main text after whitespace and case normalization", () => {
  const first = observeMainContent(
    `<html lang="en-US"><body><nav>${"menu ".repeat(400)}</nav><main><h1>Heading</h1><p>${documentText}</p></main><footer>copyright</footer></body></html>`,
    "https://example.test/en/start",
  );
  const second = observeMainContent(
    `<html lang="en-GB"><body><nav>Different menu</nav><main><h1>HEADING</h1><p>${documentText.toUpperCase()}</p></main></body></html>`,
    "https://example.test/en/other",
  );
  const report = analyze([first, second]);
  assert.equal(report.eligible_pages, 2);
  assert.equal(report.coverage_limited, false);
  assert.deepEqual(report.pairs.map(({ kind, language, similarity_percent, confidence }) =>
    ({ kind, language, similarity_percent, confidence })), [
    { kind: "exact", language: "en", similarity_percent: 100, confidence: "observed" },
  ]);
  assert.ok(!JSON.stringify(report).includes(documentText.slice(0, 70)), "Never return page text");
});

test("P1-01 detects conservative near matches, including punctuation changes", () => {
  const altered = words.slice();
  altered[51] = "newupdatedconcept";
  const report = analyze([
    make("https://example.test/en/a", documentText),
    make("https://example.test/en/b", altered.join(" ") + "!"),
  ]);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].kind, "near");
  assert.equal(report.pairs[0].confidence, "potential");
  assert.ok(report.pairs[0].similarity_percent >= 82 && report.pairs[0].similarity_percent <= 99);
});

test("P1-01 ignores short, unknown-language and wrong-script matches", () => {
  const report = analyze([
    make("https://example.test/a", documentText, "und"),
    make("https://example.test/b", documentText, ""),
    make("https://example.test/c", "a b c", "en"),
    make("https://example.test/d", documentText, "sr-Latn"),
    make("https://example.test/e", documentText, "sr-Cyrl"),
  ]);
  assert.equal(report.eligible_pages, 2);
  assert.equal(report.pairs.length, 0);
  assert.equal(report.skipped_pages, 3);
  assert.equal(report.coverage_limited, true);
});

test("P1-01 compares substantive main content rather than shared navigation/footer boilerplate", () => {
  const template = (content) => `<html lang=en><body><header>${documentText}</header><nav>${documentText}</nav><main>${content}</main><footer>${documentText}</footer></body></html>`;
  const different = words.map((word, i) => i % 2 === 0 ? "changed" + i : word).join(" ");
  const first = observeMainContent(template(documentText), "https://example.test/first");
  const second = observeMainContent(template(different), "https://example.test/second");
  assert.deepEqual(analyze([first, second]).pairs, []);
});

test("P1-01 returns potential evidence for body fallback and ignores template-only main", () => {
  const body = `<html lang=en><body><template><main>${documentText}</main></template><article>${documentText}</article></body></html>`;
  const articles = [
    observeMainContent(body, "https://example.test/a"),
    observeMainContent(body, "https://example.test/b"),
  ];
  assert.equal(articles[0].source, "article");
  assert.equal(analyze(articles).pairs[0].confidence, "observed");

  const fallbacks = [
    observeMainContent(`<html lang=en><body><p>${documentText}</p></body></html>`, "https://example.test/c"),
    observeMainContent(`<html lang=en><body><p>${documentText}</p></body></html>`, "https://example.test/d"),
  ];
  assert.equal(fallbacks[0].source, "body_fallback");
  assert.equal(analyze(fallbacks).pairs[0].confidence, "potential");
});

test("P1-01 refuses to echo query-bearing or credentialed URLs", () => {
  const report = analyze([
    make("https://example.test/page?token=FAKE_PRIVATE", documentText),
    make("https://user:secret@example.test/elsewhere", documentText),
    make("https://example.test/safe", documentText),
  ]);
  assert.equal(report.pairs.length, 0);
  assert.equal(report.eligible_pages, 1);
  assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE|user:secret/);
});

test("P1-01 does not hallucinate near matches for unrelated text or highly repetitive shingle sets", () => {
  const other = Array.from({ length: words.length }, (_, i) => "differenttopic" + i).join(" ");
  assert.deepEqual(analyze([
    make("https://example.test/a"), make("https://example.test/b", other),
  ]).pairs, []);
  const lowDiversity1 = ("news story about technology developments ".repeat(30)).trim();
  const lowDiversity2 = ("news story about technology developments ".repeat(31)).trim();
  assert.deepEqual(analyze([
    make("https://example.test/c", lowDiversity1),
    make("https://example.test/d", lowDiversity2),
  ]).pairs, []);
});

test("P1-01 caps pair outputs deterministically while preserving coverage counts", () => {
  const input = Array.from({ length: 8 }, (_, i) => make(`https://example.test/${i}`));
  const report = analyze(input);
  assert.equal(report.pairs.length, MAX_CONTENT_DUPLICATE_PAIRS);
  assert.equal(report.total_pairs, 28);
  assert.equal(report.pairs_truncated, true);
  assert.equal(report.sampled_pages, 8);
  assert.equal(report.eligible_pages, 8);
  assert.ok(report.pairs.every((pair) => pair.kind === "exact"));
  assert.deepEqual(report, analyze(input));
});

test("P1-01 bounds page count, length and oversized text instead of comparing truncated content", () => {
  assert.throws(() => analyze(Array.from({ length: 9 }, (_, i) =>
    make(`https://example.test/${i}`))), /at most eight/);
  assert.throws(() => analyze([make("https://example.test/a")], { sampledPages: 0 }), /sampledPages/);
  const report = analyze([
    make("https://example.test/a", "x ".repeat(80_000)),
    make("https://example.test/b", documentText),
  ]);
  assert.equal(report.eligible_pages, 1);
  assert.equal(report.skipped_pages, 1);
  assert.equal(report.pairs.length, 0);
});

test("P1-01 normalizes Unicode and compares UTF-8 language-specific text without leaking HTML", () => {
  const sample = Array.from({ length: 140 }, (_, i) => `café${i}`).join(" ");
  const decomposed = sample.normalize("NFD");
  const report = analyze([
    make("https://example.test/a", sample, "fr-FR"),
    make("https://example.test/b", decomposed, "fr-BE"),
  ]);
  assert.equal(report.pairs[0].kind, "exact");
  assert.equal(report.pairs[0].language, "fr");
});
