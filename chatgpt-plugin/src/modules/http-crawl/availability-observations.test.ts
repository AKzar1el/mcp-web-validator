import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeAvailabilityHistory, emptyAvailabilityReview,
} from "./availability-observations";
import { collectPublicAvailability } from "./availability-probe";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();

describe("V02 shared availability analyzer in Worker", () => {
  it("separates intermittent 429/503/403/challenge and timeout events", () => {
    const r = analyzeAvailabilityHistory([
      { observed_at: at(0), status_code: 200 },
      { observed_at: at(1), status_code: 429, cf_challenge: true },
      { observed_at: at(2), status_code: 503 },
      { observed_at: at(3), failure: "timeout" },
      { observed_at: at(4), status_code: 200 },
    ]);
    expect(r.observations_count).toBe(5);
    expect(r.observed_successes).toBe(2);
    expect(r.observed_success_percent).toBe(40);
    expect(r.observed_http_5xx).toBe(1);
    expect(r.observed_rate_limits).toBe(1);
    expect(r.observed_challenges).toBe(1);
    expect(r.observed_transport_failures).toBe(1);
    expect(r.intermittent_non_success).toBe(true);
    expect(r.longest_non_success_streak).toBe(3);
    expect(r.current_non_success_streak).toBe(0);
    expect(r.coverage_limited).toBe(true);
    expect(emptyAvailabilityReview().observations_count).toBe(0);
  });

  it("refuses synthetic history and time-reversed or contradictory evidence", () => {
    for (const observations of [
      [{ observed_at: at(0), status_code: 200 }],
      [{ observed_at: at(1), status_code: 200 }, { observed_at: at(0), status_code: 200 }],
      [{ observed_at: at(0), status_code: 200, failure: "timeout" }, { observed_at: at(1), status_code: 200 }],
      [{ observed_at: at(0), failure: "timeout", cf_challenge: true }, { observed_at: at(1), status_code: 200 }],
    ]) {
      expect(() => analyzeAvailabilityHistory(observations as never)).toThrow();
    }
  });

  it("treats HTTP 200 Cloudflare challenge as non-success, not proof of page delivery", () => {
    const review = analyzeAvailabilityHistory([
      { observed_at: at(0), status_code: 200, cf_challenge: true },
      { observed_at: at(1), status_code: 200 },
    ]);
    expect(review.samples[0].state).toBe("challenge");
    expect(review.observed_success_percent).toBe(50);
    expect(review.observed_challenges).toBe(1);
    expect(review.intermittent_non_success).toBe(true);
  });
});

describe("V02 short live public availability burst", () => {
  it("compares three distinct live 200/503/200 responses with no request bodies retained", async () => {
    let count = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      count++;
      const status = count === 2 ? 503 : 200;
      return new Response(null, { status,
        headers: count === 2 ? { "cf-mitigated": "challenge" } : {},
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const samples = await collectPublicAvailability("https://example.com/", 3);
    expect(samples).toHaveLength(3);
    expect(samples.map((r) => r.status_code)).toEqual([200, 503, 200]);
    expect(samples.map((r) => r.cf_challenge)).toEqual([false, true, false]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(Date.parse(samples[1].observed_at)).toBeGreaterThan(Date.parse(samples[0].observed_at));
    expect(Date.parse(samples[2].observed_at)).toBeGreaterThan(Date.parse(samples[1].observed_at));
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET", redirect: "manual", cache: "no-store", credentials: "omit",
      });
    }
    const review = analyzeAvailabilityHistory(samples, "live_bounded_burst");
    expect(review.scope).toBe("live_bounded_burst");
    expect(review.observed_success_percent).toBe(67);
    expect(review.intermittent_non_success).toBe(true);
    expect(review.coverage_limited).toBe(true);
  });

  it("records actual network failure without inventing HTTP status", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const samples = await collectPublicAvailability("https://example.com/", 2);
    expect(samples[0]).toMatchObject({ failure: "fetch_error" });
    expect(samples[0].status_code).toBeUndefined();
    expect(samples[1]).toMatchObject({ status_code: 200 });
    const review = analyzeAvailabilityHistory(samples, "live_bounded_burst");
    expect(review.observed_transport_failures).toBe(1);
    expect(review.intermittent_non_success).toBe(true);
  });

  it("rejects local, private, credential-bearing and query-bearing URLs without contacting them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of [
      "http://localhost/", "http://127.0.0.1/",
      "https://example.com/?secret=abc",
      "https://u:pw@example.com/", "file:///etc/passwd",
    ]) await expect(collectPublicAvailability(bad)).rejects.toThrow();
    await expect(collectPublicAvailability("https://example.com/", 4)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds total live fetches to 3 even with repeated server failures", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const samples = await collectPublicAvailability("https://example.com/", 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(analyzeAvailabilityHistory(samples).observed_http_5xx).toBe(3);
  });

  it("charges the limiter for each redirect hop and never disguises budget denial as outage", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "/next" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let charges = 0;
    await expect(collectPublicAvailability("https://example.com/", 2, async () => {
      charges++;
      return charges === 1;
    })).rejects.toThrow("Public request budget exceeded");
    expect(charges).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
