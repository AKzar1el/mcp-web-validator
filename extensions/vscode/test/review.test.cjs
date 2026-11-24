const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewDocument } = require("../dist/review.cjs");

const doc = (head = "", body = "") => "<!doctype html><html><head><title>Docs</title>" + head + "</head><body>" + body + "</body></html>";
const codes = (html, url) => reviewDocument(html, url).map(x => x.code);
test("clean static document", () => assert.deepEqual(codes(doc()), []));
test("duplicate canonical is an observation without a URL", () => {
  const r = reviewDocument(doc('<link rel="canonical" href="/a"><link rel="canonical" href="https://site.example/a">'));
  assert.ok(r.some(x => x.code === "multiple_canonicals" && x.severity === "info"));
  assert.ok(!r.some(x => x.code === "conflicting_declaration" && x.field === "canonical"));
});
test("canonical conflict with explicit page URL", () => assert.ok(codes(doc('<link rel="canonical" href="/a"><link rel="canonical" href="/b">'), "https://site.example/a").includes("conflicting_declaration")));
test("equivalent relative and absolute canonical", () => assert.ok(codes(doc('<link rel="canonical" href="/a"><link rel="canonical" href="https://site.example/a">'), "https://site.example/a").includes("duplicate_declaration")));
test("empty canonical", () => assert.ok(codes(doc('<link rel="canonical" href="">'), "https://site.example/a").includes("unresolved_canonical")));
test("relative URL social comparison requires a page URL", () => {
  const html = doc('<link rel="canonical" href="/a"><meta property="og:url" content="https://site.example/b">');
  assert.ok(!codes(html).includes("canonical_social_url_difference"));
  assert.ok(codes(html, "https://site.example/a").includes("canonical_social_url_difference"));
});
test("noindex is an informational observation, not an automatic SEO error", () => {
  const r = reviewDocument(doc('<meta name="robots" content="noindex, follow">'));
  assert.ok(r.some(x => x.code === "declared_noindex" && x.severity === "info"));
});
test("none and Googlebot noindex", () => assert.ok(codes(doc('<meta name="googlebot" content="none">')).includes("declared_noindex")));
test("conflicting robots directives", () => assert.ok(codes(doc('<meta name="robots" content="index, noindex">')).includes("conflicting_robots_directives")));
test("duplicate metadata", () => assert.ok(codes(doc('<meta name="description" content="A"><meta name="description" content="B">')).includes("conflicting_declaration")));
test("malformed JSON-LD", () => assert.ok(codes(doc('<script type="application/ld+json">{broken</script>')).includes("invalid_json")));
test("JSON-LD in template is inert", () => assert.ok(!codes(doc("", '<template><script type="application/ld+json">{broken</script></template>')).includes("invalid_json")));
test("HTML parser diagnostics have real source coordinates", () => {
  const r = reviewDocument(doc("", '<div id="a" id="b"></div>'));
  assert.ok(r.some(x => x.code === "html_duplicate-attribute" && Number.isInteger(x.start) && x.start >= 0));
});
test("fragment does not produce missing-doctype warning", () => assert.ok(!codes("<div>Example</div>").includes("html_missing-doctype")));
test("invalid configured URL is reported rather than used", () => assert.ok(codes(doc(), "file:///private").includes("invalid_page_url")));
test("byte limit is enforced before parsing", () => assert.deepEqual(codes("x".repeat(180001)), ["input_limit"]));
test("comments do not create metadata observations", () => assert.deepEqual(codes(doc('<!-- <meta name="robots" content="noindex"> -->')), []));
