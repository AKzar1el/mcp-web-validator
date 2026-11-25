import assert from "node:assert/strict";
import test from "node:test";
import {
  compareIntentObservations, queryKeywords, safeIntentUrl,
} from "../dist/modules/content-schema/competitor-intent-comparison.js";
import { observeIntentHtml } from "../dist/modules/content-schema/extract-competitor-intent.js";

const html = (title, h1, main, schema = "") =>
  '<html><head><title>' + title + '</title>' + schema + '</head><body>'
  + '<nav><a href="/checkout">Buy now</a></nav><header><h1>BEST ERGONOMIC CHAIR</h1></header>'
  + '<main><h1>' + h1 + '</h1>' + main + '</main><footer><address>Header office</address></footer></body></html>';
const jsld = (type, extra = {}) =>
  '<script type="application/ld+json">' + JSON.stringify({ "@type": type, ...extra }) + '</script>';
const primaryUrl = "https://publisher.test/guide", comp1 = "https://shop-one.test/chairs", comp2 = "https://shop-two.test/product";
const read = (markup, url) => observeIntentHtml(markup, url);
const blog = html("A posture lesson", "Posture ergonomics overview",
  "<article><h2>Considerations</h2><p>" + "Discuss seated comfort. ".repeat(9)
  + "</p><h2>Research</h2><p>" + "Explore workspace design. ".repeat(9) + "</p></article>",
  jsld("Article"));
const product = (title) => html(title, title, '<a href="/checkout">Checkout</a><button>Buy now</button>'
  + "<h2>Pricing plans</h2>", jsld("Product", { offers: { "@type": "Offer", price: 299 } }));

test("P1-06 finds only explicit competitive commercial and query heading signals", () => {
  const r = compareIntentObservations(read(blog, primaryUrl),
    [read(product("Best ergonomic chair"), comp1), read(product("Best ergonomic chair reviews"), comp2)],
    { expectedIntent: "commercial", query: "best ergonomic chair" });
  assert.equal(r.primary.signal_counts.informational, 2);
  assert.equal(r.primary.signal_counts.transactional, 0, "Header/footer buy links must not count");
  assert.equal(r.primary.intent_signal_count, 0);
  assert.equal(r.competitors_with_intent_signals, 2);
  assert(r.findings.some((f) => f.code === "primary_intent_signal_gap"));
  assert(r.findings.some((f) => f.code === "primary_heading_query_gap"));
  assert.equal(r.primary.query_h1_coverage_percent, 0);
  assert(r.competitors.every((c) => c.intent_signal_count > 0));
  assert(r.coverage_limited);
});

test("P1-06 does not claim an intent gap when primary has matching informational signals", () => {
  const r = compareIntentObservations(read(blog, primaryUrl),
    [read(product("Chair store"), comp1)], { expectedIntent: "informational" });
  assert(r.primary.signal_counts.informational >= 1);
  assert(!r.findings.some((f) => f.code === "primary_intent_signal_gap"));
  assert(!r.findings.some((f) => f.code === "primary_heading_query_gap"));
});

test("P1-06 identifies checkout, offer, local contact and review/FAQ signals", () => {
  const markup = html("Local product", "Buy a chair",
    '<a href="/contact/">Contact</a><address>Office</address><form><button>Order now</button></form>',
    jsld("FAQPage") + jsld("Review") + jsld("Product", { offers: { "@type": "Offer", price: 100 } }));
  const value = read(markup, primaryUrl);
  assert(value.signals.informational.includes("faq_schema"));
  assert(value.signals.commercial.includes("review_schema"));
  assert(value.signals.commercial.includes("product_schema"));
  assert(value.signals.transactional.includes("offer_schema"));
  assert(value.signals.transactional.includes("purchase_action"));
  assert(value.signals.transactional.includes("purchase_form"));
  assert(value.signals.navigational.includes("main_contact_link"));
  assert(value.signals.navigational.includes("main_address"));
});

