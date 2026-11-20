import { describe, expect, it } from "vitest";
import { observeInternalLinks, reviewInternalLinks, safeLinkPageUrl } from "./internal-link-quality";

const site = "https://example.test";
const source = site + "/guides/work";
const target = site + "/products/chairs";
const html = (title: string, heading: string, body: string) =>
  '<html><head><title>' + title + '</title></head><body>'
  + '<nav><a href="/products/chairs">Nav</a></nav>'
  + '<main><h1>' + heading + '</h1>' + body + '</main>'
  + '<footer><a href="/footer">Footer</a></footer></body></html>';
const page = (url: string, markup: string) => observeInternalLinks(markup, url);
const product = page(target, html("Ergonomic office chairs", "Office chairs", "<p>Chair details</p>"));
const codes = (r: ReturnType<typeof reviewInternalLinks>) => r.findings.map((f) => f.code);

describe("P1-08 hosted offline link and anchor signals", () => {
  it("separates contextual internal vs external links and compares only supplied targets", () => {
    const sourcePage = page(source, html("Work guide", "Work guide",
      '<a href="../products/chairs">Ergonomic office chairs</a>'
      + '<a href="https://other.test/reference">Research</a>'
      + '<a href="#details">Jump</a>'
      + '<a href="mailto:help@example.test">Email</a>'));
    const r = reviewInternalLinks([sourcePage, product]);
    expect(r.internal_links_observed).toBe(1);
    expect(r.external_links_observed).toBe(1);
    expect(r.linked_sample_targets).toBe(1);
    expect(r.fragment_only_links).toBe(1);
    expect(r.skipped_non_http_links).toBe(1);
    expect(r.excluded_navigation_links).toBeGreaterThan(0);
    expect(r.coverage_limited).toBe(true);
    expect(r.low_heading_overlap_links).toBe(0);
  });
  it("treats aria-label/image alt as accessible and empty labels as warning", () => {
    const sourcePage = page(source, html("Guide", "Guide",
      '<a href="/products/chairs"><img src="a.png" alt=""></a>'
      + '<a href="/products/chairs"><img src="x.png" alt="Office chairs"></a>'
      + '<a href="/products/chairs" aria-label="Chair details">read more</a>'
      + '<a href="/products/chairs">click here</a>'
      + '<div hidden><a href="/products/chairs">read more</a></div>'));
    const r = reviewInternalLinks([sourcePage, product]);
    expect(r.internal_links_observed).toBe(4);
    expect(r.missing_anchor_labels).toBe(1);
    expect(r.generic_anchor_links).toBe(1);
    expect(codes(r)).toEqual(expect.arrayContaining(["accessible_anchor_missing", "generic_anchor_text"]));
  });
  it("never judges unknown and query-variant targets broken, nor predicts semantic relevance", () => {
    const sourcePage = page(source, html("Guide", "Guide",
      '<a href="/products/chairs?variant=FAKE_SECRET">Ergonomic chairs</a>'
      + '<a href="/unknown">Animal care handbook</a>'
      + '<a href="/products/chairs">Animal care handbook</a>'));
    const r = reviewInternalLinks([sourcePage, product]);
    expect(r.unmatched_internal_links).toBe(2);
    expect(r.low_heading_overlap_links).toBe(1);
    expect(codes(r)).toContain("sampled_target_unobserved");
    expect(JSON.stringify(r)).not.toContain("FAKE_SECRET");
    expect(JSON.stringify(r)).not.toContain("/products/chairs");
    expect(r.limitations.join(" ")).toContain("not semantic relevance");
  });
  it("rejects unsafe/duplicated site labels and stays strictly bounded", () => {
    const sourcePage = page(source, html("Guide", "Guide", ""));
    expect(() => reviewInternalLinks([sourcePage, sourcePage])).toThrow("unique");
    expect(safeLinkPageUrl(site + "/page?token=FAKE_TOKEN")).toBeUndefined();
    expect(() => reviewInternalLinks([sourcePage, page("https://elsewhere.test/x",
      html("Other", "Other", ""))])).toThrow("same exact origin");
    const refs = Array.from({ length: 200 }, (_, i) =>
      '<a href="/unseen-' + i + '">read more</a>').join("");
    const observed = Array.from({ length: 8 }, (_, i) =>
      page(site + "/sample/" + i, html("Guide", "Guide", refs)));
    const r = reviewInternalLinks(observed);
    expect(r.internal_links_observed).toBe(8 * 160);
    expect(r.findings.length).toBe(12);
    expect(r.findings_truncated).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThan(10_000);
    expect(r).toEqual(reviewInternalLinks(observed));
  });
  it("keeps no-main fallback explicitly partial and skips hidden/no-following fragment links", () => {
    const sourcePage = page(source, '<html><head><title>Guide</title></head>'
      + '<body><a href="#contents">Contents</a><a rel="nofollow" href="/products/chairs">Office chairs</a>'
      + '<div hidden><a href="/secret">secret</a></div></body></html>');
    const r = reviewInternalLinks([sourcePage, product]);
    expect(r.pages[0].main_present).toBe(false);
    expect(r.fragment_only_links).toBe(1);
    expect(r.nofollow_internal_links).toBe(1);
    expect(r.internal_links_observed).toBe(1);
    expect(codes(r)).toContain("page_main_missing");
  });
  it("resolves many aria-labelledby tokens in bounded static HTML without treating them as missing", () => {
    const labels = Array.from({ length: 160 }, (_, i) =>
      '<span id="label-' + i + '">Office chairs</span>'
      + '<a href="/products/chairs" aria-labelledby="label-' + i + '"></a>').join("");
    const src = page(source, html("Guide", "Guide", labels));
    const r = reviewInternalLinks([src, product]);
    expect(r.internal_links_observed).toBe(160);
    expect(r.missing_anchor_labels).toBe(0);
  });
});
