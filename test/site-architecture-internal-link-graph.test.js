import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeInternalLinkGraph, emptyInternalLinkGraphReview,
  extractGraphLinks, graphLiveTargets,
  MAX_GRAPH_PAGES, MAX_GRAPH_HTML_BYTES, MAX_GRAPH_LINKS_PER_PAGE,
  MAX_GRAPH_TOTAL_HTML_BYTES, MAX_GRAPH_CATALOG_URLS,
} from "../dist/modules/site-architecture/internal-link-graph.js";

const site = "https://example.com/";
const u = (path) => new URL(path, site).href;
const a = (path, extra = "") => '<a href="' + path + '" ' + extra + '>Link</a>';
const html = (body, head = "") => "<html><head>" + head + "</head><body>" + body + "</body></html>";
const page = (path, body, extra = {}) => ({
  url: u(path), html: html(body), status_code: 200, ...extra,
});
const analyze = (pages, rest = {}) =>
  analyzeInternalLinkGraph({ site_url: site, pages, ...rest });
const codes = (r) => r.findings.map((finding) => finding.code);

test("V06: navigation and contextual anchors yield shortest observed BFS depth; no false full-site orphan verdict", () => {
  const r = analyze([
    page("/", "<nav>" + a("/a") + a("/b") + "</nav>"),
    page("/a", a("/c")),
    page("/b", a("/c")),
    page("/c", a("/d")),
    page("/d", "<h1>Final</h1>"),
    page("/lonely", "<h1>Lonely</h1>"),
  ], { sitemap_urls: [site, u("/a"), u("/b"), u("/c"), u("/d"), u("/lonely"), u("/catalog-only")] });
  assert.deepEqual(r.pages.map((p) => p.depth_from_entry), [0, 1, 1, 2, 3, null]);
  assert.equal(r.deepest_observed_sample_depth, 3);
  assert.equal(r.deep_pages_at_three_or_more, 1);
  assert.equal(r.pages_reachable_within_sample, 5);
  assert.equal(r.pages_unreachable_within_sample, 1);
  assert.equal(r.unique_observed_sample_edges, 5);
  assert.equal(r.potential_orphans_within_sample, 1);
  assert.equal(r.sitemap_urls_without_page_sample, 1);
  assert.equal(r.pages[5].potential_orphan_in_sample, true);
  assert(codes(r).includes("possible_orphan_in_sample"));
  assert(codes(r).includes("sampled_deep_page"));
  assert.equal(r.coverage_limited, true);
  assert(!JSON.stringify(r).includes("/lonely"));
  assert(!JSON.stringify(r).includes("catalog-only"));
});

test("V06: nofollow-only edges remain visible but do not establish confident path", () => {
  const r = analyze([
    page("/", a("/destination", 'rel="ugc nofollow"')),
    page("/destination", "<h1>Destination</h1>"),
  ]);
  assert.equal(r.pages[1].incoming_sampled_sources, 1);
  assert.equal(r.pages[1].potential_orphan_in_sample, false);
  assert.equal(r.pages[1].depth_from_entry, null);
  assert.equal(r.nofollow_internal_links, 1);
  assert(codes(r).includes("nofollow_only_path"));
});

test("V06: confirmed sampled status/robots/noindex/canonical problems are distinct and redacted", () => {
  const r = analyze([
    page("/", a("/bad") + a("/blocked") + a("/noindex") + a("/noncanon")),
    { url: u("/bad"), status_code: 404 },
    { url: u("/blocked"), status_code: 200, robots_allowed: false },
    page("/noindex", "<h1>Noindex</h1>", { noindex: true }),
    page("/noncanon", "<h1>Canonical elsewhere</h1>", { canonical_url: u("/good") }),
  ]);
  assert.equal(r.linked_http_error_pages, 1);
  assert.equal(r.linked_robots_blocked_pages, 1);
  assert.equal(r.linked_declared_noindex_pages, 1);
  assert.equal(r.linked_noncanonical_pages, 1);
  assert.equal(r.pages[1].depth_from_entry, null);
  assert.equal(r.pages[2].depth_from_entry, null);
  assert.equal(r.pages[3].depth_from_entry, 1);
  assert.equal(r.pages[4].depth_from_entry, 1);
  assert(codes(r).includes("linked_to_http_error"));
  assert(codes(r).includes("linked_to_robots_blocked"));
  assert(codes(r).includes("linked_to_noindex"));
  assert(codes(r).includes("linked_to_noncanonical"));
  assert(!JSON.stringify(r).includes("https://example.com/good"));
});

