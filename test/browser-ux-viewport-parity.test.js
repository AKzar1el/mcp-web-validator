import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeViewportParity, emptyViewportParityReview,
  MOBILE_VIEWPORT, DESKTOP_VIEWPORT, MAX_PARITY_FINDINGS,
  MAX_PARITY_WORDS, MAX_PARITY_LINKS,
} from "../dist/modules/browser-ux/viewport-parity.js";
import {
  inspectViewportParity, inspectPublicViewportParity,
} from "../dist/modules/browser-ux/viewport-parity-probe.js";

const site = "https://example.com/";
const evidence = (which, overrides = {}) => ({
  width: which === "mobile" ? MOBILE_VIEWPORT.width : DESKTOP_VIEWPORT.width,
  height: which === "mobile" ? MOBILE_VIEWPORT.height : DESKTOP_VIEWPORT.height,
  effective_layout_width: which === "mobile" ? 375 : 1440,
  viewport_meta_present: true,
  title: "A test page",
  description: "A useful description",
  first_h1: "A sensible heading",
  h1_count: 1,
  main_dom_words: ["many","useful","words","for","both","devices"],
  main_visible_words: ["many","useful","words","for","both","devices"],
  same_origin_links: [site + "guide"],
  visible_links: [site + "guide"],
  visible_nav_links: [site + "guide"],
  canonical: site,
  noindex: false,
  jsonld_blocks: 1,
  controls_seen: 2,
  visible_controls: 2,
  keyboard_focusable_controls: 2,
  small_visible_controls: 0,
  observed_keyboard_targets: 2,
  keyboard_incomplete: false,
  disclosure_toggled: true,
  horizontal_overflow_px: 0,
  sample_truncated: false,
  ...overrides,
});
const compare = (mobile = {}, desktop = {}, options = {}) =>
  analyzeViewportParity(site, evidence("mobile", mobile),
    evidence("desktop", desktop), options);
const codes = (report) => report.findings.map((item) => item.code);

test("V09: equivalent desktop/mobile DOM, controls and navigation remain clean", () => {
  const r = compare();
  assert.equal(r.browser_executed, true);
  assert.equal(r.scripts_disabled, true);
  assert.equal(r.mobile.width, 375);
  assert.equal(r.desktop.width, 1440);
  assert.equal(r.titles_equivalent, true);
  assert.equal(r.h1_equivalent, true);
  assert.equal(r.robots_equivalent, true);
  assert.equal(r.mobile_missing_dom_tokens, 0);
  assert.equal(r.mobile_missing_internal_links, 0);
  assert.equal(r.total_findings, 0);
  assert.equal(r.coverage_limited, true);
  assert(!JSON.stringify(r).includes("A test page"));
  assert(!JSON.stringify(r).includes("/guide"));
});

test("V09: distinguish absent mobile DOM content from CSS-hidden but present content", () => {
  const tokens = Array.from({ length: 30 }, (_, i) => "term" + i);
  const r = compare({
    main_dom_words: tokens,
    main_visible_words: tokens.slice(0, 5),
  }, { main_dom_words: tokens, main_visible_words: tokens });
  assert.equal(r.mobile_missing_dom_tokens, 0);
  assert.equal(r.mobile_missing_visible_tokens, 25);
  assert(codes(r).includes("mobile_visible_main_text_less"));
  assert(codes(r).includes("mobile_content_visibility_gap"));
  assert(!codes(r).includes("mobile_main_text_less"));
});

test("V09: genuinely missing mobile main content is distinct from visibility", () => {
  const tokens = Array.from({ length: 30 }, (_, i) => "term" + i);
  const r = compare({
    main_dom_words: tokens.slice(0, 4),
    main_visible_words: tokens.slice(0, 4),
  }, { main_dom_words: tokens, main_visible_words: tokens });
  assert.equal(r.mobile_missing_dom_tokens, 26);
  assert(codes(r).includes("mobile_main_text_less"));
  assert(codes(r).includes("mobile_visible_main_text_less"));
});

test("V09: collapsed mobile navigation can preserve DOM links while visible links differ", () => {
  const r = compare({
    visible_nav_links: [], visible_links: [],
    visible_controls: 1, keyboard_focusable_controls: 1,
    observed_keyboard_targets: 1,
  });
  assert.equal(r.mobile_missing_internal_links, 0);
  assert.equal(r.mobile_missing_visible_links, 1);
  assert(codes(r).includes("mobile_navigation_less"));
  assert(!codes(r).includes("mobile_links_less"));
  assert(r.findings.some((f) => f.code === "mobile_navigation_less" && f.severity === "info"));
});

