import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeMultilingualClusters,
  observeMultilingualPage,
  normalizeHreflangLocale,
  MAX_MULTILINGUAL_FINDINGS,
} from "../dist/modules/site-architecture/multilingual-clusters.js";

const locales = ["en", "de", "fr", "es", "it", "pt", "nl", "sv", "no", "da", "fi", "pl", "cs", "sk", "hu", "sl"];
const target = (language) => "https://example.test/" + language + "/";
const tags = (localeMap) => [...localeMap].map(([locale, url]) =>
  '<link rel="alternate" hreflang="' + locale + '" href="' + url + '">').join("");
const canonical = (url) => '<link rel="canonical" href="' + url + '">';
const html = (language, links = [], chosenCanonical) => '<!doctype html><html lang="' + language
  + '"><head><title>Localized page</title>' + (chosenCanonical ? canonical(chosenCanonical) : "")
  + tags(links) + '</head><body><main><p>Localized text</p></main></body></html>';
const observe = (url, body) => observeMultilingualPage(body, url);
const fullReferences = [...locales.map((language) => [language, target(language)]), ["x-default", target("en")]];
const fullPages = () => locales.map((language) =>
  observe(target(language), html(language, fullReferences, target(language))));

test("P1-02 validates all sixteen fully reciprocal canonical locales plus x-default", () => {
  const pages = fullPages();
  assert.equal(pages.length, 16);
  assert.equal(pages[0].references.length, 17);
  const report = analyzeMultilingualClusters(pages);
  assert.deepEqual({
    sampled: report.sampled_pages, eligible: report.eligible_pages,
    alternates: report.pages_with_alternates, locales: report.locales_observed,
    unseen: report.unobserved_targets, findings: report.total_findings,
    limited: report.coverage_limited,
  }, { sampled: 16, eligible: 16, alternates: 16, locales: 16, unseen: 0, findings: 0, limited: false });
  assert.deepEqual(report.findings, []);
});

test("P1-02 supports 16-locale declarations when hosted sample covers only eight pages", () => {
  const report = analyzeMultilingualClusters(fullPages().slice(0, 8),
    { sampledPages: 8, coverageLimited: true });
  assert.equal(report.eligible_pages, 8);
  assert.equal(report.locales_observed, 16);
  assert.equal(report.unobserved_targets, 8);
  assert.equal(report.coverage_limited, true);
  assert.ok(!report.findings.some((finding) => finding.code === "multilingual.return_link_missing"));
});

test("P1-02 normalizes supported region and script codes, rejecting malformed and unsupported tokens", () => {
  const valid = new Map([
    ["EN-us", "en-US"], ["zh-hant-tw", "zh-Hant-TW"], ["sr-latn-rs", "sr-Latn-RS"],
    ["en", "en"], ["X-DEFAULT", "x-default"],
  ]);
  for (const [value, expected] of valid) assert.equal(normalizeHreflangLocale(value), expected, value);
  for (const value of ["", "US", "en-UK", "en-EU", "en-UN", "en-419", "en-AA", "zz", "x-private", "en-US-u-ca-gregory"]) {
    assert.equal(normalizeHreflangLocale(value), undefined, value);
  }
});

test("P1-02 reports missing sampled reciprocal return but never declares an unsampled target broken", () => {
  const en = target("en");
  const de = target("de");
  const first = observe(en, html("en", [["en", en], ["de", de]], en));
  const second = observe(de, html("de", [["de", de]], de));
  const findings = analyzeMultilingualClusters([first, second]).findings;
  assert(findings.some((finding) => finding.code === "multilingual.return_link_missing"));
  assert(!analyzeMultilingualClusters([first], { coverageLimited: true }).findings
    .some((finding) => finding.code === "multilingual.return_link_missing"));
});

test("P1-02 does not count x-default alone as a localized reciprocal link", () => {
  const en = target("en"), de = target("de");
  const source = observe(en, html("en", [["en", en], ["de", de]], en));
  const destination = observe(de, html("de", [["de", de], ["x-default", en]], de));
  const analysis = analyzeMultilingualClusters([source, destination]);
  assert(analysis.findings.some((finding) =>
    finding.code === "multilingual.return_link_missing"
    && finding.example_urls.includes(en) && finding.example_urls.includes(de)));
});

