import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeUrlVariants, emptyUrlVariantReview, safeVariantLabel,
  MAX_VARIANT_OBSERVATIONS, MAX_VARIANT_FINDINGS,
  MAX_VARIANT_URL_BYTES, MAX_VARIANT_CANONICALS,
  VARIANT_DIMENSIONS, VARIANT_CANONICAL_STATES,
} from "../dist/modules/http-crawl/url-variants.js";

const base = "https://example.test/Products/Widget";
const a = "a".repeat(64), b = "b".repeat(64);
const observed = (extra = {}) => ({ url: base, status_code: 200, method: "GET", ...extra });
const examine = (...items) => analyzeUrlVariants(base, items);
const finding = (r, code) => r.findings.filter((f) => f.code === code);

test("P1-14: reference-only input explicitly cannot establish variant coverage", () => {
  const r = examine(observed({ content_sha256: a, canonicals: [base] }));
  assert.equal(r.scope, "caller_supplied_url_variant_evidence_only");
  assert.equal(r.pages_sampled, 1);
  assert.equal(r.reference_observed, true);
  assert.equal(r.reference_http_200, true);
  assert.deepEqual(r.pages[0].dimensions, []);
  assert.equal(r.pages[0].is_reference, true);
  assert.equal(r.pages[0].canonical_state, "self");
  assert.equal(r.pages[0].content_matches_reference, null);
  assert.equal(finding(r, "reference_observation_only").length, 1);
  assert.equal(r.coverage_limited, true);
  assert(r.limitations.join(" ").includes("Google-selected canonical"));
});

test("P1-14: all five candidate dimensions are separate and no URL equivalence is asserted", () => {
  const r = examine(
    observed({ content_sha256: a }),
    observed({ url: "http://example.test/Products/Widget", status_code: 301, location: base }),
    observed({ url: "https://www.example.test/Products/Widget", status_code: 301, location: base }),
    observed({ url: base + "/", status_code: 301, location: base }),
    observed({ url: "https://example.test/products/widget", status_code: 301, location: base }),
    observed({ url: base + "?utm_source=PRIVATE_TOKEN", status_code: 301, location: base }),
  );
  assert.equal(r.pages_sampled, 6);
  assert.deepEqual(r.pages.slice(1).map((p) => p.dimensions),
    [["scheme"], ["www"], ["slash"], ["case"], ["query"]]);
  assert.equal(r.scheme_variants, 1);
  assert.equal(r.www_variants, 1);
  assert.equal(r.slash_variants, 1);
  assert.equal(r.case_variants, 1);
  assert.equal(r.query_variants, 1);
  assert.equal(r.redirects_to_reference, 5);
  assert.equal(r.http_200_variants, 0);
  assert(r.pages.slice(1).every((p) => p.redirect_state === "to_reference"));
  assert(!JSON.stringify(r).includes("PRIVATE_TOKEN"));
  assert(!JSON.stringify(r).includes("/Products/Widget"));
  assert.deepEqual([...VARIANT_DIMENSIONS], ["scheme", "www", "slash", "case", "query"]);
});

test("P1-14: compound www+scheme+case+slash+query observed as a multi-dimension candidate", () => {
  const r = examine(observed(), observed({
    url: "http://www.example.test/products/widget/?sort=abc",
    status_code: 200,
  }));
  assert.deepEqual(r.pages[1].dimensions, ["scheme", "www", "slash", "case", "query"]);
  assert.equal(r.pages[1].content_matches_reference, null);
  assert.equal(r.http_200_variants, 1);
  assert.equal(r.content_not_comparable_variants, 1);
  assert.equal(finding(r, "content_unverified").length, 1);
});

test("P1-14: case can represent a distinct resource, and different SHA-256 is not mislabeled duplicate", () => {
  const r = examine(observed({ content_sha256: a }), observed({
    url: "https://example.test/products/widget", status_code: 200, content_sha256: b,
  }));
  assert.equal(r.case_variants, 1);
  assert.equal(r.different_content_variants, 1);
  assert.equal(r.matching_content_variants, 0);
  assert.equal(r.pages[1].content_matches_reference, false);
  assert.equal(finding(r, "different_content_at_variant")[0].severity, "info");
  assert.equal(finding(r, "matching_content_at_variant").length, 0);
});

