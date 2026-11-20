import { describe, expect, it } from "vitest";
import { analyzeMetadataConsistency, observeMetadata } from "./metadata-consistency";

const origin = "https://example.test";
const head = (value: string) => "<html><head>" + value + "</head><body><main>Page</main></body></html>";
const page = (name: string, html: string) => observeMetadata(html, origin + "/" + name);
const codes = (value: ReturnType<typeof analyzeMetadataConsistency>) => value.findings.map((f) => f.code);
const meta = (name: string, content: string) =>
  '<meta name="' + name + '" content="' + content + '">';
const og = (name: string, content: string) =>
  '<meta property="' + name + '" content="' + content + '">';

describe("P1-09 hosted offline metadata consistency analysis", () => {
  it("compares supplied metadata and differentiates identical duplicate from conflicting value", () => {
    const result = analyzeMetadataConsistency([page("a", head(
      '<title>Same title</title><title> same title </title>'
      + meta("description", "First") + meta("description", "Different")
      + '<link rel="canonical" href="/a">'
      + '<link rel="canonical" href="' + origin + '/b">'))]);
    expect(result).toMatchObject({
      scope: "caller_supplied_same_origin_metadata_only",
      pages_sampled: 1, duplicate_declaration_fields: 1,
      conflicting_declaration_fields: 2, coverage_limited: true,
    });
    expect(codes(result)).toEqual(expect.arrayContaining([
      "duplicate_declaration", "conflicting_declaration",
    ]));
  });
  it("returns social metadata review leads without predicting Google title rewriting", () => {
    const result = analyzeMetadataConsistency([page("a", head(
      '<title>Website title</title>' + meta("description", "Site description")
      + og("og:title", "Social title") + og("og:description", "Social description")
      + meta("twitter:title", "Twitter title")
      + '<link rel="canonical" href="/a">'
      + og("og:url", origin + "/social")) )]);
    expect(result.conflicting_declaration_fields).toBe(0);
    expect(result.cross_field_review_leads).toBe(4);
    expect(codes(result)).toContain("canonical_social_url_difference");
    expect(result.coverage_limited).toBe(true);
  });
  it("does not flag repeated titles sharing an explicit canonical as different canonical pages", () => {
    const article = head('<title>Same title</title><link rel="canonical" href="/main">');
    const result = analyzeMetadataConsistency([page("a", article), page("b", article)]);
    expect(result.duplicate_title_groups).toBe(0);
    expect(result.total_findings).toBe(0);
  });
  it("keeps an unresolved second canonical from certifying a unique canonical preference", () => {
    const base = head('<title>Same title</title><link rel="canonical" href="/a">');
    const mixed = head('<title>Same title</title>'
      + '<link rel="canonical" href="/a">'
      + '<link rel="canonical" href="javascript:FAKE_SECRET">'
      + og("og:url", origin + "/b"));
    const result = analyzeMetadataConsistency([page("a", base), page("b", mixed)]);
    expect(result.unresolved_canonical_references).toBe(1);
    expect(result.cross_field_review_leads).toBe(0);
    expect(result.duplicate_title_groups).toBe(1);
    expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
  });
  it("treats nonstandard references and unknown robots outcomes as limited observations", () => {
    const result = analyzeMetadataConsistency([page("a", head(
      '<link rel="canonical" href="https://user:FAKE_TOKEN@example.test/a">'
      + meta("robots", "noindex, index") + og("og:title", "SECRET_TITLE")) )]);
    expect(result.unresolved_canonical_references).toBe(1);
    expect(result.explicit_robots_conflicts).toBe(1);
    expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
    expect(JSON.stringify(result)).not.toContain("SECRET_TITLE");
  });
  it("combines separate same-agent robots declarations before checking explicit contradictions", () => {
    const result = analyzeMetadataConsistency([page("a", head(
      meta("robots", "index, follow") + meta("robots", "noindex")) )]);
    expect(result.explicit_robots_conflicts).toBe(1);
    expect(result.conflicting_declaration_fields).toBe(1);
    expect(codes(result)).toContain("conflicting_robots_directives");
  });
  it("treats robots 'none' shorthand as noindex/nofollow in explicit contradictions", () => {
    const result = analyzeMetadataConsistency([page("a", head(
      meta("robots", "none") + meta("robots", "index")) )]);
    expect(result.explicit_robots_conflicts).toBe(1);
  });
  it("normalizes equivalent robots aliases but does not call complementary directives conflicting", () => {
    const equivalent = analyzeMetadataConsistency([page("a", head(
      meta("robots", "all") + meta("robots", "follow,INDEX")))]);
    expect(equivalent.duplicate_declaration_fields).toBe(1);
    expect(equivalent.conflicting_declaration_fields).toBe(0);
    const complementary = analyzeMetadataConsistency([page("a", head(
      meta("robots", "noindex") + meta("robots", "nofollow")))]);
    expect(complementary.conflicting_declaration_fields).toBe(0);
    expect(complementary.explicit_robots_conflicts).toBe(0);
    const differingValues = analyzeMetadataConsistency([page("a", head(
      meta("robots", "max-snippet:1") + meta("robots", "max-snippet:2")))]);
    expect(differingValues.conflicting_declaration_fields).toBe(1);
  });
  it("bounds findings, input sample and disclosure across eight pages", () => {
    const pages = Array.from({ length: 8 }, (_, i) => page("item-" + i, head(
      '<title>FIRST</title><title>SECOND</title>'
      + meta("description", "D1") + meta("description", "D2")
      + og("og:title", "PRIVATE_TITLE") + meta("robots", "noindex, index")
      + '<link rel="canonical" href="/a"><link rel="canonical" href="/b">')));
    const result = analyzeMetadataConsistency(pages);
    expect(result.pages_sampled).toBe(8);
    expect(result.findings).toHaveLength(12);
    expect(result.findings_truncated).toBe(true);
    expect(result.total_findings).toBeGreaterThan(12);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TITLE");
    expect(JSON.stringify(result).length).toBeLessThan(11_000);
    expect(result).toEqual(analyzeMetadataConsistency(pages));
  });
});
