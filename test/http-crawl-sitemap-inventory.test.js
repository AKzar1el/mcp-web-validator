import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readBoundedGzipSitemap } from "../dist/modules/http-crawl/sitemap-inventory-probe.js";
import {
  analyzeSitemapInventory, emptySitemapInventoryReview, sitemapIndexChildUrls,
  sitemapFromRobotsTxt,
  MAX_SITEMAP_DOCUMENTS, MAX_SITEMAP_DOCUMENT_BYTES,
} from "../dist/modules/http-crawl/sitemap-inventory.js";

const site_url = "https://example.com/";
const ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
const urlset = (...items) => '<urlset xmlns="' + ns + '">' + items.join("") + "</urlset>";
const index = (...items) => '<sitemapindex xmlns="' + ns + '">' + items.join("") + "</sitemapindex>";
const loc = (path, lastmod = undefined) =>
  "<url><loc>" + path + "</loc>" + (lastmod === undefined ? "" :
    "<lastmod>" + lastmod + "</lastmod>") + "</url>";
const child = (path, lastmod = undefined) =>
  "<sitemap><loc>" + path + "</loc>" + (lastmod === undefined ? "" :
    "<lastmod>" + lastmod + "</lastmod>") + "</sitemap>";
const doc = (path, content, extra = {}) => ({
  sitemap_url: new URL(path, site_url).href, content, ...extra,
});
const analyze = (input) => analyzeSitemapInventory({
  site_url, observed_at: "2026-11-20T10:00:00Z", ...input,
});
const codes = (r) => r.findings.map((finding) => finding.code);

test("V05: bounded gzip sitemaps decode and reject inflated zip bombs", async () => {
  const content = urlset(loc(site_url + "a"));
  const compressed = gzipSync(Buffer.from(content, "utf8"));
  assert.equal(await readBoundedGzipSitemap(new Response(compressed)), content);
  const bomb = gzipSync(Buffer.alloc(MAX_SITEMAP_DOCUMENT_BYTES + 10, 65));
  await assert.rejects(readBoundedGzipSitemap(new Response(bomb)));
});

test("V05: robots Sitemap discovery only accepts absolute query-free same-origin labels", () => {
  const result = sitemapFromRobotsTxt(site_url,
    "Sitemap: https://outside.example.net/private.xml\n"
      + "Sitemap: https://example.com/sitemap-index.xml\n"
      + "Sitemap: https://example.com/?secret=hidden");
  assert.equal(result, site_url + "sitemap-index.xml");
  assert.equal(sitemapFromRobotsTxt(site_url, "Sitemap: http://localhost/a.xml"), undefined);
  assert.equal(sitemapFromRobotsTxt(site_url, "Sitemap: https://example.com/a?token=hidden"), undefined);
});

test("V05: robots Sitemap discovery accepts an inline comment after the URL", () => {
  const robots = [
    "Sitemap: https://outside.example.net/other.xml # not this host",
    "Sitemap: https://example.com/sitemap.xml # primary inventory",
  ].join("\n");
  assert.equal(sitemapFromRobotsTxt(site_url, robots), site_url + "sitemap.xml");
  assert.equal(sitemapFromRobotsTxt(site_url, "Sitemap: https://example.com/sitemap.xml\t# comment"), site_url + "sitemap.xml");
  assert.equal(sitemapFromRobotsTxt(site_url, "Sitemap: https://example.com/sitemap.xml?token=secret # ignored"), undefined);
});

