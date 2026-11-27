import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPublicSite } from "./site-audit";

const origin = "https://example.com";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockDiscovery(robots: string, sitemapBodies: Record<string, string>, lastPage: string) {
  const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
    const url = String(target);
    if (url === origin + "/robots.txt") {
      return new Response(robots, { headers: { "content-type": "text/plain" } });
    }
    if (url.startsWith("https://html5.validator.nu/")) {
      return Response.json({ messages: [] });
    }
    const pathname = new URL(url).pathname;
    if (url.startsWith(origin + "/") && Object.hasOwn(sitemapBodies, pathname)) {
      return new Response(sitemapBodies[pathname], { headers: { "content-type": "application/xml" } });
    }
    if (url === origin + "/" || url === origin + lastPage) {
      return new Response("<!doctype html><html lang='en'><head><title>Audit fixture</title></head><body><h1>Fixture</h1></body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function finalAuditPage(lastOffset: number) {
  const first = await auditPublicSite({ siteUrl: origin + "/", maxPages: 1, pageOffset: 0 });
  return auditPublicSite({
    siteUrl: origin + "/",
    maxPages: 1,
    pageOffset: lastOffset,
    expectedDiscoveryFingerprint: first.discovery_fingerprint,
  });
}

describe("sitemap discovery capacity counts only distinct entries", () => {
  it.each([
    { name: "no extra URL", extra: "", expectedTruncated: false },
    { name: "duplicate URL at exactly 250", extra: "/p/1", expectedTruncated: false },
    { name: "new 251st URL", extra: "/p/250", expectedTruncated: true },
  ])("page URL capacity: $name", async ({ extra, expectedTruncated }) => {
    const pages = Array.from({ length: 250 }, (_, index) =>
      `<url><loc>${origin}/${index === 0 ? "" : `p/${index}`}</loc></url>`).join("");
    const extraEntry = extra ? `<url><loc>${origin}${extra}</loc></url>` : "";
    mockDiscovery(
      "User-agent: *\nSitemap: /index.xml\n",
      {
        "/index.xml": `<sitemapindex><sitemap><loc>${origin}/a.xml</loc></sitemap><sitemap><loc>${origin}/b.xml</loc></sitemap></sitemapindex>`,
        "/a.xml": `<urlset>${pages}</urlset>`,
        "/b.xml": `<urlset>${extraEntry}</urlset>`,
      },
      "/p/249",
    );
    const result = await finalAuditPage(249);
    expect(result).toMatchObject({
      pages_discovered: 250,
      pages_audited: 1,
      truncated: expectedTruncated,
    });
  });

  it.each([
    { name: "no extra sitemap", extra: "", expectedTruncated: false },
    { name: "duplicate child already queued", extra: "a", expectedTruncated: false },
    { name: "duplicate parent already visited", extra: "first", expectedTruncated: false },
    { name: "genuine fifth sitemap", extra: "c", expectedTruncated: true },
  ])("sitemap count capacity: $name", async ({ extra, expectedTruncated }) => {
    const child = (name: string) => `<sitemap><loc>${origin}/${name}.xml</loc></sitemap>`;
    const fetchMock = mockDiscovery(
      "User-agent: *\nSitemap: /first.xml\nSitemap: /second.xml\n",
      {
        "/first.xml": `<sitemapindex>${child("a")}${child("b")}</sitemapindex>`,
        "/second.xml": `<sitemapindex>${extra ? child(extra) : ""}</sitemapindex>`,
        "/a.xml": `<urlset><url><loc>${origin}/</loc></url></urlset>`,
        "/b.xml": `<urlset><url><loc>${origin}/docs</loc></url></urlset>`,
      },
      "/docs",
    );
    const result = await finalAuditPage(1);
    expect(result).toMatchObject({
      pages_discovered: 2,
      pages_audited: 1,
      truncated: expectedTruncated,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === origin + "/c.xml")).toBe(false);
  });

  it.each([
    { name: "empty nested index", extra: "", expectedTruncated: false },
    { name: "nested index points back to visited root", extra: "root", expectedTruncated: false },
    { name: "nested index repeats queued sibling", extra: "b", expectedTruncated: false },
    { name: "nested index includes unvisited grandchild", extra: "grandchild", expectedTruncated: true },
  ])("nested sitemap traversal: $name", async ({ extra, expectedTruncated }) => {
    const child = extra ? `<sitemap><loc>${origin}/${extra}.xml</loc></sitemap>` : "";
    const fetchMock = mockDiscovery(
      "User-agent: *\nSitemap: /root.xml\n",
      {
        "/root.xml": `<sitemapindex><sitemap><loc>${origin}/a.xml</loc></sitemap><sitemap><loc>${origin}/b.xml</loc></sitemap></sitemapindex>`,
        "/a.xml": `<sitemapindex>${child}</sitemapindex>`,
        "/b.xml": `<urlset><url><loc>${origin}/</loc></url></urlset>`,
      },
      "/",
    );
    const result = await finalAuditPage(0);
    expect(result).toMatchObject({
      pages_discovered: 1,
      pages_audited: 1,
      truncated: expectedTruncated,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === origin + "/grandchild.xml")).toBe(false);
  });
});
