import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRedirectCanonicalChains, emptyRedirectCanonicalReview,
  MAX_CHAIN_HOPS, MAX_CHAIN_HTML_BYTES, canonicalHrefsFromLinkHeader,
} from "../dist/modules/http-crawl/redirect-canonical-chains.js";

const s = "https://example.com/";
const hop = (path, status_code, extra = {}) => ({ url: new URL(path, s).href, status_code, ...extra });
const codes = (r) => r.findings.map((f) => f.code);
const h = (links = "", meta = "") =>
  "<html><head>" + links + meta + "</head><body>Page</body></html>";

test("V04: bounded HTTP Link rel=canonical extraction ignores other relations", () => {
  assert.deepEqual(canonicalHrefsFromLinkHeader(
    '<https://example.com/final>; rel="canonical", <https://example.com/de>; rel="alternate"; hreflang=de'),
  ["https://example.com/final"]);
  assert.deepEqual(canonicalHrefsFromLinkHeader(null), []);
  assert.deepEqual(canonicalHrefsFromLinkHeader("x".repeat(9_000)), []);
});

test("V04: 301 -> 200 observed chain completes, self canonical, explicit expected target", () => {
  const result = analyzeRedirectCanonicalChains({
    source_url: s, expected_destination: s + "final",
    observations: [
      hop("/", 301, { location: "/final" }),
      hop("/final", 200, {
        html: h('<link rel="canonical" href="/final">'), x_robots_tag: [],
      }),
    ],
  });
  assert.equal(result.hops_observed, 2);
  assert.equal(result.redirects_observed, 1);
  assert.equal(result.permanent_redirects, 1);
  assert.equal(result.temporary_redirects, 0);
  assert.equal(result.chain_complete, true);
  assert.equal(result.final_status_code, 200);
  assert.equal(result.expected_destination_match, true);
  assert.equal(result.nonindexable_destination, false);
  assert.equal(result.destination_indexing_state, "no_noindex_observed");
  assert.equal(result.hops[0].redirect_target, "next_observed");
  assert.equal(result.hops[1].canonical_state, "self");
  assert.equal(result.total_findings, 0);
  assert.equal(result.coverage_limited, true);
  assert(!JSON.stringify(result).includes(s));
});

test("V04: 308 -> 302 -> 503 flags final HTTP error, keeps redirect type counts", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [
      hop("/", 308, { location: "/new" }),
      hop("/new", 302, { location: "/fail" }),
      hop("/fail", 503),
    ],
  });
  assert.equal(r.permanent_redirects, 1);
  assert.equal(r.temporary_redirects, 1);
  assert.equal(r.final_status_code, 503);
  assert.equal(r.chain_complete, true);
  assert.equal(r.nonindexable_destination, true);
  assert(codes(r).includes("redirect_destination_http_error"));
});

test("V04: Location back to any previous hop detects loops without further requests", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s, observations: [
      hop("/", 301, { location: "/a" }),
      hop("/a", 302, { location: "/" }),
    ],
  });
  assert.equal(r.loop_detected, true);
  assert.equal(r.chain_complete, false);
  assert.equal(r.hops[1].redirect_target, "loop");
  assert(codes(r).includes("redirect_loop"));
  assert(codes(r).includes("final_status_unverified"));
});

test("V04: next supplied hop mismatch is not silently accepted", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s, observations: [
      hop("/", 301, { location: "/real" }),
      hop("/unrelated", 200, { html: h(), x_robots_tag: [] }),
    ],
  });
  assert.equal(r.chain_complete, false);
  assert.equal(r.final_status_code, undefined);
  assert.equal(r.hops[0].redirect_target, "mismatch");
  assert(codes(r).includes("redirect_observation_mismatch"));
});

