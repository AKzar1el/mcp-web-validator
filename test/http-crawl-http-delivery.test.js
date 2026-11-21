import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHttpDelivery, deliveryResponseHeaders, emptyDeliveryReview, MAX_DELIVERY_HOPS } from "../dist/modules/http-crawl/http-delivery.js";

const url = "https://example.com/";
const obs = (status_code = 200, extra = {}) => ({ url, status_code, ...extra });
const codes = (r) => r.findings.map((f) => f.code);

test("V01: 200 and bounded cache evidence never return secret header values", () => {
  const r = analyzeHttpDelivery([obs(200, { method: "GET", headers: {
    "Cache-Control": "public, max-age=60, no-cache",
    "Cf-Cache-Status": "HIT", Age: "23", Server: "cloudflare",
    "content-type": "text/html; charset=utf-8", "cf-ray": "secret-ray-id",
  } })]);
  assert.equal(r.hops_observed, 1);
  assert.equal(r.final_http_status, 200);
  assert.equal(r.redirect_chain_complete, true);
  assert.equal(r.hops[0].cache_state, "hit");
  assert.equal(r.hops[0].cache_no_cache, true);
  assert.equal(r.hops[0].cache_max_age_seconds, 60);
  assert.equal(r.hops[0].age_seconds, 23);
  assert.equal(r.hops[0].cf_ray_present, true);
  assert.equal(r.hops[0].cloudflare_server, true);
  assert.equal(r.hops[0].content_type_html, true);
  assert.equal(r.errors_observed, 0);
  assert.equal(r.coverage_limited, true);
  assert(!JSON.stringify(r).includes("secret-ray-id"));
});

test("V01: Cache-Control quoted extension commas do not invent cache directives", () => {
  const r = analyzeHttpDelivery([obs(200, { headers: {
    "cache-control": 'custom="note, no-store, no-cache, private, max-age=999, tail"',
  } })]);
  assert.equal(r.hops[0].cache_no_store, false);
  assert.equal(r.hops[0].cache_no_cache, false);
  assert.equal(r.hops[0].cache_private, false);
  assert.equal(r.hops[0].cache_max_age_seconds, undefined);

  const mixed = analyzeHttpDelivery([obs(200, { headers: {
    "cache-control": 'custom="note, max-age=999, no-cache", max-age=60, no-store',
  } })]);
  assert.equal(mixed.hops[0].cache_no_store, true);
  assert.equal(mixed.hops[0].cache_no_cache, false);
  assert.equal(mixed.hops[0].cache_max_age_seconds, 60);
});

test("V01: field-qualified no-cache/private and ordinary max-age are recognized", () => {
  const r = analyzeHttpDelivery([obs(200, { headers: {
    "Cache-Control": 'private="Set-Cookie", no-cache="Authorization", max-age=60',
  } })]);
  assert.equal(r.hops[0].cache_no_cache, true);
  assert.equal(r.hops[0].cache_private, true);
  assert.equal(r.hops[0].cache_no_store, false);
  assert.equal(r.hops[0].cache_max_age_seconds, 60);
  assert(!JSON.stringify(r).includes("Set-Cookie"));
  assert(!JSON.stringify(r).includes("Authorization"));
});

test("V01: distinct 403, 429, 5xx, challenge and Retry-After classifications", () => {
  for (const [status, code] of [[403, "http_forbidden"], [429, "http_rate_limited"],
    [500, "http_server_error"], [503, "http_server_error"], [404, "http_client_error"]]) {
    const r = analyzeHttpDelivery([obs(status)]);
    assert.equal(r.errors_observed, 1);
    assert(codes(r).includes(code));
    assert.equal(r.challenges_observed, 0);
  }
  const r = analyzeHttpDelivery([obs(429, { headers: {
    "cf-mitigated": "challenge", "Retry-After": "120", "cf-cache-status": "DYNAMIC",
  } })], "live_public_http_probe");
  assert.equal(r.scope, "live_public_http_probe");
  assert.equal(r.challenges_observed, 1);
  assert.equal(r.hops[0].retry_after_seconds, 120);
  assert.equal(r.hops[0].cache_state, "dynamic");
  assert(codes(r).includes("cloudflare_challenge"));
  assert(codes(r).includes("http_rate_limited"));
  const date = analyzeHttpDelivery([obs(503, {
    headers: { "retry-after": "Wed, 21 Oct 2030 07:28:00 GMT" },
  })]);
  assert.equal(date.hops[0].retry_after_present, true);
  assert.equal(date.hops[0].retry_after_seconds, undefined);
});

