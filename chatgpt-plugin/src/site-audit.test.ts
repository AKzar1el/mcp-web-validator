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

  it("accepts bare CR robots line endings", () => {
    const parsed = parseRobotsTxt([
      "User-agent: DigestSEO-Web-Validator",
      "Disallow: /private",
      "Sitemap: https://example.com/sitemap.xml",
    ].join("\r"), "https://example.com");

    expect(isAllowedByRobots(new URL("https://example.com/private"), parsed.rules)).toBe(false);
    expect(parsed.sitemapUrls.map((url) => url.href)).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("falls back to wildcard rules when only a prefix of the crawler product token is named", () => {
    const rules = parseRobotsTxt([
      "User-agent: DigestSEO",
      "Allow: /",
      "",
      "User-agent: *",
      "Disallow: /",
    ].join("\n"), "https://example.com");

    expect(isAllowedByRobots(new URL("https://example.com/private"), rules.rules)).toBe(false);
  });

  it("normalizes percent-encoded unreserved octets while preserving reserved encodings", () => {
    const rules = parseRobotsTxt([
      "User-agent: DigestSEO-Web-Validator",
      "Disallow: /foo/bar/%62%61%7A",
      "Disallow: /encoded-slash/%2Fprivate",
      "Disallow: /unicode/ツ",
    ].join("\n"), "https://example.com");

    expect(isAllowedByRobots(new URL("https://example.com/foo/bar/baz"), rules.rules)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/encoded-slash/%2Fprivate"), rules.rules)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/encoded-slash//private"), rules.rules)).toBe(true);
    expect(isAllowedByRobots(new URL("https://example.com/unicode/%E3%83%84"), rules.rules)).toBe(false);
  });

  it("uses normalized octet specificity when percent-encoded unreserved rules overlap", () => {
    const rules = parseRobotsTxt([
      "User-agent: DigestSEO-Web-Validator",
      "Disallow: /x/%61",
      "Allow: /x/ab",
    ].join("\n"), "https://example.com");

    // RFC 9309 decodes percent-encoded ASCII unreserved octets before
    // comparison, so /x/ab is the more-specific five-octet match.
    expect(isAllowedByRobots(new URL("https://example.com/x/abc"), rules.rules)).toBe(true);
  });
});

describe("auditPublicSite", () => {
  it("treats robots.txt 4xx responses as unavailable and continues with sitemap discovery", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") return new Response("forbidden", { status: 403 });
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/docs</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url === "https://example.com/docs") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "sitemap",
      pages_discovered: 2,
      pages_selected: 2,
      pages_audited: 2,
    });
    expect(result.discovery_error).toBeUndefined();
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/sitemap.xml")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/docs")).toBe(true);
  });

  it("discovers namespace-prefixed sitemap indexes and URL sets without consuming extension namespaces", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap-index.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap-index.xml") {
        return new Response([
          '<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:ext="https://example.com/extension">',
          "<sm:sitemap><sm:loc>https://example.com/child.xml</sm:loc></sm:sitemap>",
          "<ext:sitemap><ext:loc>https://example.com/ignored.xml</ext:loc></ext:sitemap>",
          "</sm:sitemapindex>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/child.xml") {
        return new Response([
          '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:ext="https://example.com/extension">',
          "<sm:url><sm:loc>https://example.com/</sm:loc></sm:url>",
          "<sm:url><sm:loc>https://example.com/docs</sm:loc></sm:url>",
          "<ext:url><ext:loc>https://example.com/ignored</ext:loc></ext:url>",
          "</sm:urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/docs") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "sitemap",
      sitemap_url: "https://example.com/sitemap-index.xml",
      pages_discovered: 2,
      pages_selected: 2,
      pages_audited: 2,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/child.xml")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/docs")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("ignored"))).toBe(false);
  });

  it.each([
    {
      name: "RSS 2.0",
      path: "/feed.rss",
      contentType: "application/rss+xml",
      body: [
        '<?xml version="1.0"?>',
        '<rss version="2.0"><channel>',
        '<item><link>https://example.com/docs</link></item>',
        '<item><link>https://attacker.example/outside</link></item>',
        '</channel></rss>',
      ].join(""),
    },
    {
      name: "Atom 1.0",
      path: "/feed.atom",
      contentType: "application/atom+xml",
      body: [
        '<?xml version="1.0"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        '<entry><link href="https://example.com/docs" /></entry>',
        '<entry><link href="http://127.0.0.1/private" /></entry>',
        '</feed>',
      ].join(""),
    },
    {
      name: "plain text",
      path: "/sitemap.txt",
      contentType: "text/plain",
      body: [
        "https://example.com/docs",
        "https://attacker.example/outside",
        "http://127.0.0.1/private",
      ].join("\n"),
    },
  ])("discovers same-origin pages from $name sitemap representations", async ({ path, contentType, body }) => {
    const sitemapUrl = `https://example.com${path}`;
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response(`User-agent: *\nSitemap: ${sitemapUrl}\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === sitemapUrl) return new Response(body, { headers: { "content-type": contentType } });
      if (url === "https://example.com/docs") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "sitemap",
      sitemap_url: sitemapUrl,
      pages_discovered: 2,
      pages_selected: 2,
      pages_audited: 2,
    });
    expect(result.discovery_error).toBeUndefined();
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/docs")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("attacker.example"))).toBe(false);
    expect(fetchMock.mock.calls.some(([target]) => String(target).startsWith("http://127.0.0.1"))).toBe(false);
  });
  it("treats robots.txt 5xx responses as unreachable and does not audit crawl candidates", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") return new Response("unavailable", { status: 503 });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "root_only",
      discovery_error: "robots_unavailable",
      pages_discovered: 1,
      pages_selected: 0,
      pages_audited: 0,
      pages_skipped_robots: 1,
    });
    expect(result.pages).toEqual([]);
    expect(fetchMock.mock.calls.some(([target]) => String(target).startsWith("https://html5.validator.nu/"))).toBe(false);
  });

  it("carries stable audit rule codes into page findings and site issue groups", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL) => {
        const url = String(target);
        if (url === "https://example.com/") {
          return htmlResponse("<!doctype html><html><head><title>A descriptive title for the focused audit test page</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1><img src='hero.png'></body></html>");
        }
        if (url === "https://example.com/robots.txt") {
          return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
        }
        if (url === "https://example.com/sitemap.xml") {
          return new Response("<urlset><url><loc>https://example.com/</loc></url></urlset>", {
            headers: { "content-type": "application/xml" },
          });
        }
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.pages[0]?.top_findings).toContainEqual(expect.objectContaining({ code: "accessibility.image_alt.missing" }));
    expect(result.issue_groups).toContainEqual(expect.objectContaining({ code: "accessibility.image_alt.missing" }));
  });

  it("keeps sitemap URLs that differ only by a trailing slash as distinct crawl targets", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response([
          "<urlset>",
          "<url><loc>https://example.com/docs</loc></url>",
          "<url><loc>https://example.com/docs/</loc></url>",
          "</urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/docs" || url === "https://example.com/docs/") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });

    expect(result.pages_discovered).toBe(3);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/docs",
      "https://example.com/docs/",
    ]);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/docs")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/docs/")).toBe(true);
  });

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