test("P1-06 refuses invalid, duplicated and same-site competitor origins", () => {
  const p = read(blog, primaryUrl);
  assert.throws(() => compareIntentObservations(p, []), /one to six/);
  assert.throws(() => compareIntentObservations(p, [read(blog, "https://publisher.test/other")]), /distinct origins/);
  assert.throws(() => compareIntentObservations(p, [read(blog, comp1), read(blog, comp1)]), /distinct origins/);
  assert.equal(safeIntentUrl("https://user:password@one.test/a"), undefined);
  assert.equal(safeIntentUrl("https://one.test/a?key=FAKE_TOKEN"), undefined);
  assert.equal(safeIntentUrl("http://one.test:444/a"), undefined);
});

test("P1-06 unknown intent and query do not turn absent signals into SEO verdicts", () => {
  const r = compareIntentObservations(read(html("Guide", "Guide", "<p>Read me.</p>"), primaryUrl),
    [read(html("Shop", "Shop", "<p>Shop here.</p>"), comp1)]);
  assert.equal(r.query_supplied, false);
  assert.equal(r.usable_query_terms, 0);
  assert(r.findings.some((f) => f.code === "no_explicit_intent_evidence"));
  assert(r.coverage_limited);
  assert.match(r.limitations.join(" "), /not Google's interpretation/);
});

test("P1-06 query is normalized, deduped, bounded, not disclosed, and synonym-free", () => {
  assert.deepEqual(queryKeywords("How to buy a chair chair?"), ["buy", "chair"]);
  assert.equal(queryKeywords("x".repeat(161)).length, 0);
  assert.deepEqual(queryKeywords("How is the"), []);
  const query = "PRIVATE_SECRET_SEED best ergonomic chair";
  const r = compareIntentObservations(read(blog, primaryUrl), [read(product("Best ergonomic chair"), comp1)],
    { query });
  assert(!JSON.stringify(r).includes("PRIVATE_SECRET_SEED"));
  assert(!JSON.stringify(r).includes("/guide"));
  assert(!JSON.stringify(r).includes("/chairs"));
});

test("P1-06 bounds extracted signal arrays and limits opaque JSON-LD parsing", () => {
  const repeated = Array.from({ length: 200 }, () => "<h2>Price comparison</h2>").join("");
  const observed = read(html("Test", "Test", repeated,
    Array.from({ length: 5 }, () => jsld("Product")).join("")), primaryUrl);
  assert.equal(observed.extraction_limited, true);
  assert(observed.signals.commercial.includes("pricing_heading"));
  assert(observed.signals.commercial.includes("comparison_heading"));
  const r = compareIntentObservations(observed, [read(product("Ergonomic chair"), comp1)]);
  assert.equal(r.primary.extraction_limited, true);
  assert.equal(r.coverage_limited, true);
});

test("P1-06 skips false checkout intent from hidden or navigation-only elements", () => {
  const value = read(html("Article", "Article", '<nav><a href="/checkout">Buy now</a></nav>'
    + '<div hidden><button>Buy now</button></div><p>Informative text only.</p>'), primaryUrl);
  assert.deepEqual(value.signals.transactional, []);
});

test("P1-06 intent comparison deterministic, outputs only fixed signal names and origins", () => {
  const malicious = html("FAKE_TOKEN secret buy now", "Unknown", '<script>alert(1)</script>'
    + '<p>FAKE_TOKEN_DO_NOT_RETURN</p>');
  const pages = Array.from({ length: 6 }, (_, i) =>
    read(product("Best ergonomic chair"), "https://competitor" + i + ".test/items?id=FAKE_TOKEN"));
  // Query-bearing URL observations are ineligible, even if HTML was supplied.
  assert(pages.every((value) => !value.eligible));
  const safe = Array.from({ length: 6 }, (_, i) =>
    read(product("Best ergonomic chair"), "https://competitor" + i + ".test/items"));
  const p = read(malicious, primaryUrl);
  const r = compareIntentObservations(p, safe, { expectedIntent: "commercial", query: "ergonomic chair" });
  assert.equal(r.competitors.length, 6);
  assert.deepEqual(r, compareIntentObservations(p, safe, { expectedIntent: "commercial", query: "ergonomic chair" }));
  assert(!JSON.stringify(r).includes("FAKE_TOKEN"));
  assert(!JSON.stringify(r).includes("Unknown"));
  assert(Buffer.byteLength(JSON.stringify(r), "utf8") < 7000);
});
