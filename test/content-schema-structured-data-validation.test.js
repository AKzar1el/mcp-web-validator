import assert from "node:assert/strict";
import test from "node:test";
import {
  reviewSupportedJsonLd, MAX_SUPPORTED_SCHEMA_FINDINGS,
  MAX_SUPPORTED_SCHEMA_SCRIPTS, MAX_SUPPORTED_SCHEMA_NODES,
} from "../dist/modules/content-schema/structured-data-validation.js";
import { reviewSupportedSchemaHtml } from "../dist/modules/content-schema/extract-structured-data.js";

const block = (entry) => '<script type="application/ld+json">' + JSON.stringify(entry) + "</script>";
const html = (body) => '<!doctype html><html><head>' + body + '</head><body><main>Static body</main></body></html>';
const article = { "@context": "https://schema.org", "@type": "Article", headline: "Sample article",
  author: { "@type": "Person", name: "Author" }, datePublished: "2026-11-18T09:00:00+01:00" };
const product = { "@context": "https://schema.org/", "@type": "Product", name: "Sample",
  offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" } };
const breadcrumb = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
  { "@type": "ListItem", position: 1, name: "Home", item: "https://example.test/" },
  { "@type": "ListItem", position: 2, name: "Article" },
] };
const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [
  { "@type": "Question", name: "How?", acceptedAnswer: { "@type": "Answer", text: "Like this." } },
] };
const codes = (report) => report.findings.map(({ code }) => code);

test("P1-07 supports accurate Article, Product, BreadcrumbList and FAQ profiles with no fake eligibility promise", () => {
  const report = reviewSupportedSchemaHtml(html([article, product, breadcrumb, faq]
    .map(block).join("")));
  assert.equal(report.blocks_seen, 4);
  assert.equal(report.blocks_checked, 4);
  assert.equal(report.supported_nodes, 4);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 0);
  assert.equal(report.types_checked.length, 4);
  assert.equal(report.coverage_limited, true);
  assert.match(report.limitations.join(" "), /do not establish content truth/);
  assert.equal(report.total_findings, 0);
});

test("P1-07 Article's omitted recommended fields produce review-only, not invalid markup", () => {
  const report = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Article",
  })));
  assert.equal(report.errors, 0);
  assert(codes(report).includes("missing_profile_field"));
  assert(report.findings.some((f) => f.type === "Article" && f.property === "author" &&
    f.severity === "info"));
  assert(report.findings.some((f) => f.property === "headline" &&
    f.severity === "warning"));
});

test("P1-07 correctly resolves @graph inherited context and @type arrays", () => {
  const report = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org",
    "@graph": [
      { "@id": "https://example.test/article", "@type": ["Article", "CreativeWork"],
        headline: "Report", author: { "@type": "Person", name: "Researcher" } },
      { "@type": "Organization", name: "Example", url: "https://example.test/" },
      { "@type": "WebSite", name: "Website", url: "https://example.test/" },
    ],
  })));
  assert.equal(report.supported_nodes, 3);
  assert.equal(report.unsupported_nodes, 1);
  assert.deepEqual(report.types_checked, ["Article", "Organization", "WebSite"]);
  assert.equal(report.errors, 0);
  assert(codes(report).includes("unsupported_type"));
});

test("P1-07 refuses to invent a schema profile for unsupported remote contexts or types", () => {
  const report = reviewSupportedSchemaHtml(html([
    block({ "@context": "https://private.example.test/FAKE_SECRET", "@type": "Product",
      name: "Secret", offers: { price: 20 } }),
    block({ "@context": "https://schema.org", "@type": "FAKE_PRIVATE_TOKEN",
      name: "SECRET_DO_NOT_ECHO" }),
  ].join("")));
  assert.equal(report.supported_nodes, 0);
  assert(report.context_unverified_nodes > 0);
  assert(report.unsupported_nodes > 0);
  assert(codes(report).includes("context_unverified"));
  assert(codes(report).includes("unsupported_type"));
  assert(!JSON.stringify(report).includes("FAKE_SECRET"));
  assert(!JSON.stringify(report).includes("FAKE_PRIVATE_TOKEN"));
  assert(!JSON.stringify(report).includes("SECRET_DO_NOT_ECHO"));
});

