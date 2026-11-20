import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeHttpDelivery, deliveryResponseHeaders, emptyDeliveryReview,
} from "./http-delivery";
import { probePublicHttp } from "../../network";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("V01 HTTP delivery analyzer in Worker runtime", () => {
  const url = "https://example.com/";
  it("classifies edge challenge, rate-limit and cache signals without raw header values", () => {
    const review = analyzeHttpDelivery([{
      url, status_code: 429, headers: {
        "cf-mitigated": "challenge", "cf-ray": "private-cloudflare-token",
        "retry-after": "15", "cache-control": "no-store, private",
        "cf-cache-status": "BYPASS",
      },
    }]);
    expect(review.hops_observed).toBe(1);
    expect(review.errors_observed).toBe(1);
    expect(review.challenges_observed).toBe(1);
    expect(review.hops[0]).toMatchObject({
      status: "rate_limited", cf_challenge: true,
      cache_state: "bypass", retry_after_present: true,
      retry_after_seconds: 15, cache_no_store: true, cache_private: true,
    });
    expect(JSON.stringify(review)).not.toContain("private-cloudflare-token");
    expect(emptyDeliveryReview().coverage_limited).toBe(true);
  });

  it("reports mismatching redirect and leaves secret location unexposed", () => {
    const review = analyzeHttpDelivery([
      { url, status_code: 302, headers: { location: "/next?apikey=private" } },
      { url: "https://example.com/other", status_code: 200 },
    ]);
    expect(review.redirect_chain_complete).toBe(false);
    expect(review.redirects_observed).toBe(0);
    expect(review.findings.map((f) => f.code)).toContain("redirect_query_target");
    expect(review.findings.map((f) => f.code)).toContain("redirect_observation_mismatch");
    expect(JSON.stringify(review)).not.toContain("apikey");
  });
});

describe("V01 public HTTP probe in Worker", () => {
  it("observes 301 -> 403 without downloading bodies or following off-origin", async () => {
    const mocked = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      if (String(target) === "https://example.com/") {
        return new Response("redirect", {
          status: 301,
          headers: { location: "/blocked", "cf-cache-status": "HIT" },
        });
      }
      return new Response("forbidden", {
        status: 403,
        headers: { "cf-mitigated": "challenge", "cf-ray": "private-id" },
      });
    });
    vi.stubGlobal("fetch", mocked);
    const observations = await probePublicHttp("https://example.com/");
    expect(observations).toHaveLength(2);
    expect(observations[0].status_code).toBe(301);
    expect(observations[1].status_code).toBe(403);
    expect(mocked).toHaveBeenCalledTimes(2);
    for (const [, init] of mocked.mock.calls) {
      expect(init).toMatchObject({
        method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
      });
    }
    const result = analyzeHttpDelivery(observations, "live_public_http_probe");
    expect(result.redirects_observed).toBe(1);
    expect(result.challenges_observed).toBe(1);
    expect(result.errors_observed).toBe(1);
    expect(result.redirect_chain_complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-id");
  });

  it("does not fetch an out-of-origin redirect target or its private URL", async () => {
    const mocked = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://other.example.net/path?secret=42" },
    }));
    vi.stubGlobal("fetch", mocked);
    const observed = await probePublicHttp("https://example.com/");
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(1);
    const report = analyzeHttpDelivery(observed);
    expect(report.redirect_chain_complete).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain("redirect_query_target");
    expect(JSON.stringify(report)).not.toContain("secret=42");
  });

  it("does not follow a redirect with an empty query or hash marker", async () => {
    const mock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "/sensitive?" },
    }));
    vi.stubGlobal("fetch", mock);
    expect(await probePublicHttp("https://example.com/")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(analyzeHttpDelivery([{ url: "https://example.com/", status_code: 302,
      headers: { location: "/sensitive?" } }]).redirect_chain_complete).toBe(false);
  });

  it("rejects query-bearing entry URLs and internal destinations without fetching", async () => {
    const mocked = vi.fn();
    vi.stubGlobal("fetch", mocked);
    await expect(probePublicHttp("https://example.com/?token=abc")).rejects.toThrow();
    await expect(probePublicHttp("http://localhost/")).rejects.toThrow();
    await expect(probePublicHttp("https://a:password@example.com/")).rejects.toThrow();
    expect(mocked).not.toHaveBeenCalled();
  });

  it("handles loop and redirect cap without running unlimited requests", async () => {
    const mocked = vi.fn(async (target: RequestInfo | URL) => {
      const path = new URL(String(target)).pathname;
      const next = path === "/" ? "/a" : path === "/a" ? "/b" : path === "/b" ? "/c" : "/a";
      return new Response(null, { status: 301, headers: { location: next } });
    });
    vi.stubGlobal("fetch", mocked);
    const r = await probePublicHttp("https://example.com/");
    expect(r).toHaveLength(4);
    expect(mocked).toHaveBeenCalledTimes(4);
    expect(analyzeHttpDelivery(r).redirect_chain_complete).toBe(false);
    expect(analyzeHttpDelivery(r).findings.map((f) => f.code)).toContain("redirect_loop");
  });

  it("captures only approved response-header names", () => {
    const captured = deliveryResponseHeaders(new Headers({
      "set-cookie": "session=secret", "server": "cloudflare",
      "cf-ray": "private", "x-test": "unused",
    }));
    expect(Object.keys(captured).sort()).toEqual(["cf-ray", "server"]);
  });
});