test("V04: true expected destination mismatch is reported only with explicit expectation", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    expected_destination: s + "intended",
    observations: [
      hop("/", 301, { location: "/actual" }),
      hop("/actual", 200, { html: h(), x_robots_tag: [] }),
    ],
  });
  assert.equal(r.expected_destination_match, false);
  assert(codes(r).includes("expected_destination_mismatch"));
  assert(!JSON.stringify(r).includes("intended"));
  assert(!JSON.stringify(r).includes("actual"));
  const noExpected = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [hop("/", 301, { location: "/actual" }), hop("/actual", 200)],
  });
  assert.equal(noExpected.expected_destination_match, undefined);
  assert(!codes(noExpected).includes("expected_destination_mismatch"));
});

test("V04: invalid, missing, cross-origin, query and HTTPS downgrade are distinct redacted states", () => {
  const cases = [
    [undefined, "missing", "redirect_missing_location"],
    ["javascript:alert(1)", "invalid", "redirect_invalid_target"],
    ["https://other.example.net/secret", "cross_origin", "redirect_cross_origin"],
    ["http://example.com/private", "https_downgrade", "redirect_https_downgrade"],
    ["/?token=secret", "query_target", "redirect_query_target"],
  ];
  for (const [location, state, code] of cases) {
    const r = analyzeRedirectCanonicalChains({
      source_url: s,
      observations: [hop("/", 302, location === undefined ? {} : { location })],
    });
    assert.equal(r.hops[0].redirect_target, state, String(location));
    assert(codes(r).includes(code));
    assert.equal(r.chain_complete, false);
    assert(!JSON.stringify(r).includes("secret"));
    assert(!JSON.stringify(r).includes("other.example.net"));
  }
});

test("V04: observed redirect destination noindex and canonical-to-noindex are distinct flags", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [
      hop("/", 301, { location: "/landing", canonicals: ["/landing"] }),
      hop("/landing", 200, {
        html: h("", '<meta name="googlebot" content="noindex">'),
        x_robots_tag: [],
      }),
    ],
  });
  assert.equal(r.chain_complete, true);
  assert.equal(r.destination_indexing_state, "explicit_noindex");
  assert.equal(r.nonindexable_destination, true);
  assert.equal(r.hops[0].canonical_state, "sampled");
  assert(codes(r).includes("canonical_to_noindex"));
  assert(codes(r).includes("redirect_destination_noindex"));
  const otherScope = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [hop("/", 200, { html: h(), x_robots_tag: ["bingbot: noindex"] })],
  });
  assert.equal(otherScope.destination_indexing_state, "no_noindex_observed");
});

test("V04: canonical redirect target and chain detected with supplied samples", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [
      hop("/", 301, { location: "/a", canonicals: ["/a"] }),
      hop("/a", 302, { location: "/b", canonicals: ["/b"] }),
      hop("/b", 200, { html: h('<link rel="canonical" href="/b">'), x_robots_tag: [] }),
    ],
  });
  assert.equal(r.chain_complete, true);
  assert.equal(r.hops[0].canonical_state, "redirect_target");
  assert(codes(r).includes("canonical_to_redirect"));
  assert(codes(r).includes("canonical_chain"));
  assert(r.canonical_chain_edges >= 1);
});

test("V04: conflicting declarations and canonical cycle are reported without original URLs", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [
      hop("/", 301, { location: "/a", canonicals: ["/a"] }),
      hop("/a", 302, { location: "/b", canonicals: ["/"] }),
      hop("/b", 200, { canonicals: ["/b", "/wrong"], html: h(), x_robots_tag: [] }),
    ],
  });
  assert.equal(r.chain_complete, true);
  assert.equal(r.conflicting_canonical_hops, 1);
  assert.equal(r.canonical_cycles, 1);
  assert(codes(r).includes("canonical_conflict"));
  assert(codes(r).includes("canonical_cycle"));
  assert(!JSON.stringify(r).includes("https://example.com/wrong"));
});

