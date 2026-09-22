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
  it("follows five same-origin redirects when fetching robots.txt", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response(null, { status: 302, headers: { location: "/robots-1.txt" } });
      }
      if (url === "https://example.com/robots-1.txt") {
        return new Response(null, { status: 302, headers: { location: "/robots-2.txt" } });
      }
      if (url === "https://example.com/robots-2.txt") {
        return new Response(null, { status: 302, headers: { location: "/robots-3.txt" } });
      }
      if (url === "https://example.com/robots-3.txt") {
        return new Response(null, { status: 302, headers: { location: "/robots-4.txt" } });
      }
      if (url === "https://example.com/robots-4.txt") {
        return new Response(null, { status: 302, headers: { location: "/robots-5.txt" } });
      }
      if (url === "https://example.com/robots-5.txt") {
        return new Response("User-agent: *\nSitemap: /feed.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/feed.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/docs</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url === "https://example.com/sitemap.xml") return new Response("missing", { status: 404 });
      if (url === "https://example.com/docs") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "sitemap",
      sitemap_url: "https://example.com/feed.xml",
      pages_discovered: 2,
      pages_selected: 2,
      pages_audited: 2,
    });
  });

  it("follows a public cross-authority robots redirect while applying rules to the initial authority", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://robots.example.net/policy.txt" },
        });
      }
      if (url === "https://robots.example.net/policy.txt") {
        return new Response("User-agent: *\nDisallow: /blocked\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response([
          "<urlset>",
          "<url><loc>https://example.com/</loc></url>",
          "<url><loc>https://example.com/allowed</loc></url>",
          "<url><loc>https://example.com/blocked</loc></url>",
          "</urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/allowed") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });

    expect(result).toMatchObject({
      discovery: "sitemap",
      sitemap_url: "https://example.com/sitemap.xml",
      pages_discovered: 3,
      pages_selected: 2,
      pages_audited: 2,
      pages_skipped_robots: 1,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://robots.example.net/policy.txt")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/sitemap.xml")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/blocked")).toBe(false);
  });

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
      name: "prefixed Atom 1.0",
      path: "/feed-prefixed.atom",
      contentType: "application/atom+xml",
      body: [
        '<?xml version="1.0"?>',
        '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">',
        '<atom:entry><atom:link href="https://example.com/docs" /></atom:entry>',
        '<atom:entry><atom:link href="http://127.0.0.1/private" /></atom:entry>',
        '</atom:feed>',
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

  it("groups the same stable schema rule across pages despite instance-specific block numbers", async () => {
    const firstPage = "<!doctype html><html><head><title>First page with a descriptive title for testing</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'><script type='application/ld+json'>{not json}</script></head><body><h1>First</h1></body></html>";
    const secondPage = "<!doctype html><html><head><title>Second page with a descriptive title for testing</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/second'><script type='application/ld+json'>{\"@context\":\"https://schema.org\"}</script><script type='application/ld+json'>{not json}</script></head><body><h1>Second</h1></body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: RequestInfo | URL) => {
        const url = String(target);
        if (url === "https://example.com/") return htmlResponse(firstPage);
        if (url === "https://example.com/second") return htmlResponse(secondPage);
        if (url === "https://example.com/robots.txt") {
          return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
        }
        if (url === "https://example.com/sitemap.xml") {
          return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/second</loc></url></urlset>", {
            headers: { "content-type": "application/xml" },
          });
        }
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    const invalidJsonGroups = result.issue_groups.filter((group) => group.code === "schema.jsonld.invalid_json");

    expect(result.pages[0]?.top_findings).toContainEqual(expect.objectContaining({
      code: "schema.jsonld.invalid_json",
      message: "JSON-LD block #1 is not valid JSON.",
    }));
    expect(result.pages[1]?.top_findings).toContainEqual(expect.objectContaining({
      code: "schema.jsonld.invalid_json",
      message: "JSON-LD block #2 is not valid JSON.",
    }));
    expect(invalidJsonGroups).toHaveLength(1);
    expect(invalidJsonGroups[0]).toMatchObject({
      code: "schema.jsonld.invalid_json",
      message: "A JSON-LD block is not valid JSON.",
      affected_pages: 2,
      example_urls: ["https://example.com/", "https://example.com/second"],
    });
  });

  it("prioritizes later errors over earlier warnings when issue groups hit the cap", async () => {
    const nuMessages = [
      ...Array.from({ length: 50 }, (_, index) => ({ type: "warning", message: `Warning ${index + 1}` })),
      { type: "error", message: "Late critical error" },
    ];
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
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: nuMessages });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.issue_groups).toHaveLength(50);
    expect(result.issue_groups.filter((group) => group.severity === "error")).toHaveLength(1);
    expect(result.issue_groups.filter((group) => group.severity === "warning")).toHaveLength(49);
    expect(result.issue_groups).toContainEqual(expect.objectContaining({
      severity: "error",
      category: "HTML",
      message: "Late critical error",
    }));
    expect(result.issue_groups_truncated).toBe(true);
  });

  it("marks site issue groups truncated when page diagnostics were capped before grouping", async () => {
    const nuMessages = [
      ...Array.from({ length: 200 }, () => ({ type: "error", message: "Repeated diagnostic" })),
      ...Array.from({ length: 5 }, (_, index) => ({ type: "error", message: `Hidden diagnostic ${index + 1}` })),
    ];
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
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: nuMessages });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.pages[0]?.html_errors).toBe(205);
    expect(result.issue_groups).toContainEqual(expect.objectContaining({ message: "Repeated diagnostic" }));
    expect(result.issue_groups).not.toContainEqual(expect.objectContaining({ message: "Hidden diagnostic 1" }));
    expect(result.issue_groups_truncated).toBe(true);
  });

  it("does not mark issue groups truncated when only informational diagnostics were capped", async () => {
    const nuMessages = Array.from({ length: 205 }, (_, index) => ({
      type: "info",
      message: `Informational diagnostic ${index + 1}`,
    }));
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
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: nuMessages });
        throw new Error(`Unexpected fetch target: ${url}`);
      }),
    );

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.pages[0]?.notes).toBeGreaterThanOrEqual(205);
    expect(result.issue_groups_truncated).toBe(false);
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
