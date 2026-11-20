import { describe, expect, it } from "vitest";
import {
  analyzeUrlVariants, safeVariantLabel, emptyUrlVariantReview,
  MAX_VARIANT_OBSERVATIONS, MAX_VARIANT_FINDINGS,
} from "./url-variants";

const base = "https://sample.example/Products/Widget";
const digest = "a".repeat(64);
const obs = (extra: Record<string, unknown> = {}) => ({
  url: base, status_code: 200, method: "GET" as const, ...extra,
});
const review = (...rows: Array<ReturnType<typeof obs>>) => analyzeUrlVariants(base, rows);
const codes = (r: ReturnType<typeof analyzeUrlVariants>) =>
  r.findings.map((f) => f.code);

describe("P1-14 shared pure URL-variant comparisons in independently installed hosted Worker", () => {
  it("recognizes exact HTTP, www, slash, path-case and query dimensions separately", () => {
    const r = review(obs(),
      obs({ url: "http://sample.example/Products/Widget", status_code: 301, location: base }),
      obs({ url: "https://www.sample.example/Products/Widget", status_code: 301, location: base }),
      obs({ url: base + "/", status_code: 301, location: base }),
      obs({ url: "https://sample.example/products/widget", status_code: 301, location: base }),
      obs({ url: base + "?p=PRIVATE_PARAMETER", status_code: 301, location: base }),
    );
    expect(r.pages_sampled).toBe(6);
    expect(r.pages.slice(1).map((p) => p.dimensions)).toEqual([
      ["scheme"], ["www"], ["slash"], ["case"], ["query"],
    ]);
    expect(r.redirects_to_reference).toBe(5);
    expect(r.coverage_limited).toBe(true);
    expect(JSON.stringify(r)).not.toContain("PRIVATE_PARAMETER");
  });

  it("does not infer duplicates solely from case or query variants", () => {
    const r = review(obs(), obs({ url: base + "?page=2", status_code: 200 }));
    expect(r.content_not_comparable_variants).toBe(1);
    expect(r.matching_content_variants).toBe(0);
    expect(r.pages[1].content_matches_reference).toBe(null);
    expect(codes(r)).toContain("query_semantics_unverified");
  });

  it("compares only caller-provided 200-response content SHA fingerprints", () => {
    const r = review(obs({ content_sha256: digest }),
      obs({ url: base + "/", content_sha256: digest }),
      obs({ url: base + "?page=2", content_sha256: "b".repeat(64) }),
    );
    expect(r.matching_content_variants).toBe(1);
    expect(r.different_content_variants).toBe(1);
    expect(codes(r)).toContain("matching_content_at_variant");
    expect(codes(r)).toContain("different_content_at_variant");
    expect(JSON.stringify(r)).not.toContain(digest);
  });

  it("treats URL redirect declarations as one-step claims, not final fetched destinations", () => {
    const r = review(obs(), obs({
      url: "http://sample.example/Products/Widget", status_code: 308,
      location: "https://www.sample.example/Products/Widget",
    }));
    expect(r.pages[1].response_state).toBe("redirect");
    expect(r.pages[1].redirect_to_https).toBe(true);
    expect(r.pages[1].redirect_state).toBe("to_unobserved_family");
    expect(codes(r)).toContain("redirect_to_other_variant");
  });

  it("does not classify 304 as a redirect nor partial responses as full content", () => {
    const r = review(obs(),
      obs({ url: base + "?cache=1", status_code: 304, location: base }),
      obs({ url: base + "?partial=1", status_code: 206 }),
    );
    expect(r.pages[1].response_state).toBe("not_modified");
    expect(r.pages[1].redirect_state).toBe("absent");
    expect(r.pages[2].response_state).toBe("other_success");
    expect(r.http_200_variants).toBe(0);
  });

  it("distinguishes canonical to reference, to sampled variant and self", () => {
    const r = review(obs({ canonicals: [base] }),
      obs({ url: base + "/", canonicals: [base] }),
      obs({ url: "http://sample.example/Products/Widget", canonicals: [base + "/"] }),
      obs({ url: base + "?x=1", canonicals: [base + "?x=1"] }),
    );
    expect(r.pages.map((p) => p.canonical_state))
      .toEqual(["self", "to_reference", "to_sampled_variant", "self"]);
    expect(r.canonical_to_reference).toBe(1);
  });

  it("identifies multiple conflicting canonical declarations but not repeat duplicates", () => {
    const r = review(obs({ canonicals: [base, base] }),
      obs({ url: base + "/", canonicals: [base, base + "/"] }));
    expect(r.pages[0].canonical_state).toBe("self");
    expect(r.pages[1].canonical_state).toBe("conflicting");
    expect(r.conflicting_canonical_pages).toBe(1);
    expect(codes(r)).toContain("canonical_conflicting_on_page");
  });

  it("flags different canonical targets for byte-identical observed 200 bodies", () => {
    const r = review(obs({ content_sha256: digest, canonicals: [base] }),
      obs({ url: base + "/", content_sha256: digest, canonicals: [base + "/"] }));
    expect(codes(r)).toContain("canonical_disagrees_with_reference");
    expect(codes(r)).toContain("self_canonical_on_matching_variant");
    expect(r.matching_content_variants).toBe(1);
  });

  it("does not echo private canonical or redirect targets", () => {
    const secret = "FAKE_PRIVATE_CANONICAL_TOKEN";
    const r = review(obs({ canonicals: ["https://elsewhere.example/private?token=" + secret] }),
      obs({ url: base + "/", status_code: 302,
        location: "https://elsewhere.example/path?access_token=" + secret }),
    );
    expect(r.pages[0].canonical_state).toBe("external");
    expect(r.pages[1].redirect_state).toBe("external");
    expect(r.redirects_outside_family).toBe(1);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain("elsewhere.example");
  });

  it("unresolved credential-bearing targets do not become verified self canonicals", () => {
    const r = review(obs({ canonicals: ["https://user:secret@sample.example/Products/Widget"] }),
      obs({ url: base + "/", status_code: 302, location: "javascript:alert(1)" }));
    expect(r.pages[0].canonical_state).toBe("unresolved");
    expect(r.pages[1].redirect_state).toBe("unresolved");
  });

  it("requires exact reference record and exact apex/www hostname family", () => {
    expect(() => review(obs({ url: base + "/" }))).toThrow();
    expect(() => review(obs(), obs({ url: "https://blog.sample.example/Products/Widget" }))).toThrow();
    expect(() => review(obs(), obs({ url: "https://www.sample.example.evil.test/Products/Widget" }))).toThrow();
    expect(() => review(obs(), obs({ url: base }))).toThrow();
  });

  it("rejects credentials, fragments, custom ports, control chars and unsafe path normalization", () => {
    for (const url of [
      base + "#fragment",
      "https://user:password@sample.example/Products/Widget",
      "https://sample.example:8443/Products/Widget",
      "file:///etc/passwd",
      "https://sample.example/Products/../Products/Widget",
      "https://sample.example/Products/%2FWidget",
      "https://sample.example/Products/Widget\nInject: yes",
    ]) {
      expect(safeVariantLabel(url)).toBeNull();
    }
  });

  it("restricts SHA digests to complete 200 bodies and rejects invalid status/method", () => {
    for (const invalid of [
      obs({ content_sha256: digest, method: "HEAD" }),
      obs({ content_sha256: digest, status_code: 206 }),
      obs({ content_sha256: "z".repeat(64) }),
      obs({ status_code: 750 }),
      obs({ method: "DELETE" }),
    ]) expect(() => review(invalid)).toThrow();
  });

  it("caps 12 observations and 12 prioritized redacted findings", () => {
    const r = review(obs({ content_sha256: digest }),
      ...Array.from({ length: MAX_VARIANT_OBSERVATIONS - 1 }, (_, i) => obs({
        url: base + "?token=" + i, content_sha256: digest,
      })),
    );
    expect(r.pages_sampled).toBe(MAX_VARIANT_OBSERVATIONS);
    expect(r.query_variants).toBe(11);
    expect(r.findings).toHaveLength(MAX_VARIANT_FINDINGS);
    expect(r.findings_truncated).toBe(true);
    expect(r.total_findings).toBeGreaterThan(MAX_VARIANT_FINDINGS);
    expect(JSON.stringify(r)).not.toContain("?token=");
    expect(() => review(obs(), ...Array.from({ length: MAX_VARIANT_OBSERVATIONS }, (_, i) =>
      obs({ url: base + "?q=" + i })))).toThrow();
  });

  it("does not mistake absent observations for a successful variant check", () => {
    const r = review(obs());
    expect(r.reference_observed).toBe(true);
    expect(codes(r)).toContain("reference_observation_only");
    expect(emptyUrlVariantReview().reference_observed).toBe(false);
  });
});