test("V04: sampled canonical target HTTP error, external, unresolved and invalid targets", () => {
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [
      hop("/", 301, { location: "/bad", canonicals: ["/bad"] }),
      hop("/bad", 404, { canonicals: ["https://another.example.net/hidden"] }),
    ],
  });
  assert(codes(r).includes("canonical_to_http_error"));
  assert(codes(r).includes("canonical_external"));
  assert.equal(r.nonindexable_destination, true);
  const unresolved = analyzeRedirectCanonicalChains({
    source_url: s, observations: [
      hop("/", 200, { canonicals: ["/unseen"], html: h(), x_robots_tag: [] }),
    ],
  });
  assert.equal(unresolved.hops[0].canonical_state, "unobserved");
  assert(codes(unresolved).includes("canonical_unobserved"));
  assert(!codes(unresolved).includes("canonical_to_http_error"));
  const invalid = analyzeRedirectCanonicalChains({
    source_url: s, observations: [hop("/", 200, { canonicals: ["javascript:alert(1)"] })],
  });
  assert.equal(invalid.hops[0].canonical_state, "invalid");
  assert(codes(invalid).includes("canonical_invalid"));
});

test("V04: explicit robots block and absent indexing evidence are not mistaken for indexability", () => {
  const blocked = analyzeRedirectCanonicalChains({
    source_url: s, observations: [hop("/", 200, { robots_allowed: false })],
  });
  assert.equal(blocked.nonindexable_destination, true);
  assert.equal(blocked.destination_indexing_state, "unknown");
  assert(codes(blocked).includes("redirect_destination_robots_blocked"));
  assert(codes(blocked).includes("destination_indexing_unverified"));
  const empty = emptyRedirectCanonicalReview();
  assert.equal(empty.chain_complete, false);
  assert.equal(empty.coverage_limited, true);
});

test("V04: large production HTML retains robots meta evidence without exceeding V03 caps", () => {
  const bootstrap = "<script>" + "z".repeat(240_000) + "</script>";
  const full = "<html><head><meta name='googlebot' content='noindex'>"
    + bootstrap + "</head><body>OK</body></html>";
  const r = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [hop("/", 200, { html: full, x_robots_tag: [] })],
  });
  assert.equal(r.destination_indexing_state, "explicit_noindex");
  assert.equal(r.nonindexable_destination, true);
  assert(!JSON.stringify(r).includes("zzzzzz"));
  const overflow = "<html><head>"
    + Array.from({ length: 65 }, () => '<meta name="googlebot" content="index">').join("")
    + bootstrap + "</head></html>";
  const cautious = analyzeRedirectCanonicalChains({
    source_url: s,
    observations: [hop("/", 200, { html: overflow, x_robots_tag: [] })],
  });
  assert.equal(cautious.destination_indexing_state, "unknown");
});

test("V04: detects long chains and rejects unsafe/badly ordered/excessive observations", () => {
  const chain = [hop("/", 301, { location: "/1" })];
  for (let i = 1; i <= 4; i++) chain.push(hop("/" + i, 301, { location: "/" + (i + 1) }));
  chain.push(hop("/5", 200));
  const r = analyzeRedirectCanonicalChains({ source_url: s, observations: chain });
  assert(codes(r).includes("redirect_long_chain"));
  assert.equal(r.chain_complete, true);
  const bad = [
    { source_url: s, observations: [] },
    { source_url: s, observations: Array.from({ length: MAX_CHAIN_HOPS + 1 }, (_, i) => hop("/" + i, 200)) },
    { source_url: s, observations: [hop("/not-source", 200)] },
    { source_url: s + "?token=secret", observations: [hop("/", 200)] },
    { source_url: s, observations: [hop("/", 200), hop("/else", 200)] },
    { source_url: s, observations: [hop("/", 200, { html: "x".repeat(MAX_CHAIN_HTML_BYTES + 1) })] },
    { source_url: s, observations: [hop("/", 200, { canonicals: ["/a", "/b", "/c", "/d", "/e"] })] },
    { source_url: s, observations: [hop("/", 200, { x_robots_tag: ["x".repeat(513)] })] },
    { source_url: s, observations: [hop("/", 600)] },
    { source_url: s, observations: [hop("/", 200, { robots_allowed: "false" })] },
    { source_url: s, observations: [{ url: "http://localhost/", status_code: 200 }] },
  ];
  for (const input of bad) assert.throws(() => analyzeRedirectCanonicalChains(input));
});