test("P1-02 detects omitted self references even when x-default points to the current page", () => {
  const en = target("en");
  const de = target("de");
  const first = observe(en, html("en", [["de", de], ["x-default", en]], en));
  const report = analyzeMultilingualClusters([first]);
  assert(report.findings.some((finding) => finding.code === "multilingual.self_reference_missing"));
});

test("P1-02 distinguishes duplicate, conflicting and mismatched hreflang targets", () => {
  const en = target("en");
  const de = target("de");
  const first = observe(en, html("en", [
    ["en", en], ["en", en], ["en", de], ["de", de],
  ], en));
  const second = observe(de, html("en", [["en", en], ["de", de]], de));
  const report = analyzeMultilingualClusters([first, second]);
  const codes = report.findings.map((f) => f.code);
  assert(codes.includes("multilingual.locale_conflict"));
  assert(codes.includes("multilingual.repeated_locale"));
  assert(codes.includes("multilingual.language_signal_mismatch"));
  assert.equal(first.conflicting_locales, 1);
  assert.equal(first.repeated_locales, 1);
  assert(report.coverage_limited);
});

test("P1-02 rejects secret query targets and credentialed canonical URLs without echoing them", () => {
  const url = target("en");
  const first = observe(url, html("en", [
    ["en", url], ["de", "https://example.test/de/?token=FAKE_TOKEN"],
    ["fr", "https://USER:SECRET@example.test/fr/"],
  ], "https://example.test/en/?session=FAKE_TOKEN"));
  const report = analyzeMultilingualClusters([first]);
  assert.equal(first.canonical_state, "unverifiable");
  assert.equal(first.invalid_declarations, 2);
  assert(report.findings.some((f) => f.code === "multilingual.unusable_declaration"));
  assert(report.findings.some((f) => f.code === "multilingual.canonical_ambiguous"));
  assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(report), /FAKE_TOKEN|USER:SECRET/);
});

test("P1-02 requires head-only, full absolute alternate URLs and rejects mixed media annotations", () => {
  const url = target("en");
  const body = '<html lang=en><head><link rel=canonical href="' + url
    + '"><link rel=alternate hreflang=de href="/de">'
    + '<link rel=alternate hreflang=fr href="https://example.test/fr/" media="print">'
    + '<link rel=alternate hreflang=es>'
    + '</head><body><link rel=alternate hreflang=it href="https://example.test/it/"></body></html>';
  const first = observe(url, body);
  assert.equal(first.invalid_declarations, 3);
  assert.deepEqual(first.references, []);
  const report = analyzeMultilingualClusters([first]);
  assert.equal(report.invalid_declarations, 3);
  assert.equal(report.unobserved_targets, 0);
  assert(report.coverage_limited);
});

test("P1-02 detects canonical conflict, cycles and chains among sampled alternates", () => {
  const en = target("en"), de = target("de"), fr = target("fr");
  const refs = [["en", en], ["de", de], ["fr", fr]];
  const cycle = analyzeMultilingualClusters([
    observe(en, html("en", refs, de)),
    observe(de, html("de", refs, en)),
  ]);
  assert(cycle.findings.some((f) => f.code === "multilingual.canonical_cycle"));
  assert(cycle.findings.some((f) => f.code === "multilingual.non_self_canonical"));
  assert(cycle.findings.some((f) => f.code === "multilingual.target_not_canonical"));
  const chain = analyzeMultilingualClusters([
    observe(en, html("en", refs, de)),
    observe(de, html("de", refs, fr)),
    observe(fr, html("fr", refs, fr)),
  ]);
  assert(chain.findings.some((f) => f.code === "multilingual.canonical_chain"));
});

test("P1-02 isolates unrelated page clusters rather than incorrectly cross-matching locales", () => {
  const a = "https://example.test/shop/en", b = "https://example.test/shop/de";
  const c = "https://example.test/blog/en", d = "https://example.test/blog/de";
  const pages = [
    observe(a, html("en", [["en", a], ["de", b]], a)),
    observe(b, html("de", [["en", a], ["de", b]], b)),
    observe(c, html("en", [["en", c], ["de", d]], c)),
    observe(d, html("de", [["en", c], ["de", d]], d)),
  ];
  assert.equal(analyzeMultilingualClusters(pages).total_findings, 0);
});

