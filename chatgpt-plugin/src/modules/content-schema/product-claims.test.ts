import { afterEach, describe, expect, it, vi } from "vitest";
import { observeProductClaims, compareProductClaims } from "./product-claims";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const advertised = [
  "validate_html", "audit_public_webpage", "audit_public_site", "validate_css",
  "audit_seo_metadata", "check_broken_links", "validate_schema_markup",
  "generate_validation_report",
];
const html = (tools: string[] = advertised, limit = 8) =>
  '<html><body><nav><code>fake_nav_tool</code></nav><main><section>'
  + '<h2>Public ChatGPT capabilities</h2>'
  + tools.map((name) => '<p><code>' + name + '</code></p>').join("")
  + '</section><div>Site batch Up to ' + limit + ' pages</div>'
  + '<p>The hosted app is read-only. It cannot create screenshots.</p>'
  + '<p>The separate local MCP provides responsive screenshots.</p></main>'
  + '<footer><code>fake_footer_tool</code></footer></body></html>';
const catalog = advertised.map((name) => ({
  name, readOnlyHint: true, ...(name === "audit_public_site" ? { maxPages: 8 } : {}),
}));

describe("P1-04 Worker product promise comparison", () => {
  it("checks eight declared tools, site batch, read-only and screenshot scope", () => {
    const observation = observeProductClaims(html());
    const result = compareProductClaims(observation, catalog, "hosted");
    expect(result).toMatchObject({
      surface: "hosted", registered_tools: 8, tool_claims_checked: 8,
      checked_claims: 11, consistent_claims: 11,
      contradicted_claims: 0, coverage_limited: false, total_findings: 0,
      site_batch_limit: { advertised: 8, registered: 8 },
    });
  });
  it("detects invented tools and excessive site batch promises without echoing secrets", () => {
    const observation = observeProductClaims(html([...advertised, "instant_rank_tracker"], 300)
      .replace("</main>", "<script>FAKE_PRIVATE_TOKEN</script></main>"));
    const result = compareProductClaims(observation, catalog, "hosted");
    expect(result.contradicted_claims).toBe(2);
    expect(result.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["product.tool_missing", "product.site_batch_overclaim"]));
    expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE_TOKEN");
    expect(result.advertised_tools.map(({ name }) => name)).not.toContain("fake_nav_tool");
    expect(result.advertised_tools.map(({ name }) => name)).not.toContain("fake_footer_tool");
  });
  it("detects advertised site batches larger than three digits", () => {
    const result = compareProductClaims(observeProductClaims(html(advertised, 10000)), catalog, "hosted");
    expect(result.site_batch_limit).toMatchObject({ advertised: 10000, registered: 8 });
    expect(result.findings.map((f) => f.code)).toContain("product.site_batch_overclaim");
  });
  it("reports incomplete evidence when runtime tool catalog is missing", () => {
    const result = compareProductClaims(observeProductClaims(html()), [], "hosted");
    expect(result.catalog_available).toBe(false);
    expect(result.contradicted_claims).toBe(0);
    expect(result.coverage_limited).toBe(true);
  });
  it("does not claim correctness from arbitrary marketing text alone", () => {
    const result = compareProductClaims(observeProductClaims("<html><main><h1>Magic SEO</h1></main></html>"),
      catalog, "hosted");
    expect(result.coverage_limited).toBe(true);
    expect(result.checked_claims).toBe(0);
  });
});
