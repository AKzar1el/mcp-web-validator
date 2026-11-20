import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeAvailabilityHistory, availabilityState, emptyAvailabilityReview,
  MAX_AVAILABILITY_OBSERVATIONS,
} from "../dist/modules/http-crawl/availability-observations.js";

const t = (minute) => new Date(Date.UTC(2026, 10, 20, 9, minute)).toISOString();
const h = (minute, status_code, extra = {}) =>
  ({ observed_at: t(minute), status_code, ...extra });
const f = (minute, failure) => ({ observed_at: t(minute), failure });
const codes = (r) => r.findings.map((f) => f.code);

test("V02: mixed HTTP states preserve exact observations rather than fake uptime", () => {
  const r = analyzeAvailabilityHistory([
    h(0, 200), h(1, 503, { elapsed_ms: 140 }), h(2, 200),
    h(3, 429, { cf_challenge: true }), f(4, "timeout"),
  ]);
  assert.equal(r.observations_count, 5);
  assert.equal(r.observed_successes, 2);
  assert.equal(r.observed_success_percent, 40);
  assert.equal(r.observed_http_5xx, 1);
  assert.equal(r.observed_http_4xx, 1);
  assert.equal(r.observed_rate_limits, 1);
  assert.equal(r.observed_challenges, 1);
  assert.equal(r.observed_timeouts, 1);
  assert.equal(r.observed_transport_failures, 1);
  assert.equal(r.http_status_changes, 3);
  assert.equal(r.outcome_changes, 4);
  assert.equal(r.longest_non_success_streak, 2);
  assert.equal(r.current_non_success_streak, 2);
  assert.equal(r.intermittent_non_success, true);
  assert.equal(r.latest_observed_state, "timeout");
  assert.equal(r.latest_http_status, undefined);
  assert.equal(r.sampled_window_minutes, 4);
  assert.equal(r.max_observation_gap_minutes, 1);
  assert.deepEqual(codes(r).filter((c) => [
    "intermittent_non_success", "latest_non_success", "rate_limiting",
    "server_failures", "transport_failures", "challenge_observed",
  ].includes(c)), [
    "intermittent_non_success", "latest_non_success", "rate_limiting",
    "server_failures", "transport_failures", "challenge_observed",
  ]);
  assert.equal(r.coverage_limited, true);
  assert(r.limitations.some((l) => l.includes("continuous uptime")));
  assert(!JSON.stringify(r).includes("https:"));
});

test("V02: uniform successes never imply a guarantee or an empty time window", () => {
  const r = analyzeAvailabilityHistory([h(0, 200), h(3, 204), h(7, 200)]);
  assert.equal(r.observed_success_percent, 100);
  assert.equal(r.observed_successes, 3);
  assert.equal(r.intermittent_non_success, false);
  assert.equal(r.current_non_success_streak, 0);
  assert.equal(r.http_status_changes, 2);
  assert.equal(r.outcome_changes, 0);
  assert.equal(r.total_findings, 1);
  assert.deepEqual(codes(r), ["status_transitions"]);
  assert.equal(r.coverage_limited, true);
  assert.equal(r.last_observed_at, t(7));
});

test("V02: redirects and 403/404/500 are distinct non-2xx outcomes", () => {
  const r = analyzeAvailabilityHistory([
    h(0, 302), h(1, 403), h(2, 404), h(3, 500),
  ]);
  assert.equal(r.observed_redirects, 1);
  assert.equal(r.observed_http_4xx, 2);
  assert.equal(r.observed_http_5xx, 1);
  assert.equal(r.observed_success_percent, 0);
  assert.equal(r.longest_non_success_streak, 4);
  assert.equal(r.current_non_success_streak, 4);
  assert.equal(r.latest_observed_state, "server_error");
  assert(codes(r).includes("latest_non_success"));
  assert.equal(availabilityState(h(0, 301)), "redirect");
  assert.equal(availabilityState(h(0, 403)), "forbidden");
  assert.equal(availabilityState(h(0, 429)), "rate_limited");
});

