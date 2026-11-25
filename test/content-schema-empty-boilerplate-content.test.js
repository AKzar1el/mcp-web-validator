import assert from "node:assert/strict";
import test from "node:test";
import { observeMainContent } from "../dist/modules/content-schema/extract-main-content.js";
import { analyzePageContentQuality } from "../dist/modules/content-schema/empty-boilerplate-content.js";

const longWords = Array.from({ length: 135 }, (_, i) => "uniqueword" + i).join(" ");
const shared = Array.from({ length: 5 }, (_, i) =>
  Array.from({ length: 22 }, (_, j) => "shared" + i + "term" + j).join(" ") + ".").join(" ");
const unique = (id, count = 16) =>
  Array.from({ length: count }, (_, i) => "unique" + id + "term" + i).join(" ") + ".";
const mk = (name, body, lang = "en") =>
  observeMainContent('<!doctype html><html lang="' + lang
    + '"><body><nav>' + shared + '</nav><main>' + body
    + '</main><footer>' + shared + '</footer></body></html>',
    "https://example.test/products/" + name);
const analyze = (pages, opts) => analyzePageContentQuality(pages, opts);
const codes = (r) => r.findings.map((f) => f.code);

test("P1-03 detects empty static main text and groups two empty product pages as a family", () => {
  const report = analyze([mk("a", ""), mk("b", "<script>document.write('text')</script>")]);
  assert.equal(report.sampled_pages, 2);
  assert.equal(report.eligible_pages, 2);
  assert.equal(report.empty_main_pages, 2);
  assert(codes(report).includes("content.empty_main"));
  assert(codes(report).includes("content.family_empty"));
  assert.equal(report.findings.find((f) => f.code === "content.family_empty").affected_pages, 2);
  assert.doesNotMatch(JSON.stringify(report), /document\.write/);
});

test("P1-03 does not group unrelated root-level empty pages into one invented family (#463)", () => {
  const pages = ["/privacy", "/contact"].map((path) =>
    observeMainContent("<html lang=en><body><main></main></body></html>",
      "https://example.test" + path));
  const report = analyze(pages);
  assert.equal(report.empty_main_pages, 2);
  assert(codes(report).includes("content.empty_main"));
  assert(!codes(report).includes("content.family_empty"));
  assert.equal(report.families_compared, 0);
});

test("P1-03 detects long repeated unpunctuated paragraphs as boilerplate (#463)", () => {
  const paragraph = Array.from({ length: 115 }, (_, i) => "reusableintro" + i).join(" ");
  const pages = ["a", "b", "c"].map((id, index) =>
    mk(id, "<p>" + paragraph + "</p><p>" + unique(index, 15) + "</p>"));
  const report = analyze(pages);
  assert.equal(report.repeated_boilerplate_pages, 3);
  assert.equal(report.possible_low_value_pages, 3);
  assert(codes(report).includes("content.family_repeated_boilerplate"));
  assert(codes(report).includes("content.low_unique_value"));
  assert.doesNotMatch(JSON.stringify(report), /reusableintro50/);
});

test("P1-03 does not treat repeated root navigation or boilerplate within media as page evidence", () => {
  const paragraph = Array.from({ length: 115 }, (_, i) => "reusednav" + i).join(" ");
  const pages = ["a", "b", "c"].map((id) =>
    observeMainContent("<html lang=en><body><header><p>" + paragraph +
      "</p></header><main><p>" + Array.from({ length: 140 }, (_, i) =>
        "newpage" + id + "term" + i).join(" ") + "</p></main></body></html>",
      "https://example.test/products/" + id));
  const report = analyze(pages);
  assert.equal(report.total_findings, 0);
  assert.equal(report.repeated_boilerplate_pages, 0);
});

test("P1-03 reports short but nonempty static content only as potential review evidence", () => {
  const report = analyze([
    mk("a", "<p>Contact our customer support team today.</p>"),
    mk("b", "<p>Find store opening details and hours.</p>"),
    mk("c", "<p>Review shipping information and policies.</p>"),
  ]);
  assert.equal(report.short_main_pages, 3);
  assert(codes(report).includes("content.short_main"));
  assert(codes(report).includes("content.family_thin"));
  assert.equal(report.findings.find((f) => f.code === "content.short_main").confidence, "potential");
});

test("P1-03 does not flag substantial unique content or repeated navigation/footer", () => {
  const pages = ["a", "b", "c"].map((id) =>
    mk(id, "<h1>Useful information</h1><p>" + longWords + unique(id, 80) + "</p>"));
  const report = analyze(pages);
  assert.equal(report.total_findings, 0);
  assert.equal(report.repeated_boilerplate_pages, 0);
  assert.equal(report.possible_low_value_pages, 0);
});

