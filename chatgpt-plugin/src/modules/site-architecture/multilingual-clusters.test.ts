import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPublicSite } from "../../site-audit";
import {
  analyzeMultilingualClusters,
  observeMultilingualPage,
  normalizeHreflangLocale,
} from "./multilingual-clusters";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const locales = ["en", "de", "fr", "es", "it", "pt", "nl", "sv", "no", "da", "fi", "pl", "cs", "sk", "hu", "sl"];
const url = (language: string) => "https://example.com/" + language + "/";
const tags = (map: Array<[string, string]>) => map.map(([language, target]) =>
  '<link rel="alternate" hreflang="' + language + '" href="' + target + '">').join("");
const html = (language: string, refs: Array<[string, string]>, page: string) =>
  '<!doctype html><html lang="' + language + '"><head>'
  + '<link rel="canonical" href="' + page + '">'
  + tags(refs) + '</head><body><main><h1>Localized example</h1></main></body></html>';

describe("P1-02 hosted multilingual cluster analysis", () => {
  it("shares the full 16-locale engine plus x-default without false conflicts", () => {
    const refs: Array<[string, string]> = [
      ...locales.map((language): [string, string] => [language, url(language)]),
      ["x-default", url("en")],
    ];
    const pages = locales.map((language) =>
      observeMultilingualPage(html(language, refs, url(language)), url(language)));
    const analysis = analyzeMultilingualClusters(pages);
    expect(analysis).toMatchObject({
      sampled_pages: 16, eligible_pages: 16, pages_with_alternates: 16,
      locales_observed: 16, unobserved_targets: 0,
      total_findings: 0, coverage_limited: false,
    });
  });

  it("warns about missing return links, canonical mismatch, unsafe query targets and script distinctions", () => {
    const english = url("en"), german = url("de");
    const pages = [
      observeMultilingualPage(html("en-US",
        [["en-US", english], ["de-DE", german],
          ["fr-FR", "https://example.com/fr/?secret=FAKE_TOKEN"]], english), english),
      observeMultilingualPage(html("sr-Cyrl",
        [["de-DE", german]], english), german),
    ];
    const analysis = analyzeMultilingualClusters(pages);
    const codes = analysis.findings.map((finding) => finding.code);
    expect(codes).toContain("multilingual.unusable_declaration");
    expect(codes).toContain("multilingual.return_link_missing");
    expect(codes).toContain("multilingual.language_signal_mismatch");
    expect(codes).toContain("multilingual.non_self_canonical");
    expect(JSON.stringify(analysis)).not.toContain("FAKE_TOKEN");
    expect(normalizeHreflangLocale("sr-Latn-RS")).toBe("sr-Latn-RS");
  });

  it("does not report missing returns for unobserved targets in a bounded eight-page sample", () => {
    const refs: Array<[string, string]> = locales.map((language) => [language, url(language)]);
    const sampled = locales.slice(0, 8).map((language) =>
      observeMultilingualPage(html(language, refs, url(language)), url(language)));
    const analysis = analyzeMultilingualClusters(sampled, { sampledPages: 8, coverageLimited: true });
    expect(analysis.unobserved_targets).toBe(8);
    expect(analysis.coverage_limited).toBe(true);
    expect(analysis.findings.map((finding) => finding.code)).not.toContain("multilingual.return_link_missing");
  });

  it("integrates with sitemap-first page sampling without additional alternate target fetches", async () => {
    const visited: string[] = [];
    const english = "https://example.com/";
    const german = "https://example.com/de/";
    const refs: Array<[string, string]> = [["en", english], ["de", german], ["x-default", english]];
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const actual = String(target);
      visited.push(actual);
      if (actual === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (actual === "https://example.com/sitemap.xml") {
        return new Response('<urlset><url><loc>' + english + '</loc></url><url><loc>' + german + '</loc></url></urlset>', {
          headers: { "content-type": "application/xml" },
        });
      }
      if (actual === english) return new Response(html("en", refs, english), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      if (actual === german) return new Response(html("de", refs, german), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      if (actual.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + actual);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: english, maxPages: 2, pageOffset: 0 });
    expect(result.pages_audited).toBe(2);
    expect(result.multilingual_clusters).toMatchObject({
      scope: "sampled_pages_only", sampled_pages: 2, eligible_pages: 2,
      pages_with_alternates: 2, locales_observed: 2,
      unobserved_targets: 0, total_findings: 0, coverage_limited: false,
    });
    expect(result.pages.every((page) => !("multilingual" in page))).toBe(true);
    expect(visited.filter((item) => item === english || item === german)).toEqual([english, german]);
  });

  it("labels incomplete audits partial without inventing return-link failures", async () => {
    const english = "https://example.com/";
    const german = "https://example.com/de/";
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const actual = String(target);
      if (actual === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (actual === "https://example.com/sitemap.xml") {
        return new Response('<urlset><url><loc>' + english + '</loc></url><url><loc>' + german + '</loc></url></urlset>', {
          headers: { "content-type": "application/xml" },
        });
      }
      if (actual === english) {
        return new Response(html("en", [["en", english], ["de", german]], english), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (actual.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + actual);
    }));
    const result = await auditPublicSite({ siteUrl: english, maxPages: 1, pageOffset: 0 });
    expect(result.multilingual_clusters).toMatchObject({
      eligible_pages: 1, unobserved_targets: 1, total_findings: 0, coverage_limited: true,
    });
  });
});
