import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRawRendered, emptyRawRenderedReview,
  MAX_RENDER_HTML_BYTES, MAX_RENDER_FINDINGS,
} from "../dist/modules/browser-ux/raw-rendered-diff.js";
import {
  renderInlineHtml, reviewPublicInlineDom,
} from "../dist/modules/browser-ux/raw-rendered-probe.js";

const site = "https://example.com/";
const html = (head, body) =>
  "<!doctype html><html><head>" + head + "</head><body>" + body + "</body></html>";
const meta = '<title>Original</title><meta name="description" content="Original description">'
  + '<link rel="canonical" href="https://example.com/">';
const content = '<main><h1>Original Heading</h1><p>'
  + "A meaningful sample contains many descriptive words and enough stable text "
  + "to establish a baseline for comparing source and browser output across samples. "
  + "This is sample content only, not a real indexing determination.</p>"
  + '<a href="/source-link">Source</a></main>';
const source = html(meta, content);
const inspect = (raw_html, rendered_html, extra = {}) => analyzeRawRendered({
  page_url: site, raw_html, rendered_html, ...extra,
});
const codes = (r) => r.findings.map((f) => f.code);

test("V07: unchanged raw and rendered snapshots produce no inflated SEO findings", () => {
  const r = inspect(source, source);
  assert.equal(r.scope, "caller_supplied_rendered_snapshot");
  assert.equal(r.browser_executed, false);
  assert.equal(r.raw.title_present, true);
  assert.equal(r.raw.canonicals, "self");
  assert.equal(r.rendered.canonicals, "self");
  assert.equal(r.title_changed, false);
  assert.equal(r.noindex_changed, false);
  assert.equal(r.main_words_removed, 0);
  assert.equal(r.link_targets_removed, 0);
  assert.equal(r.total_findings, 0);
  assert.equal(r.coverage_limited, true);
  assert(!JSON.stringify(r).includes("Original Heading"));
  assert(!JSON.stringify(r).includes("/source-link"));
});

test("V07: dropped source title/heading/content/links/canonical are distinct warnings", () => {
  const rendered = html('<meta name="robots" content="noindex">'
    + '<link rel="canonical" href="/different">', '<main><p>Gone.</p></main>');
  const r = inspect(source, rendered);
  assert.equal(r.raw.noindex_declared, false);
  assert.equal(r.rendered.noindex_declared, true);
  assert.equal(r.title_changed, true);
  assert.equal(r.h1_changed, true);
  assert.equal(r.canonical_changed, true);
  assert.equal(r.link_targets_removed, 1);
  assert(codes(r).includes("title_removed"));
  assert(codes(r).includes("description_removed"));
  assert(codes(r).includes("h1_removed"));
  assert(codes(r).includes("main_text_dropped"));
  assert(codes(r).includes("links_removed"));
  assert(codes(r).includes("noindex_added"));
  assert(codes(r).includes("canonical_changed"));
  assert(!JSON.stringify(r).includes("/different"));
});

test("V07: JavaScript-only added main text, title, links and JSON-LD produce review leads", () => {
  const raw = html("", "<main><div id='app'></div></main>");
  const rendered = html('<title>Dynamic</title><meta name="description" content="Dynamic">'
    + '<script type="application/ld+json">{"@type":"Article","secret":"HIDDEN"}</script>',
    "<main><h1>Dynamic</h1><p>" +
    "A fully rendered page shows meaningful article content with useful details "
    + "for readers and crawlers that are absent from the raw page shell. "
    + "All of this content arrived after JavaScript execution, not on the original document." +
    '</p><a href="/rendered-only">Dynamic</a></main>');
  const r = inspect(raw, rendered);
  assert.equal(r.link_targets_added, 1);
  assert(codes(r).includes("title_added"));
  assert(codes(r).includes("description_added"));
  assert(codes(r).includes("h1_added"));
  assert(codes(r).includes("main_text_added"));
  assert(codes(r).includes("links_added"));
  assert(codes(r).includes("jsonld_added"));
  assert(!JSON.stringify(r).includes("HIDDEN"));
  assert(!JSON.stringify(r).includes("/rendered-only"));
});