test("V02: sparse and widely separated samples never establish continuity", () => {
  const r = analyzeAvailabilityHistory([h(0, 200), {
    observed_at: "2026-11-20T15:00:00+01:00", status_code: 503,
  }], "local_saved_history");
  assert.equal(r.scope, "local_saved_history");
  assert.equal(r.sampled_window_minutes, 300);
  assert.equal(r.max_observation_gap_minutes, 300);
  assert(codes(r).includes("sparse_samples"));
  assert(codes(r).includes("large_sampling_gap"));
  assert(r.limitations.some((s) => s.includes("outage duration")));
  assert.equal(r.first_observed_at, t(0));
  assert.equal(r.last_observed_at, "2026-11-20T14:00:00.000Z");
});

test("V02: strict timestamps, statuses, failure-exclusive flags and chronological order", () => {
  const invalid = [
    [h(0, 200)],
    [], Array.from({ length: MAX_AVAILABILITY_OBSERVATIONS + 1 }, (_, i) => h(i, 200)),
    [h(1, 200), h(0, 200)],
    [h(0, 200), h(0, 500)],
    [{ observed_at: "2026-11-20T09:00:00", status_code: 200 }, h(1, 200)],
    [{ observed_at: "not a time", status_code: 200 }, h(1, 200)],
    [{ observed_at: "2026-02-31T09:00:00Z", status_code: 200 }, h(1, 200)],
    [{ observed_at: t(0), failure: "invalid_error" }, h(1, 200)],
    [{ observed_at: t(0), status_code: 0 }, h(1, 200)],
    [{ observed_at: t(0), status_code: 600 }, h(1, 200)],
    [{ observed_at: t(0), status_code: 200, failure: "timeout" }, h(1, 200)],
    [{ observed_at: t(0) }, h(1, 200)],
    [{ observed_at: t(0), failure: "timeout", cf_challenge: true }, h(1, 200)],
    [{ observed_at: t(0), status_code: 200, elapsed_ms: 120001 }, h(1, 200)],
    [{ observed_at: t(0), status_code: 200, elapsed_ms: -1 }, h(1, 200)],
  ];
  for (const samples of invalid) assert.throws(() => analyzeAvailabilityHistory(samples));
});

test("V02: explicit failures never become HTTP responses or successful samples", () => {
  const r = analyzeAvailabilityHistory([
    f(0, "dns_error"), f(1, "network_error"), f(2, "policy_blocked"),
    f(3, "fetch_error"), f(4, "timeout"),
  ]);
  assert.equal(r.observed_successes, 0);
  assert.equal(r.observed_transport_failures, 5);
  assert.equal(r.observed_http_4xx, 0);
  assert.equal(r.observed_http_5xx, 0);
  assert.equal(r.observed_timeouts, 1);
  assert.equal(r.samples[2].state, "policy_blocked");
  assert.equal(r.coverage_limited, true);
  const empty = emptyAvailabilityReview();
  assert.equal(empty.observations_count, 0);
  assert.equal(empty.observed_success_percent, 0);
  assert.equal(empty.coverage_limited, true);
});

test("V02: HTTP 200 Cloudflare challenge is not mistaken for delivered page content", () => {
  const r = analyzeAvailabilityHistory([
    h(0, 200, { cf_challenge: true }), h(1, 200),
  ]);
  assert.equal(r.observed_successes, 1);
  assert.equal(r.observed_success_percent, 50);
  assert.equal(r.samples[0].state, "challenge");
  assert.equal(r.samples[1].state, "success");
  assert.equal(r.observed_challenges, 1);
  assert.equal(r.http_status_changes, 0);
  assert.equal(r.outcome_changes, 1);
  assert(codes(r).includes("challenge_observed"));
});