test("P1-07 accepts explicit schema.org @vocab and bounded alias-prefixed types", () => {
  const record = {
    "@context": { "@vocab": "https://schema.org/", schema: "https://schema.org/" },
    "@type": ["Article", "schema:Product"],
    name: "Chair", headline: "Review",
    author: { "@type": "Person", name: "Writer" },
    offers: { "@type": "Offer", price: 99, priceCurrency: "EUR" },
  };
  const report = reviewSupportedSchemaHtml(html(block(record)));
  assert.equal(report.supported_nodes, 2);
  assert.equal(report.total_findings, 0);
});

test("P1-07 identifies malformed JSON, invalid top-level primitives, empty and invalid graphs", () => {
  const input = html('<script type="application/ld+json">{"@context":"https://schema.org","@type":</script>'
    + '<script type="application/ld+json">23</script>'
    + '<script type="application/ld+json"></script>'
    + block({ "@context": "https://schema.org", "@graph": [{ "@type": "Article" }, null] }));
  const report = reviewSupportedSchemaHtml(input);
  assert.equal(report.blocks_seen, 4);
  assert(codes(report).includes("invalid_json"));
  assert(codes(report).includes("invalid_document"));
  assert(codes(report).includes("empty_block"));
  assert(codes(report).includes("invalid_graph"));
  assert(report.errors >= 2);
  assert(report.warnings >= 2);
});

test("P1-07 validates Product snippet profile shape, zero prices and currency without fetching", () => {
  const missing = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Product",
    name: 40, offers: [{ "@type": "Offer", price: "-2", priceCurrency: "usd" }],
  })));
  assert(codes(missing).includes("invalid_field_type"));
  assert(codes(missing).includes("invalid_price"));
  assert(codes(missing).includes("invalid_currency"));
  const incomplete = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Product", name: "No offer",
  })));
  assert(codes(incomplete).includes("product_evidence_missing"));
  assert.equal(reviewSupportedSchemaHtml(html(block(product))).warnings, 0);
});

test("P1-07 permits offer priceSpecification, checks AggregateOffer lowPrice, and treats @id as unresolved", () => {
  const withSpecification = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Product", name: "Offer",
    offers: { "@type": "Offer", priceSpecification: { price: 10, priceCurrency: "EUR" } },
  })));
  assert.equal(withSpecification.warnings, 0);
  const unresolved = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Product", name: "Linked",
    offers: { "@id": "https://example.test/#offer" },
  })));
  assert(codes(unresolved).includes("reference_unresolved"));
  assert.equal(unresolved.warnings, 0);
  const lowPrice = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "Product", name: "Group",
    offers: { "@type": "AggregateOffer", lowPrice: 5, priceCurrency: "EUR" },
  })));
  assert.equal(lowPrice.warnings, 0);
});

test("P1-07 Breadcrumb ListItem checks positions, names, nonfinal URL and last-item exception", () => {
  const invalid = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { position: "1", name: "Home" },
      { position: 2, item: "javascript:FAKE_TOKEN" },
      { position: 2, name: "Duplicate position" },
    ],
  })));
  const list = codes(invalid);
  assert(list.includes("breadcrumb_invalid_position"));
  assert(list.includes("breadcrumb_duplicate_position"));
  assert(list.includes("breadcrumb_item_missing"));
  assert(list.includes("invalid_field_type"));
  assert(!JSON.stringify(invalid).includes("FAKE_TOKEN"));
  assert.equal(reviewSupportedSchemaHtml(html(block(breadcrumb))).warnings, 0);
});

