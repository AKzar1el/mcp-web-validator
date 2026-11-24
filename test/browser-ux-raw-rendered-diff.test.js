import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRawRendered, emptyRawRenderedReview,
  MAX_RENDER_HTML_BYTES, MAX_RENDER_FINDINGS, MAX_RENDER_LINKS, MAX_RENDER_WORDS,
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

test("V07: changing the document base changes relative canonical identity", () => {
  const page = (base) => html('<base href="' + base + '"><link rel="canonical" href="article">', content);
  const r = inspect(page("/private-first/"), page("/private-second/"));
  assert.equal(r.raw.canonicals, "different");
  assert.equal(r.rendered.canonicals, "different");
  assert.equal(r.canonical_changed, true);
  assert(codes(r).includes("canonical_changed"));
  assert(!JSON.stringify(r).includes("private-first"));
  assert(!JSON.stringify(r).includes("private-second"));
  assert.equal(inspect(page("/private-first/"), page("/private-first/")).canonical_changed, false);
});

test("V07: first safe document base determines canonical self identity", () => {
  const raw = html('<base href="/"><base href="/ignored/">'
    + '<link rel="canonical" href="articles/story">', content);
  const rendered = html('<link rel="canonical" href="https://example.com/articles/story">', content);
  const r = inspect(raw, rendered, { page_url: site + "articles/story" });
  assert.equal(r.raw.canonicals, "self");
  assert.equal(r.rendered.canonicals, "self");
  assert.equal(r.canonical_changed, false);
});

test("V07: cross-origin bases resolve canonicals without exposing targets", () => {
  const raw = html('<base href="https://outside.example/private/">'
    + '<link rel="canonical" href="story">', content);
  const rendered = html('<link rel="canonical" href="https://outside.example/private/story">', content);
  const r = inspect(raw, rendered);
  assert.equal(r.raw.canonicals, "different");
  assert.equal(r.canonical_changed, false);
  assert(!JSON.stringify(r).includes("outside.example"));
});