test("V05: complete supplied index+child, unique URLs and 100% independent discovery coverage", () => {
  const r = analyze({
    documents_complete: true, discovered_complete: true,
    documents: [
      doc("/sitemap.xml", index(child(site_url + "sitemap-posts.xml", "2026-11-18"))),
      doc("/sitemap-posts.xml", urlset(
        loc(site_url + "a", "2026-11-18T09:00:00Z"),
        loc(site_url + "b", "2026-11-19"),
      )),
    ],
    discovered_urls: [site_url + "a", site_url + "b"],
    page_observations: [
      { url: site_url + "a", status_code: 200, noindex: false, robots_allowed: true,
        canonical_url: site_url + "a" },
    ],
  });
  assert.equal(r.documents_observed, 2);
  assert.equal(r.distinct_sitemap_urls, 2);
  assert.equal(r.distinct_child_sitemaps, 1);
  assert.equal(r.distinct_page_urls, 2);
  assert.equal(r.inventory_complete, true);
  assert.equal(r.discovered_in_sitemaps, 2);
  assert.equal(r.discovered_missing_from_sitemaps, 0);
  assert.equal(r.missing_child_documents, 0);
  assert.equal(r.page_observations, 1);
  assert.equal(r.sitemap_urls_with_page_evidence, 1);
  assert.equal(r.known_indexability_conflicts, 0);
  assert.equal(r.coverage_limited, true);
  assert.equal(r.total_findings, 0);
  assert(!JSON.stringify(r).includes(site_url));
});

test("V05: incomplete sitemap-index collection reports unfetched child and never asserts full coverage", () => {
  const r = analyze({
    documents_complete: true,
    documents: [doc("/sitemap.xml", index(
      child(site_url + "a.xml"),
      child(site_url + "b.xml"),
    ))],
  });
  assert.equal(r.missing_child_documents, 2);
  assert.equal(r.distinct_child_sitemaps, 2);
  assert.equal(r.inventory_complete, false);
  assert.equal(r.documents_complete, true);
  assert(codes(r).includes("sitemap_child_missing"));
  assert(codes(r).includes("unverified_coverage"));
  assert.deepEqual(sitemapIndexChildUrls({
    site_url,
    documents: [doc("/sitemap.xml", index(child(site_url + "a.xml")))],
  }), [site_url + "a.xml"]);
});

test("V05: sitemap page 301, 404, noindex, disallow and non-self canonical are distinct conflicts", () => {
  const r = analyze({
    documents: [doc("/sitemap.xml", urlset(
      loc(site_url + "a"), loc(site_url + "b"), loc(site_url + "c"),
    ))],
    page_observations: [
      { url: site_url + "a", status_code: 301, canonical_url: site_url + "b",
        noindex: true, robots_allowed: false },
      { url: site_url + "b", status_code: 404, noindex: false, robots_allowed: true,
        canonical_url: site_url + "b" },
      { url: site_url + "c", status_code: 200, noindex: false, robots_allowed: true,
        canonical_url: site_url + "c" },
    ],
  });
  assert.equal(r.status_conflicts, 2);
  assert.equal(r.noindex_conflicts, 1);
  assert.equal(r.robots_conflicts, 1);
  assert.equal(r.canonical_conflicts, 1);
  assert.equal(r.known_indexability_conflicts, 2);
  assert(codes(r).includes("sitemap_url_redirect"));
  assert(codes(r).includes("sitemap_url_http_error"));
  assert(codes(r).includes("sitemap_url_noindex"));
  assert(codes(r).includes("sitemap_url_robots_blocked"));
  assert(codes(r).includes("sitemap_url_noncanonical"));
  assert(!JSON.stringify(r).includes(site_url + "a"));
});

test("V05: lastmod invalid, future, duplicate conflicts and independent change mismatches", () => {
  const r = analyze({
    documents: [
      doc("/one.xml", urlset(
        loc(site_url + "a", "2026-02-31"),
        loc(site_url + "b", "2040-01-01"),
        loc(site_url + "c", "2026-11-01"),
      )),
      doc("/two.xml", urlset(loc(site_url + "c", "2026-11-18"))),
    ],
    page_observations: [
      { url: site_url + "c", status_code: 200,
        modified_at: "2026-11-20T00:00:00Z" },
    ],
  });
  assert.equal(r.lastmod_invalid_count, 1);
  assert.equal(r.lastmod_future_count, 1);
  assert.equal(r.lastmod_conflicting_count, 1);
  assert.equal(r.duplicate_url_entries, 1);
  assert.equal(r.lastmod_observation_conflicts, 1);
  assert(codes(r).includes("invalid_lastmod"));
  assert(codes(r).includes("future_lastmod"));
  assert(codes(r).includes("conflicting_lastmod"));
  assert(codes(r).includes("lastmod_vs_observed_change"));
});