test("V06: no entry page supplied produces unknown depths, not invented roots", () => {
  const r = analyze([page("/a", a("/b")), page("/b", "<h1>B</h1>")]);
  assert.equal(r.entry_pages_missing, 1);
  assert.equal(r.entry_pages_observed, 0);
  assert.deepEqual(r.pages.map((p) => p.depth_from_entry), [null, null]);
  assert(codes(r).includes("entry_not_sampled"));
  assert.equal(r.potential_orphans_within_sample, 1);
});

test("V06: explicit multiple roots reach separate components conservatively", () => {
  const r = analyze([
    page("/a", a("/b")), page("/b", "<h1>End</h1>"),
    page("/c", "<h1>Other</h1>"),
  ], { entry_urls: [u("/a"), u("/c")] });
  assert.deepEqual(r.pages.map((p) => p.depth_from_entry), [0, 1, 0]);
  assert.equal(r.potential_orphans_within_sample, 0);
  assert.equal(r.entry_pages_missing, 0);
});

test("V06: skips fragments, query variants, foreign links and dangerous URL schemes", () => {
  const source = html(
    a("#part") + a("/a?session=SECRET") + a("https://elsewhere.net/private")
    + a("javascript:alert(1)") + a("mailto:someone@example.com")
    + a("/a#fragment") + a("/a") + a("/") + a("/a", 'rel="nofollow"'),
  );
  const r = analyze([
    { url: site, html: source },
    page("/a", "<h1>Destination</h1>"),
  ]);
  assert.equal(r.pages[0].fragment_links, 1);
  assert.equal(r.pages[0].query_links_excluded, 1);
  assert.equal(r.pages[0].external_links, 1);
  assert.equal(r.pages[0].unsafe_links_excluded, 2);
  assert.equal(r.pages[0].internal_links, 4);
  assert.equal(r.pages[0].self_links, 1);
  assert.equal(r.pages[0].nofollow_internal, 1);
  assert.equal(r.unique_observed_sample_edges, 1);
  assert.equal(r.pages[1].depth_from_entry, 1);
  assert(!JSON.stringify(r).includes("SECRET"));
  assert(!JSON.stringify(r).includes("elsewhere.net"));
});

test("V06: invalid/foreign base prevents unsafe relative resolution", () => {
  const source = html(a("/a") + a("https://example.com/b"),
    '<base href="https://foreign.example.net/path/">');
  const edges = extractGraphLinks(source, site);
  assert.equal(edges.ignoredBase, true);
  assert.equal(edges.unsafe, 1);
  assert.equal(edges.edges.length, 1);
  assert.equal(edges.edges[0].to, u("/b"));
  assert.deepEqual(graphLiveTargets(source, site), [u("/b")]);
  const observed = analyze([{ url: site, html: source }]);
  assert(codes(observed).includes("external_base_ignored"));
  assert(!JSON.stringify(observed).includes("foreign.example.net"));
});

test("V06: uninspected, blocked and HTTP-error records are not misclassified as orphan content", () => {
  const r = analyze([
    page("/", "<h1>Entry</h1>"),
    { url: u("/uninspected") },
    { url: u("/blocked"), status_code: 200, robots_allowed: false },
    { url: u("/error"), status_code: 404 },
    { url: u("/partial"), status_code: 206,
      html: html("Partial bodies cannot establish complete link evidence") },
  ]);
  assert.equal(r.potential_orphans_within_sample, 0);
  assert.equal(r.pages[4].html_examined, false);
  assert.equal(r.pages[4].depth_from_entry, null);
  assert.equal(r.pages_unreachable_within_sample, 4);
});