test("P1-03 detects 110 shared words of main-text boilerplate with independent page details", () => {
  const pages = ["a", "b", "c"].map((id) =>
    mk(id, "<h1>Product details</h1><p>" + shared + "</p><p>" + unique(id) + "</p>"));
  const report = analyze(pages);
  assert.equal(report.families_compared, 1);
  assert.equal(report.repeated_boilerplate_pages, 3);
  assert.equal(report.possible_low_value_pages, 3);
  assert(codes(report).includes("content.family_repeated_boilerplate"));
  assert(codes(report).includes("content.low_unique_value"));
  assert.equal(report.findings.find((f) => f.code === "content.low_unique_value").confidence, "potential");
  assert.ok(!JSON.stringify(report).includes("shared0term0"));
});

test("P1-03 does not confuse the same boilerplate in unrelated URL families", () => {
  const pages = [
    mk("a", "<p>" + shared + "</p><p>" + unique("a") + "</p>"),
    observeMainContent(
      "<html lang=en><body><main><p>" + shared + "</p><p>" + unique("b") + "</p></main></body></html>",
      "https://example.test/articles/b",
    ),
  ];
  const report = analyze(pages);
  assert.equal(report.repeated_boilerplate_pages, 0);
  assert.equal(report.possible_low_value_pages, 0);
});

test("P1-03 never cross-compares multilingual content with different HTML languages", () => {
  const pages = [
    mk("english", "<p>" + shared + "</p><p>" + unique("en") + "</p>", "en-US"),
    mk("german", "<p>" + shared + "</p><p>" + unique("de") + "</p>", "de-DE"),
  ];
  const report = analyze(pages);
  assert.equal(report.families_compared, 0);
  assert.equal(report.repeated_boilerplate_pages, 0);
});

test("P1-03 leaves exact main-text duplication for P1-01 rather than duplicating it", () => {
  const body = "<p>" + shared + "</p>";
  const report = analyze([mk("a", body), mk("b", body)]);
  assert(!codes(report).includes("content.family_repeated_boilerplate"));
  assert(!codes(report).includes("content.low_unique_value"));
});

test("P1-03 treats unknown HTML language as missing evidence rather than inferring from path", () => {
  const report = analyze([
    mk("a", "<p>" + shared + "</p><p>" + unique("a") + "</p>", ""),
    mk("b", "<p>" + shared + "</p><p>" + unique("b") + "</p>", ""),
  ]);
  assert.equal(report.families_compared, 0);
  assert.equal(report.coverage_limited, true);
  assert(!codes(report).includes("content.family_repeated_boilerplate"));
});

test("P1-03 does not flag valid short body fallback as missing a main landmark or content", () => {
  const fallback = observeMainContent(
    "<html lang=en><body>Contact us by phone. We are happy to help.</body></html>",
    "https://example.test/about",
  );
  assert.equal(fallback.source, "body_fallback");
  const report = analyze([fallback]);
  assert.equal(report.empty_main_pages, 0);
  assert.equal(report.short_main_pages, 0);
});

test("P1-03 explicitly marks a script-only empty body as unverified rendered content", () => {
  const emptyBody = observeMainContent(
    "<html lang=en><body><script>window.secret='FAKE_PRIVATE'</script></body></html>",
    "https://example.test/products/client-rendered",
  );
  assert.equal(emptyBody.source, "body_fallback");
  const report = analyze([emptyBody]);
  assert.equal(report.empty_main_pages, 0);
  const finding = report.findings.find((f) => f.code === "content.no_static_body");
  assert.equal(finding?.confidence, "potential");
  assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE/);
});

test("P1-03 rejects unsafe labels, oversized text and duplicate URL observations without leaking secrets", () => {
  const report = analyze([
    mk("safe", "<p>" + longWords + "</p>"),
    { ...mk("again", "<p>" + longWords + "</p>"), url: "https://example.test/private?token=FAKE_PRIVATE" },
    { ...mk("oversized", ""), text: "secretwords".repeat(13000) },
    mk("safe", "<p>" + longWords + "</p>"),
  ]);
  assert.equal(report.eligible_pages, 1);
  assert.equal(report.skipped_pages, 3);
  assert.equal(report.coverage_limited, true);
  assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE|secretwords/);
});

test("P1-03 deterministic output is compact, with bounded example URL lists", () => {
  const pages = Array.from({ length: 8 }, (_, i) =>
    mk(String(i), "<p>" + shared + "</p><p>" + unique(i) + "</p>"));
  const report = analyze(pages);
  assert.deepEqual(report, analyze(pages));
  assert.equal(report.sampled_pages, 8);
  assert(report.findings.every((f) => f.example_urls.length <= 2));
  assert(Buffer.byteLength(JSON.stringify(report), "utf8") < 8_000);
});

test("P1-03 rejects more than eight pages and inconsistent sample counts", () => {
  const pages = Array.from({ length: 9 }, (_, i) => mk(String(i), "<p>" + longWords + "</p>"));
  assert.throws(() => analyze(pages), /at most eight/);
  assert.throws(() => analyze(pages.slice(0, 1), { sampledPages: 0 }), /sampledPages/);
});
