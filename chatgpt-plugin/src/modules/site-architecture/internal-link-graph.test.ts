import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeInternalLinkGraph, emptyInternalLinkGraphReview,
} from "./internal-link-graph";
import { probeInternalLinkGraph } from "./internal-link-graph-probe";
import { PublicHttpProbeBudgetError } from "../../network";

const site = "https://example.com/";
const html = (body: string, head = "") =>
  "<html><head>" + head + "</head><body>" + body + "</body></html>";
const a = (path: string, attrs = "") => '<a href="' + path + '" ' + attrs + ">Link</a>";
const page = (path: string, body: string, extra: Record<string, unknown> = {}) =>
  ({ url: new URL(path, site).href, html: html(body), status_code: 200, ...extra });
const codes = (r: ReturnType<typeof analyzeInternalLinkGraph>) => r.findings.map((f) => f.code);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("V06 pure internal-link graph in hosted Worker", () => {
  it("counts navigation edges and sampled paths, not whole-site orphan verdicts", () => {
    const r = analyzeInternalLinkGraph({
      site_url: site,
      pages: [
        page("/", "<nav>" + a("/news") + a("/topics") + "</nav>"),
        page("/news", a("/deep")),
        page("/topics", a("/deep")),
        page("/deep", "<h1>Deep</h1>"),
        page("/isolated", "No sampled incoming"),
      ],
      sitemap_urls: [site, site + "news", site + "topics", site + "deep",
        site + "isolated", site + "not-sampled"],
    });
    expect(r.pages.map((p) => p.depth_from_entry)).toEqual([0, 1, 1, 2, null]);
    expect(r.unique_observed_sample_edges).toBe(4);
    expect(r.potential_orphans_within_sample).toBe(1);
    expect(r.sitemap_urls_without_page_sample).toBe(1);
    expect(codes(r)).toContain("possible_orphan_in_sample");
    expect(r.coverage_limited).toBe(true);
    expect(JSON.stringify(r)).not.toContain("not-sampled");
  });

  it("keeps hostile/query links redacted, nofollow-only paths unproven", () => {
    const r = analyzeInternalLinkGraph({
      site_url: site,
      pages: [
        page("/", a("/landing", 'rel="nofollow"') + a("/token?private=ABC")
          + a("javascript:alert(1)")),
        page("/landing", "<h1>Landing</h1>"),
      ],
    });
    expect(r.pages[1].depth_from_entry).toBeNull();
    expect(r.pages[1].incoming_sampled_sources).toBe(1);
    expect(r.unsafe_or_query_links_excluded).toBe(2);
    expect(codes(r)).toContain("nofollow_only_path");
    expect(JSON.stringify(r)).not.toContain("ABC");
    expect(emptyInternalLinkGraphReview().coverage_limited).toBe(true);
  });

  it("does not misclassify missing, blocked or partial page evidence as known orphan content", () => {
    const r = analyzeInternalLinkGraph({
      site_url: site,
      pages: [
        page("/", "<h1>Entry</h1>"),
        { url: site + "unseen" },
        { url: site + "blocked", status_code: 200, robots_allowed: false },
        { url: site + "partial", status_code: 206, html: html("Incomplete") },
      ],
    });
    expect(r.potential_orphans_within_sample).toBe(0);
    expect(r.pages[3].html_examined).toBe(false);
    expect(r.pages_unreachable_within_sample).toBe(3);
  });
});

describe("V06 hosted public robots-gated link-graph sampling", () => {
  it("charges each of one robots and three static page fetches", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(resource);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", {
        status: 200, headers: { "content-type": "text/plain" },
      });
      if (url === site) return new Response(html(
        "<nav>" + a("/a") + a("/b") + a("https://elsewhere.net/nope") + "</nav>",
      ), { status: 200, headers: { "content-type": "text/html" } });
      return new Response(html("<h1>Leaf</h1>"), {
        status: 200, headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", mock);
    let charged = 0;
    const r = await probeInternalLinkGraph(site, async () => { charged++; });
    expect(charged).toBe(4);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(r.scope).toBe("live_bounded_public_link_graph");
    expect(r.pages_observed).toBe(3);
    expect(r.pages_reachable_within_sample).toBe(3);
    expect(r.pages.map((p) => p.depth_from_entry)).toEqual([0, 1, 1]);
    expect(r.unique_observed_sample_edges).toBe(2);
    expect(JSON.stringify(r)).not.toContain("elsewhere.net");
    for (const [, init] of mock.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    }
  });

  it("does not fetch any page when robots disallows it", async () => {
    const mock = vi.fn(async () => new Response("User-agent: *\nDisallow: /\n", {
      status: 200, headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", mock);
    const r = await probeInternalLinkGraph(site);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(r.pages_observed).toBe(1);
    expect(r.html_pages_examined).toBe(0);
    expect(r.pages_reachable_within_sample).toBe(0);
    expect(r.pages[0].robots_access).toBe("disallowed");
    expect(codes(r)).toContain("entry_not_crawlable");
  });

  it("leaves robots unknown and fails closed when robots transport fails", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", mock);
    const r = await probeInternalLinkGraph(site);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(r.error).toContain("Robots.txt access");
    expect(r.pages[0].robots_access).toBe("unknown");
    expect(r.pages_reachable_within_sample).toBe(0);
  });

  it("preserves observed 404 target rather than labeling unseen pages broken", async () => {
    const mock = vi.fn(async (resource: RequestInfo | URL) => {
      const url = String(resource);
      if (url.endsWith("/robots.txt")) return new Response(null, { status: 404 });
      if (url === site) return new Response(html(a("/missing") + a("/unseen?secret=abc")),
        { headers: { "content-type": "text/html" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", mock);
    const r = await probeInternalLinkGraph(site);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(r.linked_http_error_pages).toBe(1);
    expect(r.pages[1].status_code).toBe(404);
    expect(r.pages[1].depth_from_entry).toBeNull();
    expect(JSON.stringify(r)).not.toContain("abc");
    expect(codes(r)).toContain("linked_to_http_error");
  });

  it("propagates per-request rate-budget denial and rejects unsafe entry URLs", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", mock);
    for (const unsafe of ["http://localhost/", "http://127.0.0.1/",
      "https://example.com/?token=secret", "file:///etc/passwd"]) {
      await expect(probeInternalLinkGraph(unsafe)).rejects.toThrow();
    }
    expect(mock).not.toHaveBeenCalled();
    await expect(probeInternalLinkGraph(site, async () => {
      if (mock.mock.calls.length > 0) throw new PublicHttpProbeBudgetError("budget");
    })).rejects.toThrow("budget");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
