import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeRedirectCanonicalChains, emptyRedirectCanonicalReview,
  canonicalHrefsFromLinkHeader,
} from "./redirect-canonical-chains";
import { probeRedirectCanonicalChain } from "./redirect-canonical-probe";
import { PublicHttpProbeBudgetError } from "../../network";

const site = "https://example.com/";
const hop = (path: string, status_code: number, more: Record<string, unknown> = {}) => ({
  url: new URL(path, site).href, status_code, ...more,
});
const codes = (r: ReturnType<typeof analyzeRedirectCanonicalChains>) =>
  r.findings.map((f) => f.code);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("V04 pure redirect/canonical analysis in Worker", () => {
  it("detects a completed 301 -> 200, self canonical and supplied expected destination", () => {
    const r = analyzeRedirectCanonicalChains({
      source_url: site, expected_destination: site + "final",
      observations: [
        hop("/", 301, { location: "/final" }),
        hop("/final", 200, { html: "<html><head><link rel='canonical' href='/final'></head></html>",
          x_robots_tag: [] }),
      ],
    });
    expect(r.chain_complete).toBe(true);
    expect(r.expected_destination_match).toBe(true);
    expect(r.hops[1].canonical_state).toBe("self");
    expect(r.destination_indexing_state).toBe("no_noindex_observed");
    expect(r.total_findings).toBe(0);
    expect(JSON.stringify(r)).not.toContain("/final");
  });

  it("distinguishes final noindex and a looping redirect with bounded messages", () => {
    const r = analyzeRedirectCanonicalChains({
      source_url: site,
      observations: [
        hop("/", 301, { location: "/end", canonicals: ["/end"] }),
        hop("/end", 200, {
          html: "<html><head><meta name='googlebot' content='noindex'></head></html>",
          x_robots_tag: [] }),
      ],
    });
    expect(r.nonindexable_destination).toBe(true);
    expect(codes(r)).toContain("redirect_destination_noindex");
    expect(codes(r)).toContain("canonical_to_noindex");
    const loop = analyzeRedirectCanonicalChains({
      source_url: site,
      observations: [hop("/", 301, { location: "/a" }),
        hop("/a", 302, { location: "/" })],
    });
    expect(loop.loop_detected).toBe(true);
    expect(loop.chain_complete).toBe(false);
    expect(codes(loop)).toContain("redirect_loop");
    expect(emptyRedirectCanonicalReview().coverage_limited).toBe(true);
  });

  it("keeps relative Link canonical extraction bounded and without raw URLs in output", () => {
    expect(canonicalHrefsFromLinkHeader(
      "<https://example.com/final>; rel='canonical', <https://example.com/no>; rel=alternate",
    )).toEqual(["https://example.com/final"]);
    const r = analyzeRedirectCanonicalChains({
      source_url: site,
      observations: [hop("/", 200, {
        canonicals: ["https://example.com/hidden-token"],
        html: "<html><head></head></html>", x_robots_tag: [],
      })],
    });
    expect(r.hops[0].canonical_state).toBe("unobserved");
    expect(JSON.stringify(r)).not.toContain("hidden-token");
  });

  it("uses a compact robots-meta view for a large bounded production HTML sample", () => {
    const big = "<html><head><meta name='googlebot' content='noindex'>"
      + "<script>" + "x".repeat(245_000) + "</script></head></html>";
    const r = analyzeRedirectCanonicalChains({
      source_url: site,
      observations: [hop("/", 200, { html: big, x_robots_tag: [] })],
    });
    expect(r.destination_indexing_state).toBe("explicit_noindex");
    expect(r.nonindexable_destination).toBe(true);
    expect(JSON.stringify(r)).not.toContain("xxxxxx");
  });
});

describe("V04 live same-origin HTTP+HTML probe in Worker", () => {
  it("charges for each 301, 200 and final HTML reread and returns redacted noindex", async () => {
    let n = 0;
    const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      n++;
      if (n === 1) return new Response(null, { status: 301,
        headers: { location: "/final" } });
      if (n === 2) return new Response(null, { status: 200,
        headers: { "content-type": "text/html" } });
      return new Response("<html><head><meta name='robots' content='noindex'></head></html>", {
        status: 200, headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", mock);
    let charged = 0;
    const r = await probeRedirectCanonicalChain(site, site + "final", async () => { charged++; });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(charged).toBe(3);
    expect(r.scope).toBe("live_public_redirect_probe");
    expect(r.chain_complete).toBe(true);
    expect(r.expected_destination_match).toBe(true);
    expect(r.nonindexable_destination).toBe(true);
    expect(r.destination_indexing_state).toBe("explicit_noindex");
    expect(codes(r)).toContain("redirect_destination_noindex");
    expect(JSON.stringify(r)).not.toContain(site);
    for (const [, init] of mock.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    }
  });

  it("never follows off-origin redirect or query-bearing target and avoids second HTML read", async () => {
    for (const redirect of [
      "https://outside.example.net/path?secret=raw",
      "/next?token=hidden",
    ]) {
      const mock = vi.fn(async () => new Response(null, {
        status: 301, headers: { location: redirect },
      }));
      vi.stubGlobal("fetch", mock);
      const r = await probeRedirectCanonicalChain(site);
      expect(mock).toHaveBeenCalledTimes(1);
      expect(r.chain_complete).toBe(false);
      expect(r.hops_observed).toBe(1);
      expect(JSON.stringify(r)).not.toContain("secret=raw");
      expect(JSON.stringify(r)).not.toContain("token=hidden");
    }
  });

  it("reports missing final HTML evidence without assuming clean indexing", async () => {
    let n = 0;
    const mock = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", mock);
    const r = await probeRedirectCanonicalChain(site);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(r.final_status_code).toBe(200);
    expect(r.destination_indexing_state).toBe("unknown");
    expect(r.error).toContain("unavailable");
  });

  it("propagates rate-budget denials instead of labeling them as 5xx or redirect failures", async () => {
    let count = 0;
    const mock = vi.fn(async () => new Response(null, {
      status: 301, headers: { location: "/final" },
    }));
    vi.stubGlobal("fetch", mock);
    await expect(probeRedirectCanonicalChain(site, undefined, async () => {
      count++;
      if (count >= 2) throw new PublicHttpProbeBudgetError("budget");
    })).rejects.toThrow("budget");
    expect(count).toBe(2);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not contact private URLs or credentials", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const bad of [
      "http://localhost/", "http://127.0.0.1/", "file:///etc/passwd",
      "https://user:password@example.com/", "https://example.com/?secret=xyz",
    ]) await expect(probeRedirectCanonicalChain(bad)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });
});
