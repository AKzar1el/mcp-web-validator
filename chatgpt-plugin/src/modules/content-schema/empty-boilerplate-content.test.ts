import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMainContent } from "./same-language-duplicates";
import { analyzePageContentQuality } from "./empty-boilerplate-content";
import { auditPublicSite } from "../../site-audit";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const boilerplate = Array.from({ length: 5 }, (_, i) =>
  Array.from({ length: 22 }, (_, j) => "shared" + i + "term" + j).join(" ") + ".").join(" ");
const unique = (page: number) =>
  Array.from({ length: 15 }, (_, i) => "unique" + page + "part" + i).join(" ") + ".";
const html = (content: string, language = "en") =>
  '<!doctype html><html lang="' + language + '"><head><title>Example page</title><meta name=viewport content="width=device-width"></head><body><header>'
  + boilerplate + '</header><main>' + content + '</main><footer>'
  + boilerplate + '</footer></body></html>';
const observation = (url: string, content: string, lang = "en") =>
  observeMainContent(html(content, lang), url);

describe("P1-03 hosted content quality analysis", () => {
  it("does not group unrelated root-level empty pages as one family (#463)", () => {
    const pages = ["/privacy", "/contact"].map((path) =>
      observation("https://example.com" + path, ""));
    const result = analyzePageContentQuality(pages);
    expect(result.empty_main_pages).toBe(2);
    expect(result.findings.map((finding) => finding.code)).toContain("content.empty_main");
    expect(result.findings.map((finding) => finding.code)).not.toContain("content.family_empty");
    expect(result.families_compared).toBe(0);
  });

  it("detects a long shared paragraph without any punctuation (#463)", () => {
    const repeatedText = Array.from({ length: 115 }, (_, i) => "boilerplate" + i).join(" ");
    const pages = [1, 2, 3].map((i) =>
      observation("https://example.com/products/" + i,
        "<p>" + repeatedText + "</p><p>" + unique(i) + "</p>"));
    const result = analyzePageContentQuality(pages);
    expect(result.repeated_boilerplate_pages).toBe(3);
    expect(result.possible_low_value_pages).toBe(3);
    expect(result.findings.map((finding) => finding.code)).toContain("content.family_repeated_boilerplate");
    expect(JSON.stringify(result)).not.toContain("boilerplate50");
  });

  it("flags repeated substantive main-text boilerplate but does not return page text", () => {
    const pages = [1, 2, 3].map((i) =>
      observation("https://example.com/products/" + i,
        "<p>" + boilerplate + "</p><p>" + unique(i) + "</p>"));
    const result = analyzePageContentQuality(pages);
    expect(result).toMatchObject({
      scope: "sampled_pages_only", eligible_pages: 3, families_compared: 1,
      repeated_boilerplate_pages: 3, possible_low_value_pages: 3,
    });
    expect(result.findings.map((f) => f.code)).toContain("content.family_repeated_boilerplate");
    expect(result.findings.map((f) => f.code)).toContain("content.low_unique_value");
    expect(JSON.stringify(result)).not.toContain("shared0term0");
  });

  it("finds empty main content across a sampled family while keeping short pages provisional", () => {
    const report = analyzePageContentQuality([
      observation("https://example.com/faq/a", ""),
      observation("https://example.com/faq/b", "<script>window.secret='FAKE_PRIVATE'</script>"),
      observation("https://example.com/faq/c", "<p>Some answers are short but still useful.</p>"),
    ]);
    expect(report.empty_main_pages).toBe(2);
    expect(report.short_main_pages).toBe(1);
    expect(report.findings.map((f) => f.code)).toEqual(expect.arrayContaining([
      "content.empty_main", "content.family_empty", "content.short_main",
    ]));
    expect(JSON.stringify(report)).not.toContain("FAKE_PRIVATE");
  });

  it("does not confuse common header/footer chrome with repeated main content", () => {
    const pages = [1, 2].map((i) => observation(
      "https://example.com/products/" + i,
      "<h1>Useful distinct research</h1><p>" + Array.from({ length: 125 }, (_, j) =>
        "longoriginal" + i + "item" + j).join(" ") + "</p>",
    ));
    const report = analyzePageContentQuality(pages);
    expect(report.total_findings).toBe(0);
    expect(report.repeated_boilerplate_pages).toBe(0);
  });

  it("adds P1-03 review findings to existing sitemap-first audit without extra target requests", async () => {
    const root = "https://example.com/";
    const paths = ["/products/a", "/products/b", "/products/c"];
    const visited: string[] = [];
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") return new Response(
        "User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url === "https://example.com/sitemap.xml") return new Response(
        "<urlset>" + paths.map((p) => "<url><loc>https://example.com" + p + "</loc></url>").join("") + "</urlset>",
        { headers: { "content-type": "application/xml" } });
      if (url === root) return new Response(html("<main><h1>Home</h1></main>"),
        { headers: { "content-type": "text/html" } });
      const index = paths.indexOf(new URL(url).pathname);
      if (index >= 0) return new Response(
        html("<h1>Unique product</h1><p>" + boilerplate + "</p><p>" + unique(index) + "</p>"),
        { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected target: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: root, maxPages: 4, pageOffset: 0 });
    expect(result.pages_audited).toBe(4);
    expect(result.content_quality).toMatchObject({
      sampled_pages: 4, eligible_pages: 4, families_compared: 1,
      repeated_boilerplate_pages: 3, possible_low_value_pages: 3,
    });
    expect(result.content_quality.findings.map((f) => f.code))
      .toContain("content.family_repeated_boilerplate");
    expect(result.pages.every((p) => !("mainContent" in p))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("shared0term0");
    expect(visited.filter((url) => url === root || paths.some((p) => url === "https://example.com" + p))).toEqual([
      root, ...paths.map((p) => "https://example.com" + p),
    ]);
  });

  it("marks quality comparison limited when the sitemap sample is incomplete", async () => {
    const root = "https://example.com/";
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") return new Response(
        "User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url === "https://example.com/sitemap.xml") return new Response(
        "<urlset><url><loc>" + root + "</loc></url><url><loc>https://example.com/a</loc></url></urlset>",
        { headers: { "content-type": "application/xml" } });
      if (url === root) return new Response(html("<p>Short page</p>"), { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected target: " + url);
    }));
    const result = await auditPublicSite({ siteUrl: root, maxPages: 1, pageOffset: 0 });
    expect(result.content_quality).toMatchObject({
      sampled_pages: 1, eligible_pages: 1, coverage_limited: true,
    });
  });
});