test("P1-14: matching caller SHA fingerprints produce bounded review lead only", () => {
  const r = examine(observed({ content_sha256: a }), observed({
    url: base + "/", status_code: 200, content_sha256: a,
  }));
  assert.equal(r.matching_content_variants, 1);
  assert.equal(r.pages[1].content_matches_reference, true);
  assert.equal(finding(r, "matching_content_at_variant").length, 1);
  assert.equal(finding(r, "matching_content_at_variant")[0].severity, "warning");
  assert(!JSON.stringify(r).includes(a));
  assert(r.limitations.join(" ").includes("caller-provided"));
});

test("P1-14: no content hash, HEAD-only evidence or missing reference hash never proves duplicate", () => {
  const noReferenceHash = examine(observed(), observed({
    url: base + "/", status_code: 200, content_sha256: a,
  }));
  assert.equal(noReferenceHash.matching_content_variants, 0);
  assert.equal(noReferenceHash.content_not_comparable_variants, 1);
  const head = examine(observed({ method: "HEAD" }), observed({
    url: base + "/", status_code: 200, method: "HEAD",
  }));
  assert.equal(head.content_not_comparable_variants, 1);
  assert(head.pages.every((p) => !p.fingerprint_supplied));
});

test("P1-14: query variants may intentionally change content even when path is the same", () => {
  const r = examine(observed({ content_sha256: a }), observed({
    url: base + "?product=OTHER_SECRET", status_code: 200, content_sha256: b,
  }));
  assert.equal(r.query_variants, 1);
  assert.equal(r.different_content_variants, 1);
  assert.equal(finding(r, "query_semantics_unverified").length, 1);
  assert.equal(r.pages[1].has_query, true);
  assert(!JSON.stringify(r).includes("OTHER_SECRET"));
});

test("P1-14: HTTP 301/302/303/307/308 are one-step redirects, never assumed final successes", () => {
  const statuses = [301, 302, 303, 307, 308];
  const r = examine(observed(), ...statuses.map((status_code, i) => observed({
    url: base + "?redirect=" + i, status_code, location: base,
  })));
  assert.equal(r.redirects_to_reference, 5);
  assert(r.pages.slice(1).every((p) => p.response_state === "redirect"));
  assert(r.pages.slice(1).every((p) => p.redirect_state === "to_reference"));
  assert.equal(r.http_200_variants, 0);
});

test("P1-14: 304 Not Modified and 206 Partial Content are not treated as 3xx Location redirects or full 200", () => {
  const r = examine(observed(),
    observed({ url: base + "?cached=1", status_code: 304, location: base }),
    observed({ url: base + "?partial=1", status_code: 206 }),
  );
  assert.equal(r.pages[1].response_state, "not_modified");
  assert.equal(r.pages[1].redirect_state, "absent");
  assert.equal(r.pages[2].response_state, "other_success");
  assert.equal(r.http_200_variants, 0);
  assert.equal(finding(r, "partial_or_other_success").length, 1);
});

test("P1-14: an HTTP-to-HTTPS redirect is observed as a claim, not an executed redirect", () => {
  const r = examine(observed(), observed({
    url: "http://example.test/Products/Widget", status_code: 308,
    location: base,
  }));
  assert.equal(r.pages[1].redirect_to_https, true);
  assert.equal(r.pages[1].redirect_state, "to_reference");
  assert.equal(r.redirects_to_reference, 1);
});

test("P1-14: relative/absolute Location can point to sampled or unobserved in-family variant", () => {
  const r = examine(observed(),
    observed({ url: "http://example.test/Products/Widget",
      status_code: 301, location: "https://www.example.test/Products/Widget" }),
    observed({ url: "https://www.example.test/Products/Widget", status_code: 200 }),
    observed({ url: base + "/", status_code: 307,
      location: "../Widget?from=slash" }),
  );
  assert.equal(r.pages[1].redirect_state, "to_sampled_variant");
  assert.equal(r.pages[3].redirect_state, "to_unobserved_family");
  assert.equal(r.redirects_to_reference, 0);
  assert.equal(finding(r, "redirect_to_other_variant").length, 2);
});

test("P1-14: unsafe, absent, or non-HTTP Location never becomes a verified redirect", () => {
  for (const location of [undefined, "", "javascript:alert(1)", "file:///etc/passwd",
    "https://user:password@example.test/private", "#fragment"]) {
    if (location === "") {
      assert.throws(() => examine(observed(), observed({ url: base + "/",
        status_code: 302, location })));
      continue;
    }
    const r = examine(observed(), observed({ url: base + "/",
      status_code: 302, ...(location === undefined ? {} : { location }) }));
    assert.equal(r.pages[1].redirect_state, "unresolved");
    assert.equal(r.unresolved_redirects, 1);
    assert.equal(finding(r, "redirect_unresolved").length, 1);
  }
});