test("P1-07 FAQ questions need structured answer text but @id references remain unresolved", () => {
  const bad = reviewSupportedSchemaHtml(html(block({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer" } },
      { "@type": "Question", acceptedAnswer: { "@type": "Answer", text: "Answer" } },
      { "@id": "https://example.test/#question" },
    ],
  })));
  assert(codes(bad).includes("faq_question_incomplete"));
  assert(codes(bad).includes("reference_unresolved"));
  assert.equal(reviewSupportedSchemaHtml(html(block(faq))).warnings, 0);
});

test("P1-07 honors template exclusion and JSON-LD media-type charset case", () => {
  const input = html('<template><script type="application/ld+json">{bad json}</script></template>'
    + '<script type="APPLICATION/LD+JSON; charset=utf-8">' + JSON.stringify(article) + '</script>'
    + '<script type="application/json">{bad json}</script>');
  const report = reviewSupportedSchemaHtml(input);
  assert.equal(report.blocks_seen, 1);
  assert.equal(report.errors, 0);
  assert.equal(report.supported_nodes, 1);
});

test("P1-07 large JSON-LD is skipped, excess scripts are counted, and no raw data leaks", () => {
  const huge = '<script type="application/ld+json">' + "x".repeat(65_000) + '</script>';
  const extra = Array.from({ length: MAX_SUPPORTED_SCHEMA_SCRIPTS + 4 },
    () => block(article)).join("");
  const report = reviewSupportedSchemaHtml(html(huge + extra));
  assert.equal(report.blocks_seen, MAX_SUPPORTED_SCHEMA_SCRIPTS + 5);
  assert.equal(report.blocks_skipped, 6);
  assert(codes(report).includes("large_block_skipped"));
  assert(report.coverage_limited);
  assert(report.total_findings > 0);
  assert(Buffer.byteLength(JSON.stringify(report), "utf8") < 10_000);
});

test("P1-07 caps findings and prioritizes syntax errors over low-severity review notes", () => {
  const many = Array.from({ length: 10 },
    () => block({ "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: Array.from({ length: 4 }, () => ({ "@type": "Question" })) })).join("");
  const input = html(many + '<script type="application/ld+json">not json</script>');
  const report = reviewSupportedSchemaHtml(input);
  assert(report.total_findings > MAX_SUPPORTED_SCHEMA_FINDINGS);
  assert.equal(report.findings.length, MAX_SUPPORTED_SCHEMA_FINDINGS);
  assert.equal(report.findings_truncated, true);
  assert.equal(report.findings[0].code, "invalid_json");
  assert.deepEqual(report, reviewSupportedSchemaHtml(input));
});

test("P1-07 malformed document graph and node caps stay bounded and explicitly partial", () => {
  const manyNodes = { "@context": "https://schema.org", "@graph": Array.from(
    { length: MAX_SUPPORTED_SCHEMA_NODES + 15 }, () => ({ "@type": "WebSite", name: "X" })) };
  const report = reviewSupportedJsonLd([JSON.stringify(manyNodes)]);
  assert(report.nodes_examined <= MAX_SUPPORTED_SCHEMA_NODES);
  assert(report.coverage_limited);
  assert(report.limitations.some((line) => /cap/.test(line)));
  assert.throws(() => reviewSupportedJsonLd(Array(MAX_SUPPORTED_SCHEMA_SCRIPTS + 1).fill("{}")),
    /12-block limit/);
});

test("P1-07 rejects oversized UTF-8 HTML and never echo JSON parse error source text", () => {
  assert.throws(() => reviewSupportedSchemaHtml("é".repeat(125_001)), /250,000/);
  const report = reviewSupportedSchemaHtml(
    '<script type="application/ld+json">{"secret":"FAKE_SUPER_SECRET",}</script>');
  assert.equal(report.errors, 1);
  assert(!JSON.stringify(report).includes("FAKE_SUPER_SECRET"));
});
