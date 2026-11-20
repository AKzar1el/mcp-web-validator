import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeSitemapInventory, emptySitemapInventoryReview,
} from "./sitemap-inventory";
import { probeSitemapInventory } from "./sitemap-inventory-probe";
import { PublicHttpProbeBudgetError } from "../../network";

const site = "https://example.com/";
const ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
const urlset = (content: string) => '<urlset xmlns="' + ns + '">' + content + "</urlset>";
const index = (content: string) =>
  '<sitemapindex xmlns="' + ns + '">' + content + "</sitemapindex>";
const page = (path: string, date = "2026-11-20") =>
  "<url><loc>" + site + path + "</loc><lastmod>" + date + "</lastmod></url>";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("V05 shared bounded sitemap analyzer", () => {
  it("compares independently discovered pages with sitemap entries and indexability evidence", () => {
    const r = analyzeSitemapInventory({
      site_url: site, observed_at: "2026-11-20T10:00:00Z",
      documents_complete: true, discovered_complete: true,
      documents: [{ sitemap_url: site + "sitemap.xml", content: urlset(page("a") + page("b")) }],
      discovered_urls: [site + "a", site + "b"],
      page_observations: [
        { url: site + "a", status_code: 200, canonical_url: site + "a",
          noindex: false, robots_allowed: true },
        { url: site + "b", status_code: 200, canonical_url: site + "a",
          noindex: true, robots_allowed: false },
      ],
    });
    expect(r.inventory_complete).toBe(true);
    expect(r.distinct_page_urls).toBe(2);
    expect(r.discovered_in_sitemaps).toBe(2);
    expect(r.known_indexability_conflicts).toBe(1);
    expect(r.canonical_conflicts).toBe(1);
    expect(r.noindex_conflicts).toBe(1);
    expect(r.robots_conflicts).toBe(1);
    expect(JSON.stringify(r)).not.toContain(site + "b");
  });

  it(" rejects malformed XML DTD, URL secrets and false full-coverage claims", () => {
    const bad = analyzeSitemapInventory({
      site_url: site,
      documents: [{ sitemap_url: site + "sitemap.xml",
        content: "<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]><urlset>&secret;</urlset>" }],
    });
    expect(bad.documents[0].kind).toBe("invalid");
    expect(bad.inventory_complete).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("/etc/passwd");
    expect(() => analyzeSitemapInventory({
      site_url: site,
      documents: [{ sitemap_url: site + "sitemap.xml?secret=token", content: urlset(page("a")) }],
    })).toThrow();
    expect(emptySitemapInventoryReview().coverage_limited).toBe(true);
  });
});

describe("V05 hosted bounded live sitemap fetch", () => {
  it("fetches sitemap index and at most two same-origin children, per-request rate limited", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = String(resource);
      if (url.endsWith("/sitemap.xml")) {
        return new Response(index(
          "<sitemap><loc>" + site + "s1.xml</loc></sitemap>" +
          "<sitemap><loc>" + site + "s2.xml</loc></sitemap>" +
          "<sitemap><loc>" + site + "s3.xml</loc></sitemap>",
        ), { status: 200, headers: { "content-type": "application/xml" } });
      }
      return new Response(urlset(page(url.endsWith("/s1.xml") ? "a" : "b")), {
        status: 200, headers: { "content-type": "application/xml" },
      });
    });
    vi.stubGlobal("fetch", mock);
    let charged = 0;
    const r = await probeSitemapInventory(site, site + "sitemap.xml", async () => { charged++; });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(charged).toBe(3);
    expect(r.scope).toBe("live_public_sitemap_sample");
    expect(r.documents_observed).toBe(3);
    expect(r.distinct_page_urls).toBe(2);
    expect(r.missing_child_documents).toBe(1);
    expect(r.inventory_complete).toBe(false);
    for (const [, init] of mock.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    }
  });

  it("represents a failed child as incomplete, without synthesizing a healthy inventory", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL) =>
      String(resource).endsWith("/sitemap.xml")
        ? new Response(index("<sitemap><loc>" + site + "child.xml</loc></sitemap>"), {
          status: 200, headers: { "content-type": "text/xml" },
        })
        : new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", mock);
    const r = await probeSitemapInventory(site, site + "sitemap.xml");
    expect(r.documents_observed).toBe(2);
    expect(r.documents[1].status_code).toBe(503);
    expect(r.inventory_complete).toBe(false);
    expect(r.findings.some((f) => f.code === "sitemap_http_error")).toBe(true);
  });

  it("rejects unsafe URLs and reports an initial HTTP 503 instead of pretending it was readable", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", mock);
    for (const url of ["http://localhost/", "http://127.0.0.1/",
      "https://example.com/?token=hidden"]) {
      await expect(probeSitemapInventory(url)).rejects.toThrow();
    }
    expect(mock).not.toHaveBeenCalled();
    const r = await probeSitemapInventory(site, site + "sitemap.xml");
    expect(r.documents_observed).toBe(1);
    expect(r.documents[0].status_code).toBe(503);
    expect(r.inventory_complete).toBe(false);
    expect(r.findings.some((f) => f.code === "sitemap_http_error")).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("propagates rate budget failure before issuing another GET", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL) =>
      new Response(index("<sitemap><loc>" + site + "child.xml</loc></sitemap>"), {
        status: 200, headers: { "content-type": "application/xml" },
      }));
    vi.stubGlobal("fetch", mock);
    let charged = 0;
    await expect(probeSitemapInventory(site, site + "sitemap.xml", async () => {
      charged++;
      if (charged > 1) throw new PublicHttpProbeBudgetError("quota");
    })).rejects.toThrow("quota");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("discovers a safe robots.txt Sitemap directive and ignores off-site targets", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL) => {
      const url = String(resource);
      if (url.endsWith("/robots.txt")) return new Response(
        "User-agent: *\nAllow: /\nSitemap: https://external.example.com/wrong.xml\n"
        + "Sitemap: https://example.com/sitemap-index.xml\n",
        { status: 200, headers: { "content-type": "text/plain" } });
      return new Response(urlset(page("landing")), {
        status: 200, headers: { "content-type": "application/xml" },
      });
    });
    vi.stubGlobal("fetch", mock);
    const result = await probeSitemapInventory(site);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(String(mock.mock.calls[1][0])).toBe(site + "sitemap-index.xml");
    expect(result.distinct_page_urls).toBe(1);
    expect(result.inventory_complete).toBe(false);
  });
});