test("P1-14: redirect outside family is reported without leaking the target", () => {
  const secret = "LOCATION_SECRET_P114";
  const r = examine(observed(), observed({
    url: base + "/", status_code: 302,
    location: "https://outside.example.org/hidden?token=" + secret,
  }));
  assert.equal(r.pages[1].redirect_state, "external");
  assert.equal(r.redirects_outside_family, 1);
  assert.equal(finding(r, "redirect_outside_family").length, 1);
  assert(!JSON.stringify(r).includes(secret));
  assert(!JSON.stringify(r).includes("outside.example.org"));
});

test("P1-14: canonical to reference, self, sampled variant and missing all have distinct states", () => {
  const r = examine(observed({ canonicals: [base] }),
    observed({ url: base + "/", status_code: 200, canonicals: [base] }),
    observed({ url: "http://example.test/Products/Widget", status_code: 200,
      canonicals: [base + "/"] }),
    observed({ url: base + "?session=PRIVATE", status_code: 200 }),
  );
  assert.equal(r.pages[0].canonical_state, "self");
  assert.equal(r.pages[1].canonical_state, "to_reference");
  assert.equal(r.pages[2].canonical_state, "to_sampled_variant");
  assert.equal(r.pages[3].canonical_state, "absent");
  assert.equal(r.canonical_to_reference, 1);
});

test("P1-14: repeated identical canonical targets do not imply conflict", () => {
  const r = examine(observed({ canonicals: [base, base] }));
  assert.equal(r.pages[0].canonical_state, "self");
  assert.equal(r.pages[0].canonical_declarations, 2);
  assert.equal(r.conflicting_canonical_pages, 0);
});

test("P1-14: multiple divergent canonical targets on one response are conflicting declarations", () => {
  const r = examine(observed({ canonicals: [base, "https://www.example.test/Products/Widget"] }));
  assert.equal(r.pages[0].canonical_state, "conflicting");
  assert.equal(r.conflicting_canonical_pages, 1);
  assert.equal(finding(r, "canonical_conflicting_on_page").length, 1);
});

test("P1-14: equivalent-body self-canonical variant is a review warning, not Google-selected canonical verdict", () => {
  const r = examine(observed({ content_sha256: a, canonicals: [base] }), observed({
    url: base + "/", status_code: 200, content_sha256: a, canonicals: [base + "/"],
  }));
  assert.equal(r.pages[1].canonical_state, "self");
  assert.equal(finding(r, "self_canonical_on_matching_variant").length, 1);
  assert.equal(finding(r, "canonical_disagrees_with_reference").length, 1);
});

test("P1-14: byte-identical 200 page canonicals that differ produce a cross-sample conflict", () => {
  const r = examine(observed({ content_sha256: a, canonicals: [base] }), observed({
    url: "https://www.example.test/Products/Widget", status_code: 200,
    content_sha256: a, canonicals: ["https://www.example.test/Products/Widget"],
  }));
  assert.equal(finding(r, "canonical_disagrees_with_reference").length, 1);
  assert.equal(r.matching_content_variants, 1);
});

test("P1-14: off-family and credential-bearing canonical targets are safely separated", () => {
  const marker = "CANONICAL_SECRET_P114";
  const r = examine(observed({ canonicals: ["https://elsewhere.example/a?x=" + marker] }),
    observed({ url: base + "/", canonicals: ["https://user:" + marker + "@example.test/"] }),
  );
  assert.equal(r.pages[0].canonical_state, "external");
  assert.equal(r.pages[1].canonical_state, "unresolved");
  assert.equal(finding(r, "canonical_outside_family").length, 1);
  assert.equal(finding(r, "canonical_unresolved").length, 1);
  assert(!JSON.stringify(r).includes(marker));
});

test("P1-14: case-normalization is only a candidate filter; unrelated paths rejected", () => {
  assert.throws(() => examine(observed(),
    observed({ url: "https://example.test/Products/Different" })));
  assert.throws(() => examine(observed(),
    observed({ url: "https://example.test/Products/Widget/child" })));
  assert.throws(() => examine(observed(),
    observed({ url: "https://other.test/Products/Widget" })));
  assert.throws(() => examine(observed(),
    observed({ url: "https://blog.example.test/Products/Widget" })));
  assert.throws(() => examine(observed(),
    observed({ url: "https://www.example.test.evil.org/Products/Widget" })));
});

