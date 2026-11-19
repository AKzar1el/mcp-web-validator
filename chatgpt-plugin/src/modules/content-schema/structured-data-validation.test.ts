import { describe, expect, it } from "vitest";
import { reviewSupportedSchemaHtml, reviewSupportedJsonLd } from "./structured-data-validation";

const html = (data: string) => "<html><head>" + data + "</head><body><main>Page</main></body></html>";
const script = (entry: unknown) =>
  '<script type="application/ld+json">' + JSON.stringify(entry) + "</script>";
const article = { "@context": "https://schema.org", "@type": "Article", headline: "Report",
  author: { "@type": "Person", name: "Writer" } };
const product = { "@context": "https://schema.org", "@type": "Product", name: "Chair",
  offers: { "@type": "Offer", price: 0, priceCurrency: "EUR" } };

describe("P1-07 hosted supported structured-data review", () => {
  it("recognizes Article, Product, BreadcrumbList and FAQPage without claiming eligibility", () => {
    const data = html([
      script(article),
      script(product),
      script({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com/" },
        { "@type": "ListItem", position: 2, name: "Product" },
      ] }),
      script({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [
        { "@type": "Question", name: "What?", acceptedAnswer: { "@type": "Answer", text: "This." } },
      ] }),
    ].join(""));
    const result = reviewSupportedSchemaHtml(data);
    expect(result).toMatchObject({
      scope: "bounded_jsonld_structural_profiles",
      blocks_seen: 4, blocks_checked: 4, supported_nodes: 4,
      errors: 0, warnings: 0, coverage_limited: true, total_findings: 0,
    });
    expect(result.types_checked).toEqual(["Article", "Product", "BreadcrumbList", "FAQPage"]);
  });
  it("reports missing Product evidence and malformed breadcrumb positions as bounded review leads", () => {
    const result = reviewSupportedSchemaHtml(html([
      script({ "@context": "https://schema.org", "@type": "Product", name: "Unpriced" }),
      script({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { position: 1, name: "Home", item: "https://example.com" },
        { position: 1, name: "Product" },
      ] }),
    ].join("")));
    const codes = result.findings.map(({ code }) => code);
    expect(codes).toContain("product_evidence_missing");
    expect(codes).toContain("breadcrumb_duplicate_position");
    expect(result.errors).toBe(0);
    expect(result.warnings).toBeGreaterThan(0);
  });
  it("does not guess semantic validity for an unsupported type or remote context", () => {
    const result = reviewSupportedSchemaHtml(html([
      script({ "@context": "https://unknown.test/FAKE_TOKEN", "@type": "Article", headline: "Secret" }),
      script({ "@context": "https://schema.org", "@type": "FAKE_PRIVATE_TYPE" }),
    ].join("")));
    expect(result.supported_nodes).toBe(0);
    expect(result.context_unverified_nodes).toBeGreaterThan(0);
    expect(result.unsupported_nodes).toBeGreaterThan(0);
    expect(result.coverage_limited).toBe(true);
    expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
    expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE_TYPE");
  });
  it("reports malformed syntax without returning any user-supplied JSON content", () => {
    const result = reviewSupportedSchemaHtml(
      '<script type="application/ld+json">{"token":"FAKE_PRIVATE",}</script>');
    expect(result.errors).toBe(1);
    expect(result.findings[0].code).toBe("invalid_json");
    expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE");
  });
  it("supports inherited @graph contexts, explicitly bounded scripts, and deterministic caps", () => {
    const data = script({ "@context": "https://schema.org", "@graph": [
      { "@type": "Article", headline: "Example", author: { "@type": "Person", name: "A" } },
      { "@type": "Product", name: "P", offers: { "@type": "Offer", price: "9" } },
    ] });
    const result = reviewSupportedSchemaHtml(html(data));
    expect(result.supported_nodes).toBe(2);
    const excessive = reviewSupportedJsonLd(Array.from({ length: 12 }, () =>
      JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage",
        mainEntity: [{ "@type": "Question", name: "" }] })), 15);
    expect(excessive.blocks_seen).toBe(15);
    expect(excessive.blocks_skipped).toBe(3);
    expect(excessive.findings_truncated).toBe(true);
    expect(excessive.findings.length).toBe(12);
    expect(excessive).toEqual(reviewSupportedJsonLd(Array.from({ length: 12 }, () =>
      JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage",
        mainEntity: [{ "@type": "Question", name: "" }] })), 15));
  });
});
