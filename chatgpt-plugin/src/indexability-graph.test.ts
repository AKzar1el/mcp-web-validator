import { describe, expect, it } from "vitest";
import { buildSiteIndexabilityGraph, extractPageIndexabilitySignals } from "./indexability-graph";
import type { SiteAuditPageSummary } from "./site-audit";

function html(head: string): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body><h1>Example</h1></body></html>`;
}

function page(url: string, head: string, options: Partial<SiteAuditPageSummary> = {}): SiteAuditPageSummary {
  return {
    url,
    fetched_url: url,
    status: "passed",
    page_fetched: true,
    html_validation_status: "completed",
    html_errors: 0,
    html_warnings: 0,
    seo_errors: 0,
    seo_warnings: 0,
    schema_errors: 0,
    schema_warnings: 0,
    notes: 0,
    health_score: 100,
    top_findings: [],
    indexability: extractPageIndexabilitySignals(html(head), url),
    ...options,
  };
}

function build(pages: SiteAuditPageSummary[], options: { sitemapPages?: string[]; discoveryComplete?: boolean } = {}) {
  return buildSiteIndexabilityGraph(pages, {
    sitemapPages: options.sitemapPages ?? pages.map((page) => page.url),
    discoveryComplete: options.discoveryComplete ?? true,
  });
}

describe("indexability signal extraction", () => {
  it("recognizes canonical link and static noindex without interpreting absent noindex as confirmed Google indexing", () => {
    const signals = extractPageIndexabilitySignals(html(
      '<title>Demo</title><link rel="alternate canonical" href="/preferred"><meta name="robots" content="NOINDEX,follow">',
    ), "https://example.com/about");
    expect(signals).toMatchObject({
      title: "Demo", canonical_state: "usable",
      canonical_url: "https://example.com/preferred", noindex_observed: true,
    });
  });

  it("separates Googlebot header directives from Bingbot-specific headers", () => {
    expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/", "bingbot: noindex").noindex_observed)
      .toBe(false);
    expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/", "bingbot: noindex\ngooglebot: noindex").noindex_observed)
      .toBe(true);
    expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/", "noarchive, noindex").noindex_observed)
      .toBe(true);
    expect(extractPageIndexabilitySignals(html("<title>A</title><meta name='bingbot' content='noindex'>"), "https://example.com/").noindex_observed)
      .toBe(false);
  });

  it("keeps comma-separated X-Robots-Tag directives scoped to their named crawler", () => {
    const cases: Array<[string, boolean]> = [
      ["bingbot: nofollow, noindex", false],
      ["bingbot: noindex, nofollow, googlebot: follow", false],
      ["googlebot: nofollow, noindex", true],
      ["bingbot: nofollow, googlebot: noindex", true],
      ["bingbot: noindex\nnoindex", true],
      ["max-snippet:20, noindex", true],
    ];
    for (const [header, expected] of cases) {
      expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/a", header).noindex_observed)
        .toBe(expected);
    }
  });

  it("recognizes the Google robots none alias as noindex without applying other crawlers' rules", () => {
    for (const head of [
      '<meta name="robots" content="none">',
      '<meta name="googlebot" content="NONE, follow">',
    ]) {
      expect(extractPageIndexabilitySignals(html(head), "https://example.com/a").noindex_observed).toBe(true);
    }
    expect(extractPageIndexabilitySignals(html('<meta name="bingbot" content="none">'), "https://example.com/a").noindex_observed)
      .toBe(false);
    for (const header of ["none", "googlebot: none", "noarchive, none"]) {
      expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/a", header).noindex_observed)
        .toBe(true);
    }
    for (const header of ["bingbot: none", "bingbot: nofollow, none", "nonetheless"]) {
      expect(extractPageIndexabilitySignals(html("<title>A</title>"), "https://example.com/a", header).noindex_observed)
        .toBe(false);
    }
  });

  it("does not trust canonicals with credentials, secrets in queries, unsupported schemes, or multiple declarations", () => {
    const cases = [
      '<link rel=canonical href="https://user:secret@example.com/page">',
      '<link rel=canonical href="/page?session=secret">',
      '<link rel=canonical href="javascript:alert(1)">',
      '<link rel=canonical href="https://example.com/page#fragment">',
    ];
    for (const head of cases) {
      const result = extractPageIndexabilitySignals(html(head), "https://example.com/");
      expect(result.canonical_state).toBe("unverifiable");
      expect(result.canonical_url).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    const multiple = extractPageIndexabilitySignals(html(
      '<link rel=canonical href="/a"><link rel=canonical href="/b">',
    ), "https://example.com/");
    expect(multiple.canonical_state).toBe("ambiguous");
    expect(multiple.canonical_url).toBeUndefined();
  });

  it("requires head-only canonical relations without hreflang, media, or type annotations", () => {
    const annotated = extractPageIndexabilitySignals(html('<link rel=canonical href="/a" hreflang="de">'), "https://example.com/");
    expect(annotated.canonical_state).toBe("unverifiable");
    const bodyOnly = extractPageIndexabilitySignals(
      '<html><head><title>Example</title></head><body><link rel=canonical href="/body"></body></html>',
      "https://example.com/",
    );
    expect(bodyOnly.canonical_state).toBe("missing");
  });

  it("collects capped hreflang declarations and omits secret query URLs", () => {
    const result = extractPageIndexabilitySignals(html(
      '<link rel="alternate" hreflang="de" href="/de">'
      + '<link rel="alternate" hreflang="en" href="/en?key=secret">'
      + '<link rel="alternate" hreflang="de" href="/de">',
    ), "https://example.com/");
    expect(result.hreflang).toEqual([{ language: "de", url: "https://example.com/de" }]);
    expect(result.hreflang_truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("indexability graph: sampled-only corroboration", () => {
  it("detects sitemap/noindex contradiction, canonical cycles and canonical target noindex", () => {
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/a"><meta name=robots content=noindex>');
    const result = build([a, b]);
    expect(result.scope).toBe("sampled_pages_only");
    expect(result.coverage_limited).toBe(false);
    expect(result.findings.filter((f) => f.code === "indexability.canonical_cycle")).toHaveLength(1);
    expect(result.findings.map((f) => f.code)).toContain("indexability.canonical_to_noindex");
    expect(result.findings.map((f) => f.code)).toContain("indexability.sitemap_noindex");
    expect(result.findings.find((f) => f.code === "indexability.canonical_cycle")).toMatchObject({
      severity: "error", confidence: "observed",
    });
  });

  it("reports the robots none alias as an observed sitemap/indexability conflict", () => {
    const url = "https://example.com/a";
    const entry = page(url, '<title>Unlisted</title><meta name="robots" content="none">');
    const result = build([entry]);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "indexability.sitemap_noindex", confidence: "observed", example_urls: [url],
    }));
  });

  it("does not declare canonical targets that are outside the sampled pages broken", () => {
    const source = page("https://example.com/a", '<title>A</title><link rel=canonical href="/not-sampled">');
    const result = build([source], { discoveryComplete: false });
    expect(result.findings).toEqual([]);
    expect(result.coverage_limited).toBe(true);
    expect(result.limitations.join(" ")).toMatch(/incomplete/i);
  });

  it("treats title duplication as potential, not a confirmed indexing error", () => {
    const a = page("https://example.com/a", '<title>Same Page Title</title><link rel=canonical href="/a">');
    const b = page("https://example.com/b", '<title>Same Page Title</title><link rel=canonical href="/b">');
    const finding = build([a, b]).findings.find((item) => item.code === "indexability.duplicate_title");
    expect(finding).toMatchObject({ severity: "warning", confidence: "potential" });
    const consolidated = page("https://example.com/b", '<title>Same Page Title</title><link rel=canonical href="/a">');
    expect(build([a, consolidated]).findings.map((f) => f.code)).not.toContain("indexability.duplicate_title");
  });

  it("checks return hreflang links only when both pages were sampled", () => {
    const a = page("https://example.com/en", '<title>English</title><link rel=alternate hreflang=de href="/de">');
    const b = page("https://example.com/de", '<title>Deutsch</title><link rel=alternate hreflang=de href="/de">');
    const codes = build([a, b]).findings.map((f) => f.code);
    expect(codes).toContain("indexability.hreflang_missing_return");
    expect(build([a]).findings.map((f) => f.code)).not.toContain("indexability.hreflang_missing_return");
    const reciprocal = page("https://example.com/de", '<title>Deutsch</title><link rel=alternate hreflang=en href="/en">');
    expect(build([a, reciprocal]).findings.map((f) => f.code)).not.toContain("indexability.hreflang_missing_return");
  });

  it("does not claim missing pages passed, or noindex seed URLs are included in sitemaps", () => {
    const root = page("https://example.com/", '<title>Home</title><meta name=robots content=noindex>');
    const failed = { ...page("https://example.com/private", '<title>Private</title>'), page_fetched: false, indexability: undefined };
    const result = build([root, failed], { sitemapPages: ["https://example.com/private"], discoveryComplete: false });
    expect(result.coverage_limited).toBe(true);
    expect(result.sampled_pages).toBe(1);
    expect(result.findings.map((f) => f.code)).not.toContain("indexability.sitemap_noindex");
  });

  it("observes canonical chains within sampled pages", () => {
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/c">');
    const c = page("https://example.com/c", '<title>C</title><link rel=canonical href="/c">');
    const result = build([a, b, c]);
    expect(result.findings.map((f) => f.code)).toContain("indexability.canonical_chain");
    expect(result.findings.map((f) => f.code)).not.toContain("indexability.canonical_cycle");
  });

  it("is deterministic and leaves source page summaries untouched", () => {
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/a">');
    const original = structuredClone([a, b]);
    expect(build([a, b])).toEqual(build([a, b]));
    expect([a, b]).toEqual(original);
  });
});