test("V05: duplicated, unsafe, relative, external, missing and query-bearing URLs handled conservatively", () => {
  const r = analyze({
    documents: [doc("/sitemap.xml", urlset(
      loc(site_url + "ok"),
      loc(site_url + "ok"),
      loc(site_url + "path?a=1&amp;b=2"),
      loc("http://outside.example.net/private"),
      loc("/relative"),
      "<url></url>",
    ))],
  });
  assert.equal(r.distinct_page_urls, 2);
  assert.equal(r.duplicate_url_entries, 1);
  assert.equal(r.external_url_entries, 1);
  assert.equal(r.invalid_url_entries, 2);
  assert(codes(r).includes("missing_loc"));
  assert(codes(r).includes("invalid_loc"));
  assert(codes(r).includes("external_loc"));
  assert(!JSON.stringify(r).includes("outside.example.net"));
  assert(!JSON.stringify(r).includes("?a=1"));
});

test("V05: sitemap document malformed/DTD XXE/unsupported roots never become valid", () => {
  for (const xml of [
    "<urlset><url><loc>https://example.com/</urlset>",
    "<!DOCTYPE urlset [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><urlset>&xxe;</urlset>",
    "<urlset><url><loc>https://example.com/?x=1&y=2</loc></url></urlset>",
    "<urlset><url><loc>https://example.com/</loc></url></urlset><foo/>",
    "<urlset><url value=unquoted /></urlset>",
  ]) {
    const r = analyze({ documents: [doc("/sitemap.xml", xml)] });
    assert.equal(r.documents[0].kind, "invalid");
    assert.equal(r.distinct_page_urls, 0);
    assert(codes(r).includes("xml_malformed"));
    assert(!JSON.stringify(r).includes("/etc/passwd"));
  }
  const rss = analyze({ documents: [doc("/rss.xml", "<rss><channel><item><link>https://example.com/</link></item></channel></rss>")] });
  assert.equal(rss.documents[0].kind, "unsupported");
  assert(codes(rss).includes("unsupported_format"));
});

test("V05: invalid numeric XML character references invalidate offline sitemaps", () => {
  for (const entity of ["&#0;", "&#xD800;", "&#x110000;"]) {
    const xml = urlset(`<url note="${entity}"><loc>${site_url}page</loc></url>`);
    const result = analyze({ documents: [doc("/sitemap.xml", xml)] });
    assert.equal(result.documents[0].kind, "invalid", entity);
    assert.equal(result.distinct_page_urls, 0, entity);
    assert(codes(result).includes("xml_malformed"), entity);
  }
  for (const entity of ["&#x9;", "&#x1F600;"]) {
    const xml = urlset(`<url note="${entity}"><loc>${site_url}page</loc></url>`);
    const result = analyze({ documents: [doc("/sitemap.xml", xml)] });
    assert.equal(result.documents[0].kind, "urlset", entity);
    assert.equal(result.distinct_page_urls, 1, entity);
  }
});