test("P1-14: safe label parses raw query tokens but rejects fragments and credentials", () => {
  assert.equal(safeVariantLabel(base + "?session=FAKE_PASSWORD"),
    base + "?session=FAKE_PASSWORD");
  for (const url of [
    base + "#frag", "https://u:p@example.test/Products/Widget",
    "https://example.test:8080/Products/Widget",
    "file:///etc/passwd", "javascript:alert(1)",
    "https://example.test/Products/../Products/Widget",
    "https://example.test/Products/%2FWidget",
    "https://example.test/Products/Widget\\backslash",
    "https://example.test/Products/Widget\nInjected: yep",
  ]) assert.equal(safeVariantLabel(url), null, url);
});

test("P1-14: scheme and www host are URL-normalized, unrelated double-www does not pass", () => {
  const r = examine(observed(), observed({
    url: "HTTP://WWW.EXAMPLE.TEST/Products/Widget", status_code: 301, location: base,
  }));
  assert.deepEqual(r.pages[1].dimensions, ["scheme", "www"]);
  assert.throws(() => examine(observed(),
    observed({ url: "https://www.www.example.test/Products/Widget" })));
});

test("P1-14: duplicate labels and missing exact reference observation fail closed", () => {
  assert.throws(() => examine(observed(), observed()));
  assert.throws(() => examine(observed({ url: base + "/" })));
  assert.throws(() => analyzeUrlVariants(base + "?q=1", [observed()]));
  assert.throws(() => analyzeUrlVariants(base + "#f", [observed()]));
  assert.throws(() => analyzeUrlVariants(base, []));
});

test("P1-14: response status, method and fingerprint contract cannot invent full body checks", () => {
  for (const item of [
    observed({ status_code: 0 }), observed({ status_code: 600 }),
    observed({ status_code: 200.5 }), observed({ method: "POST" }),
    observed({ content_sha256: "x".repeat(64) }),
    observed({ content_sha256: a, method: "HEAD" }),
    observed({ content_sha256: a, status_code: 206 }),
  ]) assert.throws(() => examine(item));
  const r = examine(observed({ status_code: 404 }), observed({
    url: base + "/", status_code: 200, content_sha256: a,
  }));
  assert.equal(r.reference_http_200, false);
  assert.equal(r.matching_content_variants, 0);
  assert.equal(finding(r, "reference_not_ok").length, 1);
});

test("P1-14: 12 observation cap, 3 canonical limit and UTF-8 aggregate cap enforce bounded work", () => {
  assert(MAX_VARIANT_OBSERVATIONS === 12);
  assert(MAX_VARIANT_CANONICALS === 3);
  const samples = Array.from({ length: MAX_VARIANT_OBSERVATIONS + 1 }, (_, i) =>
    observed({ url: base + "?v=" + i }));
  assert.throws(() => analyzeUrlVariants(base, samples));
  assert.throws(() => examine(observed({ canonicals: Array.from({ length: 4 }, () => base) })));
  assert.throws(() => examine(observed({ location: "é".repeat(MAX_VARIANT_URL_BYTES / 2 + 1) })));
  assert.throws(() => examine(observed({
    canonicals: ["https://example.test/PRIVATE_SECRET\r\nLocation: leaked"],
  })));
});

test("P1-14: totals preserve all findings while only 12 fixed redacted findings are output", () => {
  const r = examine(observed({ content_sha256: a }),
    ...Array.from({ length: MAX_VARIANT_OBSERVATIONS - 1 }, (_, i) => observed({
      url: base + "?secret=" + i, content_sha256: a, status_code: 200,
    })),
  );
  assert.equal(r.pages_sampled, MAX_VARIANT_OBSERVATIONS);
  assert.equal(r.query_variants, 11);
  assert.equal(r.matching_content_variants, 11);
  assert(r.total_findings > MAX_VARIANT_FINDINGS);
  assert.equal(r.findings.length, MAX_VARIANT_FINDINGS);
  assert.equal(r.findings_truncated, true);
  assert.equal(r.findings.filter((f) => f.severity === "warning").length, 11);
  assert.equal(r.findings[0].severity, "warning");
  assert(Buffer.byteLength(JSON.stringify(r)) < 13_000);
  assert(!JSON.stringify(r).includes("secret="));
});

test("P1-14: offline scaffold and schema enums are stable, do not imply coverage", () => {
  const r = emptyUrlVariantReview();
  assert.equal(r.reference_observed, false);
  assert.equal(r.coverage_limited, true);
  assert.equal(r.pages_sampled, 0);
  assert.equal(r.total_findings, 0);
  assert(VARIANT_CANONICAL_STATES.includes("conflicting"));
});