test("V06: properly same-origin base resolves relative edges", () => {
  const source = html(a("article"), '<base href="https://example.com/category/">');
  const targets = graphLiveTargets(source, site);
  assert.deepEqual(targets, [u("/category/article")]);
});

test("V06: static robots noindex and canonical parsing do not prove Google decision", () => {
  const r = analyze([
    page("/", a("/target")),
    page("/target", "Hi", {
      html: html("Hi",
        '<meta name="googlebot" content="noindex"><link rel="canonical" href="/preferred">'),
    }),
  ]);
  assert.equal(r.pages[1].noindex_state, "declared");
  assert.equal(r.pages[1].canonical_state, "different");
  assert.equal(r.linked_declared_noindex_pages, 1);
  assert.equal(r.linked_noncanonical_pages, 1);
  assert.equal(r.coverage_limited, true);
});

test("V06: bounded HTML pages, catalogs and duplicate URLs fail closed", () => {
  const good = [page("/", "<h1>Home</h1>")];
  for (const args of [
    { pages: [] },
    { pages: [good[0], good[0]] },
    { pages: Array.from({ length: MAX_GRAPH_PAGES + 1 }, (_, i) => page("/" + i, "")) },
    { pages: [{ ...good[0], html: "ü".repeat(Math.ceil(MAX_GRAPH_HTML_BYTES / 2) + 1) }] },
    { pages: [{ ...good[0], html: "x".repeat(MAX_GRAPH_HTML_BYTES) },
      { ...good[0], url: u("/b"), html: "x".repeat(MAX_GRAPH_HTML_BYTES) },
      { ...good[0], url: u("/c"), html: "x".repeat(MAX_GRAPH_HTML_BYTES) }] },
    { pages: good, sitemap_urls: Array.from({ length: MAX_GRAPH_CATALOG_URLS + 1 },
      (_, i) => u("/" + i)) },
    { pages: good, entry_urls: ["http://localhost/"] },
    { pages: [{ ...good[0], status_code: 600 }] },
    { pages: [{ ...good[0], robots_allowed: "false" }] },
    { pages: [{ ...good[0], canonical_url: "javascript:alert(1)" }] },
    { pages: [{ ...good[0], url: u("/?secret=hidden") }] },
  ]) {
    assert.throws(() => analyzeInternalLinkGraph({ site_url: site, ...args }));
  }
  assert.equal(emptyInternalLinkGraphReview().coverage_limited, true);
});

test("V06: 240 links cap, duplicate targets and unsampled URLs are bounded without false 404", () => {
  const source = html(Array.from({ length: MAX_GRAPH_LINKS_PER_PAGE + 10 },
    (_, i) => a("/unobserved" + (i % 2))).join(""));
  const r = analyze([{ url: site, html: source }]);
  assert.equal(r.pages[0].links_observed, MAX_GRAPH_LINKS_PER_PAGE);
  assert.equal(r.pages[0].unobserved_internal_targets, 2);
  assert.equal(r.distinct_unsampled_link_targets, 2);
  assert.equal(r.pages_with_truncated_links, 1);
  assert(codes(r).includes("link_sample_truncated"));
  assert(!codes(r).includes("linked_to_http_error"));
});

test("V06: status and robots missing evidence remain unknown, empty HTML not clean crawl proof", () => {
  const r = analyze([{ url: site, html: "" }, { url: u("/a") }]);
  assert.equal(r.html_pages_examined, 1);
  assert.equal(r.status_unknown_pages, 2);
  assert.equal(r.robots_unknown_pages, 2);
  assert.equal(r.pages[1].noindex_state, "unknown");
  assert.equal(r.pages[1].html_examined, false);
  assert.equal(r.pages[1].depth_from_entry, null);
});