test("V09: metadata/indexable divergence, overflow and unsafe targets yield bounded review leads", () => {
  const lostWords = Array.from({ length: 22 }, (_, i) => "extra" + i);
  const r = compare({
    viewport_meta_present: false, effective_layout_width: 980,
    title: "", description: "", first_h1: "", h1_count: 0,
    main_dom_words: [], main_visible_words: [],
    canonical: site + "mobile", noindex: true, jsonld_blocks: 0,
    same_origin_links: [], visible_links: [], visible_nav_links: [],
    visible_controls: 0, keyboard_focusable_controls: 0,
    observed_keyboard_targets: 0, disclosure_toggled: false,
    small_visible_controls: 0, horizontal_overflow_px: 85,
    sample_truncated: true, keyboard_incomplete: true,
  }, {
    main_dom_words: lostWords, main_visible_words: lostWords,
    same_origin_links: [site + "guide", site + "nested"],
    visible_links: [site + "guide", site + "nested"],
  }, { blockedResources: 2 });
  assert.equal(r.mobile_missing_dom_tokens, 22);
  assert.equal(r.mobile_missing_internal_links, 2);
  assert.equal(r.robots_equivalent, false);
  assert.equal(r.canonicals_equivalent, false);
  for (const code of [
    "mobile_viewport_meta_missing", "mobile_horizontal_overflow",
    "mobile_title_missing", "mobile_description_missing", "mobile_h1_missing",
    "mobile_main_text_less", "mobile_canonical_mismatch",
    "mobile_robots_mismatch", "mobile_structured_data_less",
    "mobile_links_less", "native_disclosure_parity", "resource_loads_blocked",
  ]) assert(codes(r).includes(code), code);
  assert(r.findings.length <= MAX_PARITY_FINDINGS);
  assert.equal(r.findings_truncated, r.total_findings > MAX_PARITY_FINDINGS);
  assert(!JSON.stringify(r).includes("/nested"));
});

test("V09: mobile target dimensions are informational, not a WCAG conformance verdict", () => {
  const r = compare({ small_visible_controls: 2 });
  assert(codes(r).includes("mobile_small_targets"));
  assert.equal(r.findings.find((f) => f.code === "mobile_small_targets").severity, "info");
  assert(!JSON.stringify(r).includes("WCAG violation"));
});

test("V09: all text/URL signals are redacted from the final output", () => {
  const secret = "secret-sensitive-mobile-title-451";
  const r = compare({
    title: secret, description: secret, first_h1: secret,
    same_origin_links: [site + "private-451"],
    visible_links: [site + "private-451"],
    visible_nav_links: [site + "private-451"],
  });
  assert.equal(r.titles_equivalent, false);
  for (const value of [secret, "private-451", "/guide"]) {
    assert(!JSON.stringify(r).includes(value));
  }
  assert(r.findings.every((f) => !f.message.includes("https://")));
});

test("V09: malformed, excessive and hostile evidence fails closed", () => {
  for (const [m, d, url] of [
    [{ width: 500 }, {}, site],
    [{ h1_count: -1 }, {}, site],
    [{ main_dom_words: Array(MAX_PARITY_WORDS + 1).fill("a") }, {}, site],
    [{ same_origin_links: Array(MAX_PARITY_LINKS + 1).fill(site) }, {}, site],
    [{ canonical: "javascript:alert(1)" }, {}, site],
    [{ canonical: "unverified" }, { canonical: "unverified" }, "file:///etc/passwd"],
    [{ same_origin_links: ["https://other.example.com/private"] }, {}, site],
    [{ main_visible_words: [123] }, {}, site],
    [{ visible_controls: 121, controls_seen: 2 }, {}, site],
    [{ disclosure_toggled: "true" }, {}, site],
    [{ horizontal_overflow_px: -1 }, {}, site],
    [{ title: "X".repeat(1_100) }, {}, site],
    [{}, {}, "file:///etc/passwd"],
  ]) {
    assert.throws(() => analyzeViewportParity(url,
      evidence("mobile", m), evidence("desktop", d)));
  }
  assert.throws(() => compare({}, {}, { blockedResources: 1001 }));
  assert.equal(emptyViewportParityReview().browser_executed, false);
});

test("V09: unsafe or excessive supplied HTML fails before Chromium is launched", async () => {
  const fake = { async launch() { throw new Error("Should never launch"); } };
  await assert.rejects(inspectViewportParity("x".repeat(400_001), site, fake));
  await assert.rejects(inspectViewportParity("<p>Hello</p>", "http://127.0.0.1/", fake));
  await assert.rejects(inspectViewportParity("<p>Hello</p>", site + "?secret=abc", fake));
  await assert.rejects(inspectPublicViewportParity("http://localhost/", fake));
});

// Opt-in real Chromium regression: requires an installed headless shell. The
// isolated V09 runtime disables scripts and blocks all network requests.
test("V09 Chromium: inert main scripts and styles are not visible-content gaps", {
  skip: process.env.WEBVALIDATOR_CHROMIUM_REGRESSION !== "1",
  timeout: 120_000,
}, async () => {
  const visible = "Visible product description available on both screen sizes";
  const base = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><p>${visible}</p>`;
  const end = "</main></body></html>";
  const inertWords = Array.from({ length: 45 }, (_, i) => `schemaword${i}`).join(" ");
  const cases = [
    ["baseline", base + end, false],
    ["JSON-LD and style", base + `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", description: inertWords })}</script><style>.notused{--description:${inertWords}}</style>` + end, false],
    ["CSS-hidden genuine text", base + `<span style="display:none">${inertWords}</span>` + end, true],
  ];
  for (const [label, html, shouldWarn] of cases) {
    const report = await inspectViewportParity(html, site);
    assert.equal(report.browser_executed, true, label);
    assert.equal(report.scripts_disabled, true, label);
    assert.equal(report.findings.some((f) => f.code === "mobile_content_visibility_gap"), shouldWarn, label);
    assert(!JSON.stringify(report).includes("schemaword"), label);
    if (label === "JSON-LD and style") assert.equal(report.mobile.jsonld_blocks, 1);
  }
});

test("V09: native disclosure can be unverified without claiming a failure", () => {
  const r = compare({ disclosure_toggled: null }, { disclosure_toggled: null });
  assert(!codes(r).includes("native_disclosure_parity"));
  assert.equal(r.mobile.disclosure_toggled, null);
  assert.equal(r.desktop.disclosure_toggled, null);
});
