import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPublicSite, isAllowedByRobots, parseRobotsTxt } from "./site-audit";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function htmlResponse(html = "<!doctype html><html lang='en'><head><title>Example page title for audit</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1></body></html>") {
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

  it("honors a named crawler product-token prefix instead of unrelated wildcard rules", () => {
    const rules = parseRobotsTxt([
      "User-agent: DIGESTSEO",
      "Disallow: /private",
      "",
      "User-agent: *",
      "Allow: /",
    ].join("\n"), "https://example.com");

    expect(isAllowedByRobots(new URL("https://example.com/private"), rules.rules)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/other"), rules.rules)).toBe(true);
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
  it("bounds adversarial wildcard robots matching while preserving standard wildcard semantics", () => {
    const pathological = "/" + "*a".repeat(13) + "z$";
    const adversarial = parseRobotsTxt(
      ["User-agent: DigestSEO-Web-Validator", "Disallow: " + pathological].join("\n"),
      "https://example.com",
    );
    const candidate = new URL("https://example.com/" + "a".repeat(26) + "x");
    expect(adversarial.rules).toHaveLength(1);
    const started = performance.now();
    expect(isAllowedByRobots(candidate, adversarial.rules)).toBe(true);
    expect(performance.now() - started).toBeLessThan(120);

    const ordinary = parseRobotsTxt(
      ["User-agent: DigestSEO-Web-Validator", "Disallow: /articles/*/draft$"].join("\n"),
      "https://example.com",
    );
    expect(isAllowedByRobots(new URL("https://example.com/articles/2026/draft"), ordinary.rules)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/articles/2026/drafts"), ordinary.rules)).toBe(true);
  });

  it("ranks percent-escaped UTF-8 robots rules by octets, not encoded characters", () => {
    const rules = parseRobotsTxt([
      "User-agent: DigestSEO-Web-Validator",
      "Disallow: /%E3%83%84*",
      "Allow: /*/open",
    ].join("\n"), "https://example.com");
    expect(isAllowedByRobots(new URL("https://example.com/%E3%83%84/open"), rules.rules)).toBe(true);
    expect(isAllowedByRobots(new URL("https://example.com/%E3%83%84/other"), rules.rules)).toBe(false);
  });
});

describe("auditPublicSite", () => {

  it("blocks sitemap-page redirects into robots-disallowed paths before the target GET", async () => {
    const visited: string[] = [];
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response([
          "<urlset>",
          "<url><loc>https://example.com/allowed</loc></url>",
          "<url><loc>https://example.com/public-redirect</loc></url>",
          "</urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/allowed") {
        return new Response(null, { status: 302, headers: { location: "/private" } });
      }
      if (url === "https://example.com/public-redirect") {
        return new Response(null, { status: 302, headers: { location: "/public-final" } });
      }
      if (url === "https://example.com/private" || url === "https://example.com/public-final") {
        return htmlResponse();
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch target: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });
    expect(result.pages.find((page) => page.url === "https://example.com/allowed")).toMatchObject({
      status: "skipped",
      page_fetched: false,
      failure_code: "robots_redirect_blocked",
    });
    expect(result.pages_skipped_robots).toBe(1);
    expect(visited).not.toContain("https://example.com/private");
    expect(result.pages.find((page) => page.url === "https://example.com/public-redirect")).toMatchObject({
      page_fetched: true,
      fetched_url: "https://example.com/public-final",
      redirects_followed: 1,
    });
    expect(visited).toContain("https://example.com/public-final");
  });

  it("reports a seed page X-Robots-Tag noindex directive in site SEO findings", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") {
        return new Response(
          "<!doctype html><html><head><title>Example page title for audit</title><meta name=description content='A useful description with enough characters to meet the normal metadata target for this focused test page.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1></body></html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-robots-tag": "noindex",
            },
          },
        );
      }
      if (url === "https://example.com/robots.txt" || url === "https://example.com/sitemap.xml") {
        return new Response("missing", { status: 404 });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });

    expect(result.pages[0]?.seo_warnings).toBeGreaterThanOrEqual(1);
    expect(result.issue_groups).toContainEqual(expect.objectContaining({
      code: "seo.robots.noindex",
      severity: "warning",
    }));
  });

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

  it("treats an empty successful robots.txt as an allow-all ruleset and continues with sitemap discovery", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("\n\t\n", { headers: { "content-type": "text/plain" } });
      }
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


  it("discovers same-origin pages through a robots-advertised gzip sitemap", async () => {
    const xml = "<urlset><url><loc>https://example.com/gzip-page</loc></url></urlset>";
    const compressed = await new Response(
      new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: https://example.com/map.xml.gz\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/map.xml.gz") {
        return new Response(compressed, { headers: { "content-type": "application/gzip" } });
      }
      if (url === "https://example.com/gzip-page") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "sitemap", pages_discovered: 2, pages_audited: 2 });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/map.xml.gz")).toBe(true);
  });

  it("discovers gzip child sitemaps without leaving the origin", async () => {
    const xml = "<urlset><url><loc>https://example.com/child-page</loc></url></urlset>";
    const compressed = await new Response(
      new Blob([xml]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: https://example.com/index.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/index.xml") {
        return new Response("<sitemapindex><sitemap><loc>https://example.com/child.xml.gz</loc></sitemap><sitemap><loc>http://127.0.0.1/bad.xml.gz</loc></sitemap></sitemapindex>",
          { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/child.xml.gz") {
        return new Response(compressed, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url === "https://example.com/child-page") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "sitemap", pages_discovered: 2, pages_audited: 2 });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/child.xml.gz")).toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target).startsWith("http://127.0.0.1"))).toBe(false);
  });

  it("fails closed on gzip sitemap expansion over the existing one-megabyte limit", async () => {
    const oversizedXml = "<urlset>" + " ".repeat(1024 * 1024 + 16) + "</urlset>";
    const compressed = await new Response(
      new Blob([oversizedXml]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: https://example.com/oversized.xml.gz\n",
          { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/oversized.xml.gz") {
        return new Response(compressed, { headers: { "content-type": "application/gzip" } });
      }
      throw new Error("Unexpected URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "root_only", discovery_error: "sitemap_unavailable", pages_discovered: 1 });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/oversized.xml.gz")).toBe(true);
  });

  it("reports unsupported XML roots and malformed text sitemap entries instead of silently completing discovery", async () => {
    for (const [path, body, contentType] of [
      ["/unsupported.xml", "<other><url><loc>https://example.com/private</loc></url></other>", "application/xml"],
      ["/broken.txt", "This is not a URL sitemap\n<html>not a URL</html>", "text/plain"],
    ]) {
      const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
        const url = String(target);
        if (url === "https://example.com/") return htmlResponse();
        if (url === "https://example.com/robots.txt") {
          return new Response(`User-agent: *\nSitemap: ${path}\n`, { headers: { "content-type": "text/plain" } });
        }
        if (url === `https://example.com${path}`) return new Response(body, { headers: { "content-type": contentType } });
        if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
        throw new Error(`Unexpected URL: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });
      expect(result).toMatchObject({ discovery: "root_only", discovery_error: "sitemap_invalid", pages_discovered: 1 });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["missing root end tag", "<urlset><url><loc>https://example.com/hidden</loc></url>"],
    ["missing URL end tag", "<urlset><url><loc>https://example.com/hidden</loc></urlset>"],
    ["mismatched closing tags", "<urlset><url><loc>https://example.com/hidden</url></loc></urlset>"],
    ["multiple document elements", "<urlset></urlset><urlset><url><loc>https://example.com/hidden</loc></url></urlset>"],
    ["unclosed quoted attribute", '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["raw angle bracket in double-quoted attribute", '<urlset label="a < b"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["raw angle bracket in single-quoted attribute", "<urlset label='a < b'><url><loc>https://example.com/hidden</loc></url></urlset>"],
    ["CDATA close delimiter in ordinary text", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>bad]]>date</lastmod></url></urlset>"],
    ["CDATA close delimiter at end of ordinary text", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>bad]]></lastmod></url></urlset>"],
    ["XML declaration after the document root", '<urlset><url><loc>https://example.com/hidden</loc></url></urlset><?xml version="1.0"?>'],
    ["XML declaration inside the document root", '<urlset><?xml version="1.0"?><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration after a leading comment", '<!-- comment --><?xml version="1.0"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration after leading whitespace", ' \n<?xml version="1.0"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["mixed-case reserved XML processing instruction target", '<?XmL version="1.0"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration missing version", '<?xml?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration with encoding but no version", '<?xml encoding="UTF-8"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration with invalid standalone value", '<?xml version="1.0" standalone="maybe"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["XML declaration with invalid pseudo-attribute order", '<?xml encoding="UTF-8" version="1.0"?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["empty processing instruction target", '<??><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["processing instruction target preceded by whitespace", '<? xml-stylesheet?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["processing instruction target starting with a digit", '<?1invalid?><urlset><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["undeclared child element prefix", '<urlset><bad:meta/><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["undeclared root attribute prefix", '<urlset bad:label="x"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["namespace declaration leaked to sibling", '<urlset><url xmlns:ext="urn:extension"><ext:meta/></url><url><ext:meta/><loc>https://example.com/hidden</loc></url></urlset>'],
    ["empty namespace binding for a prefix", '<urlset xmlns:ext=""><ext:meta/><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["reserved xml prefix rebound", '<urlset xmlns:xml="urn:not-xml"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["reserved xmlns prefix declared", '<urlset xmlns:xmlns="urn:extension"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["namespace declaration with invalid prefix name", '<urlset xmlns:1ext="urn:extension"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["qualified element with invalid local name", '<urlset xmlns:ext="urn:extension"><ext:1invalid/><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["qualified element with multiple colons", '<urlset xmlns:ext="urn:extension"><ext:too:many/><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["text after document root", "<urlset></urlset>garbage"],
    ["raw ampersand in text", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>a & b</lastmod></url></urlset>"],
    ["undeclared entity in text", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>&bogus;</lastmod></url></urlset>"],
    ["invalid numeric character reference", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>&#0;</lastmod></url></urlset>"],
    ["surrogate character reference", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>&#xD800;</lastmod></url></urlset>"],
    ["out-of-range character reference", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>&#x110000;</lastmod></url></urlset>"],
    ["raw ampersand in attribute", '<urlset label="a & b"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["undeclared entity in attribute", '<urlset label="&bogus;"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["invalid character reference in attribute", '<urlset label="&#x0;"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["unterminated entity reference", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>&amp</lastmod></url></urlset>"],
    ["raw NUL in text", "<urlset><url><loc>https://example.com/hidden</loc><lastmod>bad\u0000date</lastmod></url></urlset>"],
    ["raw control in attribute", '<urlset label="bad\u0001value"><url><loc>https://example.com/hidden</loc></url></urlset>'],
    ["raw control in CDATA", "<urlset><url><loc>https://example.com/hidden</loc><lastmod><![CDATA[bad\u000Bdate]]></lastmod></url></urlset>"],
    ["invalid XML noncharacter in comment", "<urlset><!-- bad\uFFFEcomment --><url><loc>https://example.com/hidden</loc></url></urlset>"],
  ])("rejects malformed XML sitemap: %s", async (_name, sitemapBody) => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /map.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/map.xml") {
        return new Response(sitemapBody, { headers: { "content-type": "application/xml" } });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "root_only", discovery_error: "sitemap_invalid", pages_discovered: 1 });
    expect(result.pages.map((page) => page.url)).not.toContain("https://example.com/hidden");
  });

  it.each([
    ["predefined entities", '<urlset label="Fish &amp; Chips"><url><loc>https://example.com/allowed</loc><lastmod>&lt;&gt;&quot;&apos;</lastmod></url></urlset>'],
    ["escaped angle bracket in attribute", '<urlset label="a &lt; b"><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["valid numeric entities", '<urlset label="&#65;&#xA;"><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["literal ampersands in CDATA and comments", '<urlset><!-- &bogus; --><url><loc>https://example.com/allowed</loc><lastmod><![CDATA[&bogus;]]></lastmod></url></urlset>'],
    ["CDATA close delimiter ending a CDATA section", '<urlset><url><loc>https://example.com/allowed</loc><lastmod><![CDATA[valid]]>tail</lastmod></url></urlset>'],
    ["initial XML declaration", '<?xml version="1.0"?><urlset><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["initial XML declaration with encoding and standalone", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><urlset><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["initial XML declaration after a BOM", '\uFEFF<?xml version="1.0"?><urlset><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["ordinary stylesheet processing instruction", '<?xml-stylesheet type="text/xsl" href="style.xsl"?><urlset><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["declared extension prefix on root", '<urlset xmlns:ext="urn:extension"><ext:meta/><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["declared extension prefix on child", '<urlset><url xmlns:ext="urn:extension"><ext:meta/><loc>https://example.com/allowed</loc></url></urlset>'],
    ["built-in xml prefix on attribute", '<urlset xml:lang="en"><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["default sitemap namespace", '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/allowed</loc></url></urlset>'],
    ["legal XML whitespace and supplementary characters", "<urlset label=\"tab\tnewline\n\"><url><loc>https://example.com/allowed</loc><lastmod>ok\r\u{1F680}</lastmod></url></urlset>"],
  ])("accepts well-formed XML sitemap: %s", async (_name, sitemapBody) => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /map.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/map.xml") {
        return new Response(sitemapBody, { headers: { "content-type": "application/xml" } });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "sitemap", pages_discovered: 2 });
  });

  it("does not silently fetch a different sitemap when robots advertises a query-bearing source", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: https://example.com/map.xml?token=private\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/map.xml") {
        return new Response("<urlset><url><loc>https://example.com/wrong</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 2, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "root_only", discovery_error: "sitemap_query_unsupported", pages_discovered: 1 });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "https://example.com/map.xml")).toBe(false);
  });

  it("omits query-bearing sitemap pages while reporting incomplete coverage", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /map.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/map.xml") {
        return new Response([
          "<urlset>",
          "<url><loc>https://example.com/filtered?view=private</loc></url>",
          "<url><loc>https://example.com/allowed</loc></url>",
          "</urlset>",
        ].join(""), { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/" || url === "https://example.com/allowed") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });
    expect(result).toMatchObject({ discovery: "partial", discovery_error: "sitemap_query_unsupported", pages_discovered: 2, pages_audited: 2 });
    expect(result.pages.map((page) => page.url)).not.toContain("https://example.com/filtered");
  });

  it.each([
    {
      format: "plaintext page entries",
      contentType: "text/plain",
      body: "https://example.com/allowed\nhttps://example.com/filtered?token=private\n",
      discovery: "partial",
      discovered: 2,
    },
    {
      format: "nested sitemap sources",
      contentType: "application/xml",
      body: "<sitemapindex><sitemap><loc>https://example.com/child.xml?token=private</loc></sitemap></sitemapindex>",
      discovery: "root_only",
      discovered: 1,
    },
  ])("does not silently rewrite query-bearing $format", async ({ contentType, body, discovery, discovered }) => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /map.txt\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/map.txt") {
        return new Response(body, { headers: { "content-type": contentType } });
      }
      if (url === "https://example.com/" || url === "https://example.com/allowed") return htmlResponse();
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 3, pageOffset: 0 });
    expect(result).toMatchObject({ discovery, discovery_error: "sitemap_query_unsupported", pages_discovered: discovered });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/filtered") || String(url).includes("/child.xml"))).toBe(false);
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
  it.each([
    { name: "global disallow", status: 200, body: "User-agent: *\nDisallow: /\n" },
    { name: "rate limited robots", status: 429, body: "rate limited" },
    { name: "unavailable robots", status: 503, body: "unavailable" },
  ])("never requests the seed page before checking $name", async ({ status, body }) => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      requested.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response(body, { status, headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
      }
      throw new Error("Unexpected fetch target: " + url);
    }));
    const result = await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 });
    expect(requested[0]).toBe("https://example.com/robots.txt");
    expect(requested).not.toContain("https://example.com/");
    expect(result.pages_selected).toBe(0);
    expect(result.pages_skipped_robots).toBe(1);
  });

  it("checks a cross-origin seed redirect target's robots before fetching its HTML", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      requested.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml" || url === "https://www.example.com/sitemap.xml") {
        return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/") {
        return new Response(null, { status: 301, headers: { location: "https://www.example.com/" } });
      }
      if (url === "https://www.example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://www.example.com/") return htmlResponse();
      throw new Error("Unexpected fetch target: " + url);
    }));
    await auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 0 }).catch(() => undefined);
    expect(requested).toContain("https://www.example.com/robots.txt");
    expect(requested).not.toContain("https://www.example.com/");
  });
  it("never follows an initial seed redirect to a robots-disallowed path", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      requested.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/public") {
        return new Response(null, { status: 302, headers: { location: "/private" } });
      }
      if (url === "https://example.com/private") return htmlResponse();
      throw new Error("Unexpected fetch target: " + url);
    }));
    await auditPublicSite({ siteUrl: "https://example.com/public", maxPages: 1, pageOffset: 0 })
      .catch(() => undefined);
    expect(requested[0]).toBe("https://example.com/robots.txt");
    expect(requested).not.toContain("https://example.com/private");
  });
  it.each([
    { name: "transport failure", error: new TypeError("fetch failed") },
    { name: "aborted fetch", error: new DOMException("network timeout", "AbortError") },
  ])("treats robots.txt $name as unreachable without auditing crawl candidates", async ({ error }) => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") throw error;
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch target: " + url);
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
  it.each([429, 503])("treats robots.txt %i responses as unreachable and does not audit crawl candidates", async (status) => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") return htmlResponse();
      if (url === "https://example.com/robots.txt") return new Response("unavailable", { status });
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
    let sitemapChanged = false;
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
          ...(sitemapChanged ? ["<url><loc>https://example.com/new-page</loc></url>"] : []),
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
      discovery_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      audit_health_score: expect.any(Number),
      score_coverage_percent: 100,
    });
    expect(result.pages).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("/blocked"))).toBe(false);
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("attacker.example"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    await expect(auditPublicSite({ siteUrl: "https://example.com/", maxPages: 1, pageOffset: 1 }))
      .rejects.toThrow("Stale site audit continuation");
    const continuation = await auditPublicSite({
      siteUrl: "https://example.com/", maxPages: 1, pageOffset: 1,
      expectedDiscoveryFingerprint: result.discovery_fingerprint,
    });
    expect(continuation.pages[0]?.url).toBe("https://example.com/allowed");
    sitemapChanged = true;
    await expect(auditPublicSite({
      siteUrl: "https://example.com/", maxPages: 1, pageOffset: 1,
      expectedDiscoveryFingerprint: result.discovery_fingerprint,
    })).rejects.toThrow("Stale site audit continuation");
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/new-page")).toBe(false);
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
