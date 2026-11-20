import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeResourceFailures, emptyResourceFailureReview,
  MAX_RESOURCE_OBSERVATIONS, MAX_RESOURCE_FINDINGS,
} from "../dist/modules/browser-ux/resource-failures.js";
import {
  classifyResourceNetworkFailure, browserResourceType,
  isReadOnlyBrowserResourceMethod,
  inspectPublicResourceLoading,
} from "../dist/modules/browser-ux/resource-failures-probe.js";

const sample = (type, outcome, more = {}) => ({
  resource_type: type, origin: "same_origin", outcome, ...more,
});
const http = (type, status_code, extra = {}) =>
  sample(type, "http", { status_code, ...extra });
const transport = (type, reason = "connection", extra = {}) =>
  sample(type, "transport_failed", { failure_reason: reason, ...extra });
const review = (observations, extra = {}) =>
  analyzeResourceFailures({ observations, ...extra });
const codes = (r) => r.findings.map((f) => f.code);

test("V08: HTTP 404/503/429 responses and transport failures never get conflated", () => {
  const r = review([
    http("document", 200),
    http("script", 404),
    http("stylesheet", 503),
    http("fetch", 429),
    transport("script", "dns"),
    http("image", 304),
  ]);
  assert.equal(r.http_responses, 5);
  assert.equal(r.http_2xx_3xx, 2);
  assert.equal(r.http_4xx, 2);
  assert.equal(r.http_5xx, 1);
  assert.equal(r.http_429, 1);
  assert.equal(r.transport_failures, 1);
  assert.equal(r.critical_resource_failures, 3);
  assert.equal(r.api_failures, 1);
  assert(codes(r).includes("script_http_error"));
  assert(codes(r).includes("script_transport_failed"));
  assert(codes(r).includes("stylesheet_http_error"));
  assert(codes(r).includes("api_http_error"));
  assert(!codes(r).includes("document_http_error"));
});

test("V08: browser policy blocks and unfinished requests are not site resource failures", () => {
  const r = review([
    http("document", 200),
    sample("script", "tool_blocked", { origin: "third_party" }),
    sample("image", "pending"),
    transport("font", "timeout"),
  ], { additional_budget_blocked: 3, navigation_completed: true });
  assert.equal(r.tool_blocked_requests, 1);
  assert.equal(r.pending_requests, 1);
  assert.equal(r.additional_budget_blocked, 3);
  assert.equal(r.http_4xx, 0);
  assert.equal(r.critical_resource_failures, 0);
  assert.equal(r.transport_failures, 1);
  assert.equal(r.third_party_failures, 0);
  assert(codes(r).includes("tool_blocked_resources"));
  assert(codes(r).includes("pending_resources"));
  assert(codes(r).includes("resource_budget_reached"));
  assert(!codes(r).includes("script_transport_failed"));
  assert.equal(r.navigation_completed, true);
});

test("V08: critical document errors and failed third-party API requests are distinguished", () => {
  const r = review([
    http("document", 503),
    transport("xhr", "tls", { origin: "third_party" }),
    http("font", 404, { origin: "third_party" }),
    http("image", 500),
  ], { navigation_completed: false });
  assert.equal(r.critical_resource_failures, 1);
  assert.equal(r.api_failures, 1);
  assert.equal(r.image_failures, 1);
  assert.equal(r.third_party_failures, 2);
  assert(codes(r).includes("document_http_error"));
  assert(codes(r).includes("api_transport_failed"));
  assert(codes(r).includes("font_http_error"));
  assert(codes(r).includes("image_http_error"));
  assert(codes(r).includes("navigation_incomplete"));
});

test("V08: slow successful responses are advisory, not failed", () => {
  const r = review([
    http("script", 200, { duration_ms: 3201 }),
    http("stylesheet", 200, { duration_ms: 450 }),
    http("image", 304, { duration_ms: 3100 }),
    sample("fetch", "pending", { duration_ms: 10000 }),
  ]);
  assert.equal(r.slow_requests, 2);
  assert.equal(r.http_4xx, 0);
  assert.equal(r.http_5xx, 0);
  assert.equal(r.transport_failures, 0);
  assert(codes(r).includes("slow_resource_sample"));
  assert.equal(codes(r).some((code) => code.endsWith("_http_error")), false);
});