test("P1-02 compares supplied cross-origin locale pages without initiating any network request", () => {
  const english = "https://en.example.test/product";
  const german = "https://de.example.test/product";
  const links = [["en", english], ["de", german]];
  const pages = [
    observe(english, html("en", links, english)),
    observe(german, html("de", links, german)),
  ];
  const report = analyzeMultilingualClusters(pages);
  assert.equal(report.total_findings, 0);
  assert.equal(report.unobserved_targets, 0);
  assert.equal(report.coverage_limited, false);
});

test("P1-02 detects inconsistent linked cluster targets and missing locale mappings", () => {
  const en = target("en"), de = target("de"), fr = target("fr"), other = target("other");
  const first = observe(en, html("en", [["en", en], ["de", de], ["fr", fr]], en));
  const second = observe(de, html("de", [["de", de], ["en", other]], de));
  const report = analyzeMultilingualClusters([first, second]);
  assert(report.findings.some((f) => f.code === "multilingual.cluster_target_conflict"));
  assert(report.findings.some((f) => f.code === "multilingual.cluster_incomplete"));
});

test("P1-02 caps per-page 16 locales and scan count and reports limited coverage", () => {
  const url = target("en");
  const links = Array.from({ length: 70 }, (_, i) => ["en", "https://example.test/v" + i + "/"]);
  const page = observe(url, html("en", links, url));
  assert.equal(page.declarations_truncated, true);
  assert(page.conflicting_locales >= 1);
  const report = analyzeMultilingualClusters([page]);
  assert(report.findings.some((f) => f.code === "multilingual.locale_limit"));
  assert(report.coverage_limited);
});

test("P1-02 preserves exact finding counts while bounding returned findings and output bytes", () => {
  const urls = Array.from({ length: 16 }, (_, i) => "https://example.test/u/" + i);
  const pages = urls.map((url, i) =>
    observe(url, html("en", [["en", url], ["de", urls[(i + 1) % 16]]], url)));
  const report = analyzeMultilingualClusters(pages);
  assert(report.total_findings > MAX_MULTILINGUAL_FINDINGS);
  assert.equal(report.findings.length, MAX_MULTILINGUAL_FINDINGS);
  assert.equal(report.findings_truncated, true);
  assert(Buffer.byteLength(JSON.stringify(report), "utf8") < 14_000);
  assert.deepEqual(report, analyzeMultilingualClusters(pages));
});

test("P1-02 includes late high-priority errors even when the diagnostic preview is already full", () => {
  const pages = Array.from({ length: 16 }, (_, i) => {
    const own = "https://example.test/chapter/" + i;
    const links = [["en", own], ["en", own]];
    if (i === 15) {
      links.push(["de", target("de")], ["de", target("fr")]);
    }
    return observe(own, html("en", links, own));
  });
  const result = analyzeMultilingualClusters(pages);
  assert(result.total_findings > MAX_MULTILINGUAL_FINDINGS);
  assert.equal(result.findings.length, MAX_MULTILINGUAL_FINDINGS);
  assert(result.findings_truncated);
  assert.equal(result.findings[0].code, "multilingual.locale_conflict");
  assert.equal(result.findings[0].severity, "error");
});

test("P1-02 skips query-bearing labels, oversized pages and duplicate final URLs without claiming complete coverage", () => {
  const url = target("en");
  const pages = [
    observe(url, html("en", [["en", url]], url)),
    observe(url, html("en", [["en", url]], url)),
    observe("https://example.test/page?key=FAKE_TOKEN", html("en")),
    observe(target("de"), "x".repeat(260_000)),
  ];
  const report = analyzeMultilingualClusters(pages);
  assert.equal(report.eligible_pages, 1);
  assert.equal(report.sampled_pages, 4);
  assert.equal(report.coverage_limited, true);
  assert.doesNotMatch(JSON.stringify(report), /FAKE_TOKEN/);
});

test("P1-02 fails fast if callers exceed the approved page and sample count", () => {
  assert.throws(() => analyzeMultilingualClusters(Array.from({ length: 17 }, () => observe(target("en"), "<html></html>"))),
    /at most 16/);
  assert.throws(() => analyzeMultilingualClusters([observe(target("en"), "<html></html>")], { sampledPages: 0 }),
    /sampledPages/);
});
