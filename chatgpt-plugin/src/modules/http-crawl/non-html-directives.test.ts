import { describe, expect, it } from "vitest";
import {
  analyzeHttpDirectives, emptyHttpDirectiveReview, safeHttpResourceUrl,
  MAX_HTTP_FINDINGS, MAX_HTTP_HEADER_BYTES, MAX_HTTP_RESOURCES,
} from "./non-html-directives";

const observed = (extra: Record<string, unknown> = {}) => ({
  url: "https://sample.example/document.pdf",
  status_code: 200,
  method: "HEAD" as const,
  content_type: "application/pdf",
  ...extra,
});

describe("P1-11 shared pure HTTP directive analysis under the hosted Worker bundler", () => {
  it("recognizes PDF noindex, Googlebot scope and canonical with no network fetch", () => {
    const data = analyzeHttpDirectives([observed({
      x_robots_tag: ["noindex", "googlebot: nofollow"],
      link: ['<https://sample.example/page>; rel="canonical"'],
    })]);
    expect(data.non_html_resources).toBe(1);
    expect(data.explicit_noindex_resources).toBe(1);
    expect(data.googlebot_noindex_resources).toBe(1);
    expect(data.conflicting_robots_resources).toBe(0);
    expect(data.resources[0].canonical_state).toBe("one");
    expect(data.coverage_limited).toBe(true);
  });

  it("does not apply other crawler's noindex to unscoped or Googlebot rules", () => {
    const data = analyzeHttpDirectives([observed({
      x_robots_tag: ["otherbot: noindex", "googlebot-news: noindex"],
    })]);
    expect(data.explicit_noindex_resources).toBe(0);
    expect(data.googlebot_noindex_resources).toBe(0);
    expect(data.conflicting_robots_resources).toBe(0);
  });

  it("distinguishes contradictions within one named crawler from different crawlers", () => {
    const separate = analyzeHttpDirectives([observed({
      x_robots_tag: ["bingbot: index, follow", "duckduckbot: noindex, nofollow"],
    })]);
    expect(separate.conflicting_robots_resources).toBe(0);
    expect(separate.findings.some((f) => f.code === "conflicting_robots")).toBe(false);
    expect(separate.googlebot_noindex_resources).toBe(0);
    const same = analyzeHttpDirectives([observed({
      x_robots_tag: ["bingbot: index, follow", "BINGBOT: noindex, nofollow"],
    })]);
    expect(same.conflicting_robots_resources).toBe(1);
  });

  it("distinguishes image-specific noimageindex from generic noindex", () => {
    const image = analyzeHttpDirectives([observed({
      content_type: "image/jpeg", x_robots_tag: ["googlebot: noimageindex"],
    })]);
    expect(image.googlebot_noindex_resources).toBe(0);
    expect(image.googlebot_noimageindex_resources).toBe(1);
    expect(image.resources[0].googlebot_noimageindex).toBe(true);
    expect(image.findings.some((f) => f.code === "explicit_noimageindex")).toBe(true);
    const unrelated = analyzeHttpDirectives([observed({ x_robots_tag: ["otherbot: noimageindex"] })]);
    expect(unrelated.googlebot_noimageindex_resources).toBe(0);
  });

  it("reports overlapping bot/generic contradictions and canonical disagreement", () => {
    const data = analyzeHttpDirectives([observed({
      x_robots_tag: ["noindex, googlebot: index"],
      link: ["<https://sample.example/one>; rel=canonical, <https://sample.example/two>; rel=canonical"],
    })]);
    expect(data.conflicting_robots_resources).toBe(1);
    expect(data.conflicting_canonical_resources).toBe(1);
    expect(data.findings.filter((f) => f.severity === "warning")).toHaveLength(2);
  });

  it("handles quotes, link commas and duplicate rel targets without false canonical conflicts", () => {
    const data = analyzeHttpDirectives([observed({
      link: ['<https://sample.example/a?x=1,2>; rel="alternate canonical"; title="one,two"', '<https://sample.example/a?x=1,2>; rel=canonical'],
    })]);
    expect(data.resources[0].canonical_declarations).toBe(2);
    expect(data.resources[0].canonical_state).toBe("repeated");
    expect(data.conflicting_canonical_resources).toBe(0);
  });

  it("does not leak credentials, URL paths or header values", () => {
    const secret = "MCP_PRIVATE_TOKEN_P111";
    const data = analyzeHttpDirectives([observed({
      x_robots_tag: ["noindex"],
      link: ["<https://user:" + secret + "@sample.example/private>; rel=canonical"],
      content_disposition: 'attachment; filename="' + secret + '"',
    })]);
    expect(data.unresolved_canonical_references).toBe(1);
    expect(data.attachment_resources).toBe(1);
    expect(JSON.stringify(data)).not.toContain(secret);
    expect(JSON.stringify(data)).not.toContain("/private");
    expect(JSON.stringify(data)).not.toContain("https://");
  });

  it("separates MIME/status/partial observations without assuming resource availability", () => {
    const data = analyzeHttpDirectives([
      observed({ url: "https://sample.example/a.pdf", status_code: 206 }),
      observed({ url: "https://sample.example/b.pdf", status_code: 404 }),
      observed({ url: "https://sample.example/c.html", content_type: "text/html" }),
    ]);
    expect(data.non_success_resources).toBe(1);
    expect(data.non_html_resources).toBe(2);
    expect(data.html_resources).toBe(1);
    expect(data.findings.some((f) => f.code === "partial_http_response")).toBe(true);
  });

  it("explicitly treats missing robots metadata as unverified", () => {
    const data = analyzeHttpDirectives([observed()]);
    expect(data.explicit_noindex_resources).toBe(0);
    expect(data.googlebot_noindex_resources).toBe(0);
    expect(data.total_findings).toBe(0);
    expect(data.coverage_limited).toBe(true);
  });

  it("rejects private token URL queries and cross-origin observations", () => {
    expect(safeHttpResourceUrl("https://sample.example/x?token=secret")).toBeNull();
    expect(() => analyzeHttpDirectives([observed({
      url: "https://sample.example/x?token=secret",
    })])).toThrow();
    expect(() => analyzeHttpDirectives([
      observed(),
      observed({ url: "https://other.example/document.pdf" }),
    ])).toThrow();
  });

  it("bounds header byte size, total input and repeated source count", () => {
    expect(() => analyzeHttpDirectives([observed({
      x_robots_tag: ["x".repeat(MAX_HTTP_HEADER_BYTES + 1)],
    })])).toThrow();
    expect(() => analyzeHttpDirectives(Array.from({ length: MAX_HTTP_RESOURCES + 1 }, (_, i) =>
      observed({ url: "https://sample.example/doc-" + i + ".pdf" })))).toThrow();
  });

  it("prioritizes findings and redacts all URI observations with result truncation", () => {
    const data = analyzeHttpDirectives(Array.from({ length: 8 }, (_, i) => observed({
      url: "https://sample.example/" + i + ".pdf",
      status_code: 404,
      x_robots_tag: ["index, noindex"],
      link: ["<https://sample.example/a>; rel=canonical, <https://sample.example/b>; rel=canonical"],
    })));
    expect(data.findings).toHaveLength(MAX_HTTP_FINDINGS);
    expect(data.findings_truncated).toBe(true);
    expect(data.total_findings).toBeGreaterThan(MAX_HTTP_FINDINGS);
    expect(data.findings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(JSON.stringify(data)).not.toContain("https://");
  });

  it("returns an explicit limited state for invalid requests", () => {
    const data = emptyHttpDirectiveReview();
    expect(data.resources_sampled).toBe(0);
    expect(data.coverage_limited).toBe(true);
    expect(data.findings).toEqual([]);
  });
});
