import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPublicSite, isAllowedByRobots, parseRobotsTxt } from "./site-audit";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function htmlResponse(html = "<!doctype html><html><head><title>Example page title for audit</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1></body></html>") {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

describe("robots rules", () => {
  it("uses the most-specific matching user-agent group and longest allow/disallow rule", () => {
    const rules = parseRobotsTxt([
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: DigestSEO-Web-Validator",
      "Disallow: /private",
      "Allow: /private/public",
    ].join("\n"), "https://example.com");

    expect(isAllowedByRobots(new URL("https://example.com/private"), rules.rules)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/private/public"), rules.rules)).toBe(true);
    expect(isAllowedByRobots(new URL("https://example.com/other"), rules.rules)).toBe(true);
  });
});

describe("auditPublicSite", () => {
  it("uses same-origin sitemap URLs, honors robots exclusions, and returns a continuation offset", async () => {
    const privateMarker = "private-page-marker-that-must-not-leak";
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse(`<!doctype html><html><head><title>Example page title for audit</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1><!--${privateMarker}--></body></html>`);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /blocked\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response([
          '<?xml version="1.0"?>',
          "<urlset>",
          "<url><loc>https://example.com/</loc></url>",
          "<url><loc>https://example.com/allowed#fragment</loc></url>",
          "<url><loc>https://example.com/blocked</loc></url>",
          "<url><loc>https://attacker.example/outside</loc></url>",
          "<url><loc>http://127.0.0.1/private</loc></url>",
          "</urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/allowed") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result).toMatchObject({
      site_url: "https://example.com/",
      sitemap_url: "https://example.com/sitemap.xml",
      discovery: "sitemap",
      pages_discovered: 3,
      pages_selected: 1,
      pages_audited: 1,
      pages_skipped_robots: 1,
      truncated: true,
      next_page_offset: 1,
      audit_health_score: expect.any(Number),
      score_coverage_percent: 100,
    });
    expect(result.pages).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("/blocked"))).toBe(false);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("attacker.example"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it("returns a typed partial result when Nu HTML validation is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL) => {
        const url = String(target);
        if (url === "https://example.com/") return htmlResponse();
        if (url === "https://example.com/robots.txt") {
          return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
        }
        if (url === "https://example.com/sitemap.xml") {
          return new Response("<urlset><url><loc>https://example.com/</loc></url></urlset>", {
            headers: { "content-type": "application/xml" },
          });
        }
        if (url.startsWith("https://html5.validator.nu/")) {
          throw new DOMException("Aborted", "AbortError");
        }
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.pages[0]).toMatchObject({
      status: "partial",
      html_validation_status: "timeout",
      failure_code: "html_validation_timeout",
    });
    expect(result.pages[0]?.health_score).toBeUndefined();
    expect(result.audit_health_score).toBeUndefined();
    expect(result.score_coverage_percent).toBe(0);
  });

  it("classifies an oversized page as a coverage limit rather than a completed audit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL) => {
        const url = String(target);
        if (url === "https://example.com/") return htmlResponse();
        if (url === "https://example.com/robots.txt") {
          return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
        }
        if (url === "https://example.com/sitemap.xml") {
          return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/large</loc></url></urlset>", {
            headers: { "content-type": "application/xml" },
          });
        }
        if (url === "https://example.com/large") return htmlResponse("x".repeat(200_001));
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    const large = result.pages.find((page) => page.url === "https://example.com/large");

    expect(large).toMatchObject({
      status: "failed",
      page_fetched: false,
      html_validation_status: "not_run",
      failure_code: "page_size_limit",
    });
  });
});