test("V01: followed redirect chain records only matching observed hops", () => {
  const r = analyzeHttpDelivery([
    obs(301, { headers: { Location: "/new" } }),
    { url: "https://example.com/new", status_code: 302, headers: { location: "/final" } },
    { url: "https://example.com/final", status_code: 200, headers: { "x-cache": "HIT" } },
  ]);
  assert.equal(r.redirects_observed, 2);
  assert.equal(r.redirect_chain_complete, true);
  assert.equal(r.hops[0].next_hop_observed, true);
  assert.deepEqual(codes(r), []);
});

test("V01: invalid, missing, unsafe and cross-origin redirects return sanitized signals", () => {
  for (const [location, expected] of [
    [undefined, "redirect_missing_location"],
    ["javascript:alert(1)", "redirect_invalid_location"],
    ["https://user:pass@example.com/path", "redirect_invalid_location"],
    ["https://other.example.org/hide/secret", "redirect_cross_origin"],
    ["http://example.com/private", "redirect_https_downgrade"],
    ["/next?secret=private_value", "redirect_query_target"],
  ]) {
    const r = analyzeHttpDelivery([obs(302, { headers: location ? { location } : {} })]);
    assert(codes(r).includes(expected));
    assert.equal(r.redirect_chain_complete, false);
    assert.equal(r.redirects_observed, 0);
    assert(!JSON.stringify(r).includes("private_value"));
    assert(!JSON.stringify(r).includes("other.example.org"));
  }
  const mismatch = analyzeHttpDelivery([
    obs(301, { headers: { location: "/next" } }),
    { url: "https://example.com/not-next", status_code: 200 },
  ]);
  assert(codes(mismatch).includes("redirect_observation_mismatch"));
  assert.equal(mismatch.redirect_chain_complete, false);
});

test("V01: loops, 304, bounds and unsafe URLs are handled conservatively", () => {
  const loop = analyzeHttpDelivery([
    obs(301, { headers: { location: "/next" } }),
    { url: "https://example.com/next", status_code: 302, headers: { location: "/" } },
  ]);
  assert(codes(loop).includes("redirect_loop"));
  assert.equal(loop.redirect_chain_complete, false);
  const notRedirect = analyzeHttpDelivery([obs(304)]);
  assert.equal(notRedirect.hops[0].redirect_target, "none");
  assert.equal(notRedirect.hops[0].status, "other");
  assert.throws(() => analyzeHttpDelivery([]));
  assert.throws(() => analyzeHttpDelivery(Array.from({ length: MAX_DELIVERY_HOPS + 1 }, () => obs())));
  for (const bad of ["http://example.com:8443/", "https://a:pw@example.com/",
    "https://example.com/?token=secret", "file:///etc/passwd"]) {
    assert.throws(() => analyzeHttpDelivery([{ url: bad, status_code: 200 }]));
  }
});

test("V01: approved bounded headers only and no credential echo", () => {
  for (const headers of [
    { "cf-ray": "x\r\nnew: value" },
    { "set-cookie": "secret=session" },
    { server: "x".repeat(513) },
    { Server: "Cloudflare", server: "other" },
  ]) assert.throws(() => analyzeHttpDelivery([obs(200, { headers })]));
  assert.throws(() => analyzeHttpDelivery([obs(200), { url: "https://other.example.net/", status_code: 200 }]));
  assert.throws(() => analyzeHttpDelivery([obs(200), { url: "https://example.com/other", status_code: 200 }]));
  assert.throws(() => analyzeHttpDelivery([obs(0)]));
  assert.throws(() => analyzeHttpDelivery([obs(600)]));
  const captured = deliveryResponseHeaders(new Headers({
    "set-cookie": "private", "cf-ray": "hidden-secret-id",
    server: "cloudflare", location: "/a?token=secret",
  }));
  assert.deepEqual(Object.keys(captured).sort(), ["cf-ray", "location", "server"]);
  assert(!JSON.stringify(analyzeHttpDelivery([obs(302, { headers: captured })])).includes("hidden-secret-id"));
  assert.equal(emptyDeliveryReview().redirect_chain_complete, false);
});