test("V07: query-bearing URLs and external links are counted but never exposed or merged", () => {
  const raw = html("<title>Safe</title>", "<main>"
    + '<a href="/articles?secret=private-key">Query</a>'
    + '<a href="https://outside.example.net/path">External</a>'
    + '<a href="/clean">Clean</a></main>');
  const r = inspect(raw, raw);
  assert.equal(r.raw.query_links_excluded, 1);
  assert.equal(r.raw.external_link_targets, 1);
  assert.equal(r.raw.same_origin_link_targets, 1);
  assert.equal(r.link_targets_removed, 0);
  assert(!JSON.stringify(r).includes("private-key"));
  assert(!JSON.stringify(r).includes("outside.example.net"));
});

test("V07: invalid, oversized and hostile inputs are rejected before browser launch", async () => {
  for (const item of [
    { raw_html: "", rendered_html: source },
    { raw_html: source, rendered_html: "" },
    { raw_html: "ü".repeat(MAX_RENDER_HTML_BYTES), rendered_html: source },
    { raw_html: source, rendered_html: "x".repeat(MAX_RENDER_HTML_BYTES + 1) },
    { raw_html: source, rendered_html: source, page_url: "file:///etc/passwd" },
    { raw_html: source, rendered_html: source, page_url: site + "?token=secret" },
  ]) assert.throws(() => inspect(item.raw_html, item.rendered_html, item));
  let launched = 0;
  const dummy = { async launch() { launched++; throw new Error("unexpected"); } };
  await assert.rejects(renderInlineHtml("x".repeat(MAX_RENDER_HTML_BYTES + 1),
    site, dummy), /limit/);
  await assert.rejects(renderInlineHtml(source,
    "file:///etc/passwd", dummy), /safe public/);
  assert.equal(launched, 0);
  assert.equal(emptyRawRenderedReview().coverage_limited, true);
});

test("V07: explicit fixed messages and finding cap prevent leaking source or browser errors", () => {
  const report = inspect(source, html("", "<main>Gone</main>"), {
    page_url: site,
  });
  assert(report.findings.length <= MAX_RENDER_FINDINGS);
  assert(report.findings.every((item) =>
    typeof item.code === "string" && !item.message.includes("Original")));
  const error = inspect(source, source);
  assert.equal(error.script_errors_observed, 0);
});

test("V07: injected browser runtime honors offline/JS/interception and closes on success", async () => {
  const events = [];
  const fakePage = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async setViewport() { events.push("viewport"); },
    async setJavaScriptEnabled(v) { events.push("script:" + v); },
    async setOfflineMode(v) { events.push("offline:" + v); },
    async setRequestInterception(v) { events.push("intercept:" + v); },
    on(name) { events.push("event:" + name); },
    async setContent(markup) {
      events.push("content");
      assert(!markup.includes('src="https://evil.example.net/x.js"'));
      assert(!markup.includes("<iframe"));
    },
    async content() { return html('<title>Changed</title>', '<main><h1>New</h1></main>'); },
  };
  let closed = 0, launchProxy = "";
  const runtime = {
    async launch(proxy) {
      launchProxy = proxy;
      return { newPage: async () => fakePage, async close() { closed++; } };
    },
  };
  const r = await renderInlineHtml(
    source + '<script src="https://evil.example.net/x.js"></script><iframe src="https://evil.example.net/"></iframe>',
    site, runtime,
  );
  assert.equal(r.browser_executed, true);
  assert.equal(r.inline_scripts_attempted, true);
  assert.equal(launchProxy, "http://127.0.0.1:9");
  assert(events.includes("script:true"));
  assert(events.includes("offline:true"));
  assert(events.includes("intercept:true"));
  assert.equal(closed, 1);
  assert(codes(r).includes("external_scripts_blocked"));
  assert(!JSON.stringify(r).includes("evil.example.net"));
});

test("V07: rejects unsafe live URL before network or browser", async () => {
  await assert.rejects(reviewPublicInlineDom("http://localhost/"), /not public|safe public/);
  await assert.rejects(reviewPublicInlineDom("https://example.com/?secret=hidden"), /safe public/);
});