test("V05: forbidden literal XML characters invalidate the entire sitemap", () => {
  const invalid = [0, 1, 0xB, 0xC, 0x1F, 0xD800, 0xDFFF, 0xFFFE, 0xFFFF];
  const contexts = [
    c => urlset(`<url note="${c}"><loc>${site_url}page</loc></url>`),
    c => urlset(loc(site_url + "page") + `<!--${c}-->`),
    c => urlset(loc(site_url + "page") + `<extra><![CDATA[${c}]]></extra>`),
    c => urlset(loc(site_url + "page") + `<extra>${c}</extra>`),
    c => `<?test ${c}?>` + urlset(loc(site_url + "page")),
  ];
  for (const point of invalid) {
    const c = String.fromCodePoint(point);
    for (const [i, make] of contexts.entries()) {
      const label = `${point.toString(16)} context ${i}`;
      const result = analyze({ documents_complete: true, documents: [doc("/sitemap.xml", make(c))] });
      assert.equal(result.documents[0].kind, "invalid", label);
      assert.equal(result.inventory_complete, false, label);
      assert.equal(result.distinct_page_urls, 0, label);
      assert(codes(result).includes("xml_malformed"), label);
    }
    const documents = [doc("/sitemap.xml", index(child(site_url + "child.xml") + `<!--${c}-->`))];
    assert.deepEqual(sitemapIndexChildUrls({ site_url, documents }), [], point.toString(16));
  }
  for (const point of [9, 10, 13, 0x20, 0x7F, 0x85, 0xD7FF, 0xE000, 0xFFFD, 0x10000, 0x1F600, 0x10FFFF]) {
    for (const make of contexts) {
      const result = analyze({ documents_complete: true, documents: [doc("/sitemap.xml", make(String.fromCodePoint(point)))] });
      assert.equal(result.documents[0].kind, "urlset", point.toString(16));
      assert.equal(result.inventory_complete, true, point.toString(16));
      assert.equal(result.distinct_page_urls, 1, point.toString(16));
    }
  }
});

test("V05: plain text sitemap and path case/query URLs require absolute syntax", () => {
  const r = analyze({
    documents: [doc("/sitemap.txt",
      [site_url + "One", site_url + "One?a=1", "/relative"].join("\n"),
      { content_type: "text/plain" })],
  });
  assert.equal(r.documents[0].kind, "text");
  assert.equal(r.distinct_page_urls, 2);
  assert.equal(r.invalid_url_entries, 1);
  const r2 = analyze({ documents: [doc("/sitemap.xml", urlset(loc(site_url + "One"))) ],
    discovered_urls: [site_url + "one", site_url + "not-listed"] });
  assert.equal(r2.discovered_missing_from_sitemaps, 2);
  assert.equal(r2.sitemap_urls_not_in_discovery, 1);
  assert.equal(r2.inventory_complete, false);
});

test("V05: invalid scope, duplicated documents and observations, bytes and timestamp bounds rejected", () => {
  const base = doc("/sitemap.xml", urlset(loc(site_url)));
  for (const item of [
    { documents: [] },
    { documents: Array.from({ length: MAX_SITEMAP_DOCUMENTS + 1 }, (_, i) =>
      doc("/" + i + ".xml", urlset(loc(site_url)))) },
    { documents: [base, base] },
    { documents: [doc("/sitemap.xml", "x".repeat(MAX_SITEMAP_DOCUMENT_BYTES + 1))] },
    { documents: [doc("/sitemap.xml?secret=x", urlset(loc(site_url)))] },
    { documents: [doc("/sitemap.xml", urlset(loc(site_url)), { status_code: 600 })] },
    { documents: [base], discovered_urls: ["http://localhost/"] },
    { documents: [base], page_observations: [
      { url: site_url, status_code: 200 }, { url: site_url, status_code: 503 },
    ] },
    { documents: [base], observed_at: "2026-02-31T12:00:00Z" },
  ]) {
    assert.throws(() => analyze(item));
  }
  const empty = emptySitemapInventoryReview();
  assert.equal(empty.documents_observed, 0);
  assert.equal(empty.coverage_limited, true);
});

test("V05: child index path mismatch and unsafe unfetched children are not probed", () => {
  const source = index(
    child(site_url + "good.xml"),
    child("https://outside.example.net/hidden.xml"),
    child(site_url + "child.xml?token=secret"),
  );
  const r = analyze({ documents: [doc("/nested/index.xml", source)] });
  assert.equal(r.distinct_child_sitemaps, 1);
  assert.equal(r.invalid_url_entries, 1);
  assert.equal(r.external_url_entries, 1);
  assert(codes(r).includes("out_of_scope_loc"));
  const urls = sitemapIndexChildUrls({
    site_url,
    documents: [doc("/nested/index.xml", source)],
  });
  assert.deepEqual(urls, [site_url + "good.xml"]);
});
