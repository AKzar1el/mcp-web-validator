import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeCrawlerAccess, isAllowedForFetcher, emptyCrawlerAccessReview,
} from "./crawler-access";
import { probeCrawlerAccess } from "./crawler-access-probe";
import { PublicHttpProbeBudgetError } from "../../network";

const site = "https://example.com/";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("V03 shared crawler matrix in hosted Worker", () => {
  it("respects longest-specific robots groups with Googlebot desktop and smartphone parity", () => {
    const result = analyzeCrawlerAccess({
      site_url: site,
      robots_txt: [
        "User-agent: *", "Disallow: /all",
        "User-agent: Googlebot", "Disallow: /private",
        "User-agent: Googlebot-News", "Allow: /private",
      ].join("\n"),
      pages: [{ url: site + "private", status_code: 200,
        html: "<meta name='googlebot' content='noindex'>", x_robots_tag: [] }],
      profiles: ["googlebot-smartphone", "googlebot-desktop", "googlebot-news", "bingbot"],
    });
    expect(result.rows_checked).toBe(4);
    expect(result.rows[0].robots_access).toBe("disallowed");
    expect(result.rows[1].robots_access).toBe("disallowed");
    expect(result.rows[2].robots_access).toBe("allowed");
    expect(result.rows[3].robots_access).toBe("allowed");
    expect(result.rows[0].indexing_state).toBe("explicit_noindex");
    expect(result.rows[2].indexing_state).toBe("no_noindex_observed");
    expect(result.coverage_limited).toBe(true);
  });

  it("handles ambiguous folded header scopes and insufficient page evidence", () => {
    expect(() => analyzeCrawlerAccess({
      site_url: site, robots_txt: "",
      pages: [{ url: site + "path?secret=foo" }],
    })).toThrow();
    const result = analyzeCrawlerAccess({
      site_url: site, robots_txt: "",
      pages: [{ url: site + "path", x_robots_tag: ["bingbot: noindex, noindex"] }],
      profiles: ["googlebot-smartphone"],
    });
    expect(result.scope_ambiguous_rows).toBe(1);
    expect(result.rows[0].indexing_state).toBe("unknown");
  });
});

describe("V03 hosted live public crawler probe", () => {
  it("fetches robots and an allowed page using only the service User-Agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /private", {
          status: 200, headers: { "content-type": "text/plain" },
        });
      }
      return new Response("<html><head><meta name='robots' content='noindex'></head><body>hello</body></html>", {
        status: 200, headers: { "content-type": "text/html", "x-robots-tag": "googlebot: noindex" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    let charges = 0;
    const result = await probeCrawlerAccess(site + "private", undefined, async () => {
      charges++;
    });
    expect(charges).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.scope).toBe("live_public_crawler_probe");
    expect(result.rows_checked).toBe(6);
    expect(result.noindex_declared_rows).toBe(6);
    expect(result.rows.find((r) => r.profile === "gptbot")?.robots_access).toBe("disallowed");
    expect(result.rows.find((r) => r.profile === "bingbot")?.robots_access).toBe("allowed");
    expect(result.rows.find((r) => r.profile === "googlebot-smartphone")?.indexing_source).toBe("both");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      expect(String(options?.headers && (options.headers as Record<string,string>)["user-agent"]))
        .toContain("DigestSEO");
    }
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("does not fetch HTML when the site's rules disallow our own service user agent", async () => {
    const fetchMock = vi.fn(async () => new Response("User-agent: DigestSEO-Web-Validator\nDisallow: /\n", {
      status: 200, headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeCrawlerAccess(site + "private");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.rows.every((r) => r.static_html_examined === false)).toBe(true);
    expect(result.unknown_indexing_rows).toBe(6);
  });

  it("treats a robots 503 as unknown and never fetches page HTML", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeCrawlerAccess(site + "important");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.robots_status_code).toBe(503);
    expect(result.unknown_access_rows).toBe(6);
    expect(result.rows.every((r) => r.indexing_state === "unknown")).toBe(true);
  });

  it("uses documented 404 robots fallback and samples the public page", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/robots.txt")
        ? new Response(null, { status: 404 })
        : new Response("<html><head></head><body>ok</body></html>", {
          status: 200, headers: { "content-type": "text/html" },
        }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeCrawlerAccess(site + "open");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.rows.every((r) => r.robots_access === "allowed")).toBe(true);
    expect(result.rows.every((r) => r.indexing_state === "no_noindex_observed")).toBe(true);
  });

  it("charges one rate token before every attempted HTTP request and fails closed", async () => {
    const fetchMock = vi.fn(async () => new Response("User-agent: *\nAllow: /", {
      status: 200, headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let charged = 0;
    await expect(probeCrawlerAccess(site + "test", undefined, async () => {
      charged++;
      if (charged > 1) throw new PublicHttpProbeBudgetError("quota");
    })).rejects.toThrow();
    expect(charged).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects internal URLs and credentials without network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of [
      "http://localhost/", "http://127.0.0.1/", "file:///private",
      "https://example.com/?access_token=hidden",
      "https://user:password@example.com/",
    ]) await expect(probeCrawlerAccess(bad)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAllowedForFetcher("User-agent: *\nDisallow: /", site)).toBe(false);
    expect(emptyCrawlerAccessReview().coverage_limited).toBe(true);
  });
});
