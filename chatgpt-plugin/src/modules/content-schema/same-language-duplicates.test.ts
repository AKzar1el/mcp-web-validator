import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPublicSite } from "../../site-audit";
import {
  analyzeSameLanguageDuplicates,
  observeMainContent,
} from "./same-language-duplicates";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const words = Array.from({ length: 140 }, (_, i) => `importanttopic${i}`);
const mainText = words.join(" ");
const pageHtml = (language: string, text = mainText) =>
  `<!doctype html><html lang="${language}"><head><title>Test site page</title><meta name="viewport" content="width=device-width"></head><body><nav>${"menu ".repeat(150)}</nav><main><h1>Useful heading</h1><p>${text}</p></main><footer>Extra boilerplate</footer></body></html>`;

describe("P1-01 hosted same-language main-content comparison", () => {
  it("reports exact same-language content, excluding shared navigation", () => {
    const first = observeMainContent(pageHtml("en-US"), "https://example.com/en-us");
    const second = observeMainContent(pageHtml("en-GB"), "https://example.com/en-gb");
    const result = analyzeSameLanguageDuplicates([first, second]);
    expect(result.pairs).toMatchObject([{
      kind: "exact", language: "en", confidence: "observed", similarity_percent: 100,
    }]);
    expect(JSON.stringify(result)).not.toContain(mainText);
  });

  it("reports near matches conservatively and excludes distinct languages/scripts", () => {
    const changed = words.slice(); changed[60] = "different";
    const pages = [
      observeMainContent(pageHtml("en", mainText), "https://example.com/en-1"),
      observeMainContent(pageHtml("en", changed.join(" ")), "https://example.com/en-2"),
      observeMainContent(pageHtml("de", mainText), "https://example.com/de"),
      observeMainContent(pageHtml("sr-Cyrl", mainText), "https://example.com/sr-cyrl"),
      observeMainContent(pageHtml("sr-Latn", mainText), "https://example.com/sr-latn"),
    ];
    const result = analyzeSameLanguageDuplicates(pages);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].kind).toBe("near");
    expect(result.pairs[0].similarity_percent).toBeGreaterThanOrEqual(82);
  });

  it("does not emit duplicate claims for missing language, absent main text or short pages", () => {
    const pages = [
      observeMainContent(pageHtml("en"), "https://example.com/good"),
      observeMainContent(pageHtml("und"), "https://example.com/unknown"),
      observeMainContent("<html><body><main>Very short</main></body></html>", "https://example.com/short"),
    ];
    const result = analyzeSameLanguageDuplicates(pages);
    expect(result.pairs).toHaveLength(0);
    expect(result.eligible_pages).toBe(1);
    expect(result.skipped_pages).toBe(2);
    expect(result.coverage_limited).toBe(true);
  });

  it("integrates into sitemap-first site audit without extra crawl requests or raw page text", async () => {
    const visited: string[] = [];
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/copy</loc></url><url><loc>https://example.com/de</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/") {
        return new Response(pageHtml("en-US"), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url === "https://example.com/copy") {
        return new Response(pageHtml("en-GB"), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url === "https://example.com/de") {
        return new Response(pageHtml("de-DE"), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });
    expect(result.pages_audited).toBe(3);
    expect(result.content_duplicates).toMatchObject({
      scope: "sampled_pages_only", sampled_pages: 3, eligible_pages: 3,
      skipped_pages: 0, coverage_limited: false, pairs_truncated: false,
    });
    expect(result.content_duplicates.pairs).toHaveLength(1);
    expect(result.content_duplicates.pairs[0]).toMatchObject({
      first_url: "https://example.com/", second_url: "https://example.com/copy",
      kind: "exact", language: "en",
    });
    expect(result.pages.every((p) => !("mainContent" in p))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(mainText);
    expect(visited.filter((url) => url.startsWith("https://example.com/") && !url.endsWith(".xml") && !url.endsWith(".txt"))).toEqual([
      "https://example.com/", "https://example.com/copy", "https://example.com/de",
    ]);
  });

  it("keeps coverage limited when a sitemap has more pages than the selected batch", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url === "https://example.com/sitemap.xml") return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
      if (url === "https://example.com/") return new Response(pageHtml("en"), { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });
    expect(result.content_duplicates.coverage_limited).toBe(true);
    expect(result.content_duplicates.pairs).toHaveLength(0);
    expect(result.content_duplicates.eligible_pages).toBe(1);
  });
});