test("V07: unsafe document bases cannot fabricate resolved relative canonicals", () => {
  const base = '<base href="https://user:PRIVATE_PASSWORD@example.com/">';
  const raw = html(base + '<link rel="canonical" href="/">', content);
  const r = inspect(raw, raw);
  assert.equal(r.raw.canonicals, "ambiguous");
  assert.equal(r.canonical_changed, false);
  assert(!JSON.stringify(r).includes("PRIVATE_PASSWORD"));
  const absolute = html(base + '<link rel="canonical" href="https://example.com/">', content);
  assert.equal(inspect(absolute, absolute).raw.canonicals, "self");
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

test("V07: JSON-LD MIME parameters do not fabricate rendered removal", () => {
  const payload = '{"@type":"Article","private":"DO_NOT_REPORT"}';
  const raw = html(meta + '<script type="application/ld+json">' + payload + '</script>', content);
  for (const type of [
    "application/ld+json; charset=UTF-8",
    ' APPLICATION/LD+JSON ; profile="https://example.org/schema" ',
  ]) {
    const rendered = html(meta + '<script type="' + type + '">' + payload + '</script>', content);
    const r = inspect(raw, rendered);
    assert.equal(r.raw.jsonld_blocks, 1);
    assert.equal(r.rendered.jsonld_blocks, 1, type);
    assert.equal(r.rendered.inline_script_tags, 0, type);
    assert(!codes(r).includes("jsonld_removed"), type);
    assert(!JSON.stringify(r).includes("DO_NOT_REPORT"));
  }
});

test("V07: parameterized application/json is not classified as an inline script", () => {
  for (const type of [
    "application/json;charset=utf-8",
    " APPLICATION/JSON ; profile=test ",
  ]) {
    const page = html(meta + '<script type="' + type + '">{"private":"DO_NOT_REPORT"}</script>', content);
    const r = inspect(page, page);
    assert.equal(r.raw.jsonld_blocks, 0, type);
    assert.equal(r.raw.inline_script_tags, 0, type);
    assert.equal(r.rendered.inline_script_tags, 0, type);
    assert(!JSON.stringify(r).includes("DO_NOT_REPORT"));
  }
  const nearMiss = html(meta + '<script type="application/ld+jsonish; charset=utf-8">{}</script>', content);
  assert.equal(inspect(nearMiss, nearMiss).raw.jsonld_blocks, 0);
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

test("V07: link sample caps distinguish exact coverage from unproven removal", () => {
  const links = Array.from({ length: MAX_RENDER_LINKS + 1 }, (_, i) => i);
  const page = (ids) => html("", "<main>" + ids.map(
    (id) => '<a href="/private-link-' + id + '">x</a>').join("") + "</main>");
  const exact = page(links.slice(0, MAX_RENDER_LINKS));
  assert.equal(inspect(exact, exact).raw.sample_truncated, false);
  const full = page(links);
  const rotated = page(links.slice(1).concat(links[0]));
  const report = inspect(full, rotated);
  assert.equal(report.raw.sample_truncated, true);
  assert.equal(report.rendered.sample_truncated, true);
  assert.equal(report.link_targets_removed, 1);
  assert.equal(report.link_targets_added, 1);
  assert(codes(report).includes("snapshot_coverage_limited"));
  assert(!codes(report).includes("links_removed"));
  assert(!codes(report).includes("links_added"));
  assert(!JSON.stringify(report).includes("private-link-"));
});

test("V07: link findings require complete evidence on the side claiming absence", () => {
  const many = html("", "<main>" + Array.from({ length: MAX_RENDER_LINKS + 1 },
    (_, i) => '<a href="/link-' + i + '">x</a>').join("") + "</main>");
  const few = html("", '<main><a href="/distinct">x</a></main>');
  const dropped = inspect(many, few);
  assert(codes(dropped).includes("links_removed"));
  assert(!codes(dropped).includes("links_added"));
  const added = inspect(few, many);
  assert(!codes(added).includes("links_removed"));
  assert(codes(added).includes("links_added"));
  const unsafe = html('<base href="https://outside.example/">', '<main><a href="relative">x</a></main>');
  const limited = inspect(few, unsafe);
  assert(limited.rendered.sample_truncated);
  assert(!codes(limited).includes("links_removed"));
});

test("V07: eligible word cap marks truncated samples and avoids false content changes", () => {
  const words = Array.from({ length: MAX_RENDER_WORDS + 20 }, (_, i) => "word" + i);
  const page = (tokens, href = "/same") => html("", "<main>" + tokens.join(" ")
    + '<a href="' + href + '">x</a></main>');
  const exact = page(words.slice(0, MAX_RENDER_WORDS));
  assert.equal(inspect(exact, exact).raw.sample_truncated, false);
  const over = page(words.slice(0, MAX_RENDER_WORDS + 1));
  const boundary = inspect(over, over);
  assert.equal(boundary.raw.main_words, MAX_RENDER_WORDS);
  assert.equal(boundary.raw.sample_truncated, true);
  const report = inspect(page(words), page(words.slice(20).concat(words.slice(0, 20)), "/new"));
  assert.equal(report.main_words_removed, 20);
  assert.equal(report.main_words_added, 20);
  assert(codes(report).includes("snapshot_coverage_limited"));
  assert(!codes(report).includes("main_text_changed"));
  assert(codes(report).includes("links_removed"));
  assert(codes(report).includes("links_added"));
  assert(!JSON.stringify(report).includes("word10019"));
  assert(codes(inspect(page(words), page(["short", "text"]))).includes("main_text_dropped"));
  assert(codes(inspect(page(["short", "text"]), page(words))).includes("main_text_added"));
});

test("V07: incomplete links do not suppress proven complete-text changes", () => {
  const links = Array.from({ length: MAX_RENDER_LINKS + 1 },
    (_, i) => '<a href="/link-' + i + '">x</a>').join("");
  const words = Array.from({ length: 40 }, (_, i) => "old" + i).join(" ");
  const r = inspect(html("", "<main>" + words + links + "</main>"),
    html("", "<main>short text" + links + "</main>"));
  assert(codes(r).includes("snapshot_coverage_limited"));
  assert(codes(r).includes("main_text_dropped"));
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
