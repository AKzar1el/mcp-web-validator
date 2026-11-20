import { describe, expect, it } from "vitest";
import { compareIntentObservations, observeIntentHtml } from "./competitor-intent-comparison";

const primary = "https://publisher.test/guide";
const one = "https://shop-one.test/product";
const two = "https://shop-two.test/chairs";
const page = (title: string, h1: string, body: string, schema = "") =>
  "<html><head><title>" + title + "</title>" + schema + "</head><body>"
    + '<nav><a href="/checkout">Buy now</a></nav>'
    + "<main><h1>" + h1 + "</h1>" + body + "</main>"
    + '<footer><address>Hidden footer address</address></footer></body></html>';
const shop = (label = "Best ergonomic chair") =>
  page(label, label, '<a href="/checkout">Checkout</a><h2>Pricing plans</h2>',
    '<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":200}}</script>');

describe("P1-06 hosted offline competitor intent analysis", () => {
  it("recognizes supplied commercial/transactional evidence, not header chrome", () => {
    const source = observeIntentHtml(page("Posture lesson", "Posture lesson",
      "<article><h2>Introduction</h2><p>" + "Long informational text. ".repeat(5)
      + "</p><h2>Explanation</h2><p>" + "Long informational text. ".repeat(5)
      + "</p></article>"), primary);
    const result = compareIntentObservations(source,
      [observeIntentHtml(shop(), one), observeIntentHtml(shop(), two)],
      { expectedIntent: "commercial", query: "best ergonomic chair" });
    expect(source.signals.transactional).toEqual([]);
    expect(result.competitors_with_intent_signals).toBe(2);
    expect(result.primary.intent_signal_count).toBe(0);
    expect(result.findings.map((f) => f.code))
      .toEqual(expect.arrayContaining(["primary_intent_signal_gap", "primary_heading_query_gap"]));
    expect(result.coverage_limited).toBe(true);
  });
  it("does not report a gap when primary has the explicitly chosen intent signal", () => {
    const target = observeIntentHtml(shop(), primary);
    const result = compareIntentObservations(target,
      [observeIntentHtml(shop(), one)], { expectedIntent: "commercial" });
    expect(result.primary.intent_signal_count).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.code)).not.toContain("primary_intent_signal_gap");
  });
  it("rejects duplicate origins and query-bearing labels without any remote request", () => {
    const target = observeIntentHtml(shop(), primary);
    expect(() => compareIntentObservations(target,
      [observeIntentHtml(shop(), "https://publisher.test/a")]))
      .toThrow("distinct origins");
    expect(observeIntentHtml(shop(), one + "?key=FAKE_PRIVATE").eligible).toBe(false);
  });
  it("ignores hidden/header/footer actions, returns no raw titles or HTML or query", () => {
    const target = observeIntentHtml(page("PRIVATE_TITLE", "Secret heading",
      '<div hidden><button>Buy now</button></div><p>FAKE_SECRET</p>'), primary);
    const result = compareIntentObservations(target, [observeIntentHtml(shop(), one)],
      { query: "secret chair" });
    expect(target.signals.transactional).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TITLE");
    expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    expect(JSON.stringify(result)).not.toContain("/product");
    expect(result.query_supplied).toBe(true);
  });
  it("stays partial when expected intent is absent and no external competitive set is known", () => {
    const target = observeIntentHtml(page("Guide", "Guide", "<p>Ordinary prose</p>"), primary);
    const result = compareIntentObservations(target, [observeIntentHtml(shop(), one)]);
    expect(result.coverage_limited).toBe(true);
    expect(result.competitors_submitted).toBe(1);
    expect(result.findings.map((f) => f.code)).toContain("no_explicit_intent_evidence");
  });
});
