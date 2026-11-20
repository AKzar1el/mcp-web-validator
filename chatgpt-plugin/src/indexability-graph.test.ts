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

  it("does not treat blank hreflang href attributes as links back to the current page", () => {
    const result = extractPageIndexabilitySignals(html(
      '<link rel="alternate" hreflang="en" href="">'
      + '<link rel="alternate" hreflang="fr" href="   ">',
    ), "https://example.com/en");
    expect(result.hreflang).toEqual([]);
    expect(result.hreflang_truncated).toBe(true);
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

  it("keeps bounded duplicate-title URL examples stable across page discovery order", () => {
    const pages = ["d", "b", "a", "c"].map((part) =>
      page(`https://example.com/${part}`, `<title>Shared title</title><link rel=canonical href="/${part}">`));
    const first = build(pages).findings.filter((f) => f.code === "indexability.duplicate_title");
    const reversed = build([...pages].reverse()).findings.filter((f) => f.code === "indexability.duplicate_title");
    expect(first).toEqual(reversed);
    expect(first[0]?.example_urls).toEqual([
      "https://example.com/a", "https://example.com/b", "https://example.com/c",
    ]);
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

  it("does not require language-selector x-default targets to link back", () => {
    const english = page("https://example.com/en",
      '<title>English</title><link rel=alternate hreflang=en href="/en"><link rel=alternate hreflang=x-default href="/choose-language">');
    const selector = page("https://example.com/choose-language", '<title>Choose your language</title>');
    expect(build([english, selector]).findings.map((finding) => finding.code))
      .not.toContain("indexability.hreflang_missing_return");
    const localizedTarget = page("https://example.com/choose-language",
      '<title>Localized content</title><link rel=alternate hreflang=de href="/de">');
    expect(build([english, localizedTarget]).findings.map((finding) => finding.code))
      .toContain("indexability.hreflang_missing_return");
  });

  it("reports a missing HTML hreflang self-link only when the sampled declarations are complete", () => {
    const sourceUrl = "https://example.com/en";
    const source = page(sourceUrl, '<title>English</title><link rel=alternate hreflang=de href="/de">');
    const target = page("https://example.com/de",
      '<title>Deutsch</title><link rel=alternate hreflang=de href="/de"><link rel=alternate hreflang=en href="/en">');
    expect(build([source, target]).findings.filter((f) => f.code === "indexability.hreflang_missing_self"))
      .toEqual([{
        code: "indexability.hreflang_missing_self",
        severity: "warning",
        confidence: "observed",
        message: expect.any(String),
        example_urls: [sourceUrl],
      }]);

    const withSelf = page(sourceUrl,
      '<title>English</title><link rel=alternate hreflang=en href="/en"><link rel=alternate hreflang=de href="/de">');
    const xDefaultOnly = page("https://example.com/selector",
      '<link rel=alternate hreflang=x-default href="/en">');
    const partial = page(sourceUrl,
      '<link rel=alternate hreflang=de href="/de"><link rel=alternate hreflang=fr href="/fr?token=secret">');
    for (const sampled of [[withSelf, target], [xDefaultOnly], [partial]]) {
      expect(build(sampled).findings.filter((f) => f.code === "indexability.hreflang_missing_self"))
        .toEqual([]);
    }
  });

  it("does not mistake an x-default fallback for the page's language self-reference", () => {
    const url = "https://example.com/en";
    const fallbackOnly = page(url,
      '<link rel=alternate hreflang=x-default href="/en"><link rel=alternate hreflang=de href="/de">');
    expect(build([fallbackOnly]).findings.map((finding) => finding.code))
      .toContain("indexability.hreflang_missing_self");

    const localizedSelf = page(url,
      '<link rel=alternate hreflang=x-default href="/en">'
      + '<link rel=alternate hreflang=en href="/en"><link rel=alternate hreflang=de href="/de">');
    expect(build([localizedSelf]).findings.map((finding) => finding.code))
      .not.toContain("indexability.hreflang_missing_self");
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

  it("reports a sampled three-page canonical cycle once, without mislabeling its members as chains", () => {
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/c">');
    const c = page("https://example.com/c", '<title>C</title><link rel=canonical href="/a">');
    const tail = page("https://example.com/tail", '<title>Tail</title><link rel=canonical href="/a">');
    const result = build([a, b, c, tail]);
    expect(result.findings.filter((f) => f.code === "indexability.canonical_cycle")).toEqual([{
      code: "indexability.canonical_cycle",
      severity: "error",
      confidence: "observed",
      message: expect.any(String),
      example_urls: ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
    }]);
    expect(result.findings.filter((f) => f.code === "indexability.canonical_chain")
      .map((f) => f.example_urls[0])).toEqual(["https://example.com/tail"]);
  });

  it("detects disjoint longer canonical cycles deterministically without inventing unsampled cycles", () => {
    const ring = (prefix: string, size: number) => Array.from({ length: size }, (_, i) =>
      page(`https://example.com/${prefix}${i}`, `<title>${prefix}${i}</title><link rel=canonical href="/${prefix}${(i + 1) % size}">`));
    const sampled = [...ring("x", 4), ...ring("y", 3)];
    const first = build(sampled);
    expect(first.findings.filter((f) => f.code === "indexability.canonical_cycle")).toHaveLength(2);
    expect(first.findings.filter((f) => f.code === "indexability.canonical_chain")).toHaveLength(0);
    expect(first.findings).toEqual(build([...sampled].reverse()).findings);
    const unsampled = ring("z", 3).slice(0, 2);
    expect(build(unsampled, { discoveryComplete: false }).findings).toEqual([]);
  });

  it("retains observed canonical errors when 30 earlier sitemap warnings fill the bounded report", () => {
    const warnings = Array.from({ length: 30 }, (_, i) =>
      page(`https://example.com/noindex-${i}`, `<title>Noindex ${i}</title><meta name=robots content=noindex>`));
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/a">');
    const sampled = [...warnings, a, b];
    const result = build(sampled);
    expect(result.findings_truncated).toBe(true);
    expect(result.findings).toHaveLength(30);
    expect(result.findings.filter((f) => f.code === "indexability.canonical_cycle")).toHaveLength(1);
    expect(result.findings.filter((f) => f.code === "indexability.sitemap_noindex")).toHaveLength(29);
    expect(result.findings).toEqual(build([...sampled].reverse()).findings);
  });

  it("caps large numbers of observed cycles and reports truncation without losing bounded ordering", () => {
    const pages = Array.from({ length: 31 }, (_, cycle) => [0, 1, 2].map((member) =>
      page(`https://example.com/c${cycle}-${member}`,
        `<title>Cycle ${cycle}-${member}</title><link rel=canonical href="/c${cycle}-${(member + 1) % 3}">`))).flat();
    const first = build(pages);
    expect(first.findings).toHaveLength(30);
    expect(first.findings_truncated).toBe(true);
    expect(first.findings.every((f) => f.code === "indexability.canonical_cycle" && f.severity === "error")).toBe(true);
    expect(first.findings).toEqual(build([...pages].reverse()).findings);
  });

  it("is deterministic and leaves source page summaries untouched", () => {
    const a = page("https://example.com/a", '<title>A</title><link rel=canonical href="/b">');
    const b = page("https://example.com/b", '<title>B</title><link rel=canonical href="/a">');
    const original = structuredClone([a, b]);
    expect(build([a, b])).toEqual(build([a, b]));
    expect([a, b]).toEqual(original);
  });
});