test("V08: all nine resource type groups retain their correct counters", () => {
  const types = ["document", "script", "stylesheet", "image", "font",
    "xhr", "fetch", "media", "other"];
  const r = review(types.map((type) => http(type, 200)));
  assert.equal(r.resource_types.length, 9);
  assert.deepEqual(r.resource_types.map((t) => t.resource_type), types);
  assert(r.resource_types.every((type) => type.attempted === 1
    && type.http_responses === 1 && type.http_4xx === 0));
  assert.equal(r.total_findings, 0);
  assert.equal(r.browser_executed, false);
  assert.equal(r.coverage_limited, true);
});

test("V08: output never echoes request URLs, query tokens or raw failure strings", () => {
  const raw = {
    ...transport("script", "dns"),
    url: "https://example.com/private?token=THIS_IS_SECRET",
    raw_error: "net::ERR_FAILED private cookie",
  };
  const r = review([raw, http("document", 200)]);
  assert.equal(r.transport_failures, 1);
  assert(!JSON.stringify(r).includes("THIS_IS_SECRET"));
  assert(!JSON.stringify(r).includes("private cookie"));
  assert(r.findings.every((f) => !f.message.includes("https://")));
});

test("V08: resource event classifier redacts browser transport failure strings", () => {
  const cases = [
    ["net::ERR_NAME_NOT_RESOLVED", "dns"],
    ["net::ERR_TIMED_OUT", "timeout"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
    ["net::ERR_CONNECTION_RESET", "connection"],
    ["net::ERR_ABORTED", "canceled"],
    ["unknown-auth-token-error", "other"],
    [undefined, "other"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(classifyResourceNetworkFailure(raw), expected);
  }
  assert.equal(browserResourceType("preflight"), "other");
  assert.equal(browserResourceType("stylesheet"), "stylesheet");
  assert.equal(isReadOnlyBrowserResourceMethod("GET"), true);
  assert.equal(isReadOnlyBrowserResourceMethod("HEAD"), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "OPTIONS"]) {
    assert.equal(isReadOnlyBrowserResourceMethod(method), false);
  }
});

test("V08: malformed response combinations are rejected before reporting", () => {
  const good = http("document", 200);
  for (const data of [
    { observations: [] },
    { observations: Array.from({ length: MAX_RESOURCE_OBSERVATIONS + 1 },
      () => good) },
    { observations: [sample("script", "http")] },
    { observations: [sample("script", "pending", { status_code: 404 })] },
    { observations: [sample("script", "transport_failed")] },
    { observations: [http("script", 701)] },
    { observations: [http("script", 101)] },
    { observations: [http("script", -1)] },
    { observations: [sample("bogus", "pending")] },
    { observations: [sample("script", "unknown")] },
    { observations: [sample("script", "pending", { origin: "madeup" })] },
    { observations: [http("script", 200, { duration_ms: -1 })] },
    { observations: [good], additional_budget_blocked: -1 },
    { observations: [good], navigation_completed: "yes" },
  ]) {
    assert.throws(() => analyzeResourceFailures(data));
  }
});

test("V08: fixed finding cap and bounded output remain stable at max observations", () => {
  const all = Array.from({ length: MAX_RESOURCE_OBSERVATIONS }, (_, i) =>
    i % 2 ? transport("script", "timeout") : http("stylesheet", 503));
  const r = review(all, { additional_budget_blocked: 900 });
  assert.equal(r.requests_recorded, MAX_RESOURCE_OBSERVATIONS);
  assert.equal(r.http_5xx, MAX_RESOURCE_OBSERVATIONS / 2);
  assert.equal(r.transport_failures, MAX_RESOURCE_OBSERVATIONS / 2);
  assert.equal(r.critical_resource_failures, MAX_RESOURCE_OBSERVATIONS);
  assert(r.findings.length <= MAX_RESOURCE_FINDINGS);
  assert(r.total_findings >= r.findings.length);
  assert(Buffer.byteLength(JSON.stringify(r), "utf8") < 12_000);
});

test("V08: live scanner rejects local/private and query-bearing URLs before browser", async () => {
  await assert.rejects(inspectPublicResourceLoading("http://localhost/"));
  await assert.rejects(inspectPublicResourceLoading("http://127.0.0.1/"));
  await assert.rejects(inspectPublicResourceLoading("https://example.com/?token=secret"));
  assert.equal(emptyResourceFailureReview().coverage_limited, true);
});
