import assert from "node:assert/strict";
import test from "node:test";
import { load as loadCheerio } from "cheerio";
import {
  analyzeHttpsSecurity, emptyHttpsSecurityReview,
  MAX_SECURITY_PAGES, MAX_SECURITY_FINDINGS, MAX_SECURITY_DOM_ELEMENTS,
  MAX_SECURITY_HTML_BYTES, MAX_SECURITY_TOTAL_HTML_BYTES,
  MAX_SECURITY_RESOURCE_DECLARATIONS,
} from "../dist/modules/http-crawl/https-security.js";

const https = "https://example.test/";
const http = "http://example.test/";
const page = (extra = {}) => ({ url: https, status_code: 200, ...extra });
const review = (...items) => analyzeHttpsSecurity(items, loadCheerio);
const found = (data, code) => data.findings.filter((f) => f.code === code);

test("P1-13: offline secure headers and mixed-free supplied HTML report observed signals, not security certification", () => {
  const r = review(page({
    strict_transport_security: ["max-age=31536000; includeSubDomains; preload"],
    content_security_policy: ["default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests"],
    content_security_policy_report_only: ["default-src 'self'"],
    referrer_policy: "strict-origin-when-cross-origin",
    x_content_type_options: "nosniff",
    x_frame_options: "DENY",
    htmlContent: '<html><head><title>Safe</title></head><body><script src="/app.js"></script><form action="/submit"></form></body></html>',
  }));
  assert.equal(r.scope, "caller_supplied_https_security_evidence_only");
  assert.equal(r.pages_sampled, 1);
  assert.equal(r.https_observations, 1);
  assert.equal(r.http_observations, 0);
  assert.equal(r.https_without_hsts_observation, 0);
  assert.equal(r.enforced_csp_observations, 1);
  assert.equal(r.report_only_csp_observations, 0);
  assert.equal(r.mixed_blockable_declarations, 0);
  assert.equal(r.insecure_form_actions, 0);
  assert.equal(r.pages[0].hsts_state, "enabled");
  assert.equal(r.pages[0].hsts_include_subdomains, true);
  assert.equal(r.pages[0].hsts_preload_declared, true);
  assert.equal(r.pages[0].csp_state, "both");
  assert.equal(r.pages[0].csp_upgrade_insecure_requests, true);
  assert.equal(r.pages[0].frame_protection_observed, true);
  assert.equal(r.pages[0].nosniff_observed, true);
  assert.equal(r.pages[0].referrer_policy_observed, true);
  assert.equal(r.total_findings, 0);
  assert.equal(r.coverage_limited, true);
  assert(r.limitations.join(" ").includes("no TLS handshake"));
});

test("P1-13: HTTP 301/308 explicitly upgrading to HTTPS distinguished from HTTP 200", () => {
  const r = review(
    { url: http, status_code: 301, location: "https://example.test/new" },
    { url: "http://example.test/old", status_code: 308, location: "//example.test/again" },
    { url: "http://example.test/plain", status_code: 200 },
    page(),
  );
  assert.equal(r.http_observations, 3);
  assert.equal(r.https_redirect_declarations, 1);
  assert.equal(r.http_without_secure_redirect, 2);
  assert.equal(r.pages[0].https_redirect_declared, true);
  assert.equal(r.pages[1].insecure_redirect_declared, true);
  assert.equal(r.pages[2].https_redirect_declared, false);
  assert.equal(found(r, "http_redirect_not_https").length, 1);
  assert.equal(found(r, "http_success_without_redirect").length, 1);
});

test("P1-13: missing/unresolvable or credential-bearing redirects do not become secure", () => {
  for (const location of [undefined, "javascript:alert(1)", "https://u:p@example.test/foo", "ftp://example.test/file"]) {
    const r = review({ url: http, status_code: 302, location });
    assert.equal(r.http_without_secure_redirect, 1);
    assert.equal(r.pages[0].unresolved_redirect, true);
    assert.equal(found(r, "http_redirect_unresolved").length, 1);
  }
});

test("P1-13: HTTP 304 cache validation is not mislabeled a redirect with a missing Location", () => {
  const r = review({ url: http, status_code: 304 });
  assert.equal(r.pages[0].unresolved_redirect, false);
  assert.equal(found(r, "http_redirect_unresolved").length, 0);
  assert.equal(r.http_without_secure_redirect, 1);
});

test("P1-13: HSTS is ignored over HTTP, even with strong-looking directives", () => {
  const r = review({ url: http, status_code: 200,
    strict_transport_security: ["max-age=31536000; includeSubDomains"] });
  assert.equal(r.pages[0].hsts_state, "http_ignored");
  assert.equal(r.pages[0].hsts_include_subdomains, false);
  assert.equal(found(r, "hsts_http_ignored").length, 1);
});

test("P1-13: absent HTTPS HSTS is an incomplete observation, not proof HSTS disabled", () => {
  const r = review(page());
  assert.equal(r.pages[0].hsts_state, "absent");
  assert.equal(r.https_without_hsts_observation, 1);
  assert.equal(r.hsts_disabled_or_invalid, 0);
  assert.equal(found(r, "hsts_missing_observation")[0].severity, "info");
});

test("P1-13: max-age=0 disables observed HTTPS HSTS and quoted max-age is supported", () => {
  const disabled = review(page({ strict_transport_security: ['max-age="0"; includeSubDomains'] }));
  assert.equal(disabled.pages[0].hsts_state, "disabled");
  assert.equal(disabled.pages[0].hsts_include_subdomains, false);
  assert.equal(disabled.hsts_disabled_or_invalid, 1);
  assert.equal(found(disabled, "hsts_disabled").length, 1);
  const valid = review(page({ strict_transport_security: ['max-age="1000"; includeSubDomains'] }));
  assert.equal(valid.pages[0].hsts_state, "enabled");
});

test("P1-13: malformed, negative, missing, duplicate and conflicting HSTS directives are distinguished", () => {
  for (const bad of [
    "max-age=abc", "max-age=-1", "includeSubDomains",
    "max-age=100; max-age=200", "max-age=1e3",
  ]) {
    const r = review(page({ strict_transport_security: [bad] }));
    assert.equal(r.pages[0].hsts_state, "invalid");
    assert.equal(found(r, "hsts_invalid").length, 1);
  }
  const repeatedSame = review(page({
    strict_transport_security: ["max-age=100; includeSubDomains", "max-age=100; includeSubDomains"],
  }));
  assert.equal(repeatedSame.pages[0].hsts_state, "enabled");
  const contradictory = review(page({
    strict_transport_security: ["max-age=100", "max-age=0"],
  }));
  assert.equal(contradictory.pages[0].hsts_state, "conflicting");
  assert.equal(found(contradictory, "hsts_conflicting").length, 1);
});

test("P1-13: CSP report-only does not set enforced security or upgrade-insecure-requests", () => {
  const r = review(page({
    content_security_policy_report_only: ["default-src 'self'; upgrade-insecure-requests"],
  }));
  assert.equal(r.pages[0].csp_state, "report_only");
  assert.equal(r.pages[0].csp_upgrade_insecure_requests, false);
  assert.equal(r.enforced_csp_observations, 0);
  assert.equal(r.report_only_csp_observations, 1);
  assert.equal(found(r, "csp_report_only").length, 1);
});

test("P1-13: CSP upgrade token exact, not a prefix or an unrelated directive value", () => {
  const r = review(page({
    content_security_policy: ["default-src 'self'; upgrade-insecure-requests-fake; script-src upgrade-insecure-requests"],
  }));
  assert.equal(r.pages[0].csp_state, "enforced");
  assert.equal(r.pages[0].csp_upgrade_insecure_requests, false);
  assert.equal(r.pages[0].frame_protection_observed, false);
});

test("P1-13: blank policy is not enforcing, meta CSP plus report-only is not report-only protection", () => {
  const empty = review(page({ content_security_policy: ["  "] }));
  assert.equal(empty.pages[0].csp_state, "absent");
  const both = review(page({
    content_security_policy_report_only: ["default-src 'none'"],
    htmlContent: '<head><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"></head>',
  }));
  assert.equal(both.pages[0].csp_state, "both");
  assert.equal(both.enforced_csp_observations, 1);
  assert.equal(both.report_only_csp_observations, 0);
  assert.equal(both.pages[0].csp_upgrade_insecure_requests, true);
});

test("P1-13: head meta CSP can request upgrades, but meta frame-ancestors does not protect framing", () => {
  const r = review(page({
    htmlContent: '<html><head><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests; frame-ancestors none"></head>' +
      '<body><p>Safe text</p></body></html>',
  }));
  assert.equal(r.pages[0].csp_state, "meta_only");
  assert.equal(r.pages[0].csp_upgrade_insecure_requests, true);
  assert.equal(r.pages[0].frame_protection_observed, false);
  assert.equal(found(r, "frame_protection_unobserved").length, 1);
});

test("P1-13: weak explicit Referrer-Policy and legacy frame header do not imply protection", () => {
  const r = review(page({
    referrer_policy: "unsafe-url", x_frame_options: "ALLOW-FROM https://trusted.example",
    x_content_type_options: "invalid-value",
  }));
  assert.equal(r.pages[0].weak_referrer_policy, true);
  assert.equal(r.pages[0].frame_protection_observed, false);
  assert.equal(r.pages[0].nosniff_observed, false);
  assert.equal(found(r, "weak_referrer_policy").length, 1);
});

test("P1-13: Referrer-Policy fallback uses the last recognized value", () => {
  const safe = review(page({ referrer_policy: "unsafe-url, unknown-future-value, strict-origin-when-cross-origin" }));
  assert.equal(safe.pages[0].weak_referrer_policy, false);
  const weak = review(page({ referrer_policy: "strict-origin-when-cross-origin, unsafe-url" }));
  assert.equal(weak.pages[0].weak_referrer_policy, true);
});

test("P1-13: static mixed content distinguishes blockable script/styles/iframes from upgradable images/media", () => {
  const htmlContent = '<html><head><link rel=stylesheet href="http://cdn.test/style.css">' +
    '<style>body{background-image:url("http://cdn.test/bg.png")}</style></head><body>' +
    '<script src="http://cdn.test/app.js"></script>' +
    '<iframe src="http://embed.test/widget"></iframe>' +
    '<img src="http://cdn.test/image.jpg"><video src="http://cdn.test/movie.mp4"></video>' +
    '<audio src="http://cdn.test/audio.mp3"></audio>' +
    '<form action="http://example.test/submit"><button type=submit>Go</button></form>' +
    '</body></html>';
  const r = review(page({ htmlContent }));
  assert.equal(r.mixed_blockable_declarations, 4);
  assert.equal(r.mixed_upgradable_declarations, 3);
  assert.equal(r.insecure_form_actions, 1);
  assert.equal(found(r, "mixed_blockable").length, 1);
  assert.equal(found(r, "mixed_upgradable_candidate").length, 1);
  assert.equal(found(r, "insecure_form_action").length, 1);
});

test("P1-13: explicit IPv4/IPv6 HTTP img host is not counted as auto-upgradable", () => {
  const r = review(page({ htmlContent: '<html><body><img src="http://127.0.0.1/image.png">' +
    '<img src="http://[::1]/image.png"><img src="http://static.example.test/image.png"></body></html>' }));
  assert.equal(r.pages[0].mixed_ip_host_declarations, 2);
  assert.equal(r.mixed_blockable_declarations, 2);
  assert.equal(r.mixed_upgradable_declarations, 1);
});

test("P1-13: img srcset and picture/source srcset are potentially blockable unlike ordinary img src", () => {
  const r = review(page({ htmlContent: '<picture><source srcset="http://cdn.test/1.webp 1x, http://cdn.test/2.webp 2x">' +
    '<img srcset="http://cdn.test/3.jpg 3x" src="http://cdn.test/4.jpg"></picture>' }));
  assert.equal(r.mixed_blockable_declarations, 3);
  assert.equal(r.mixed_upgradable_declarations, 1);
});

test("P1-13: protocol-relative/relative/data/HTTPS URLs and normal links are not classified as insecure subresources", () => {
  const r = review(page({ htmlContent: '<html><body><img src="//cdn.example.test/image.png">' +
    '<script src="/assets/app.js"></script><img src="data:image/png;base64,AA">' +
    '<a href="http://example.test/next">Ordinary navigation link</a>' +
    '<form action="/submit"><button formaction="https://example.test/do">Go</button></form>' +
    '</body></html>' }));
  assert.equal(r.mixed_blockable_declarations, 0);
  assert.equal(r.mixed_upgradable_declarations, 0);
  assert.equal(r.insecure_form_actions, 0);
});

test("P1-13: insecure base href makes relative resources/forms insecure", () => {
  const r = review(page({ htmlContent: '<html><head><base href="http://cdn.test/"></head>' +
    '<body><script src="app.js"></script><img src="a.jpg">' +
    '<form action="submit"></form></body></html>' }));
  assert.equal(r.pages[0].insecure_base_href, true);
  assert.equal(r.mixed_blockable_declarations, 1);
  assert.equal(r.mixed_upgradable_declarations, 1);
  assert.equal(r.insecure_form_actions, 1);
  assert.equal(found(r, "insecure_base_href").length, 1);
});

test("P1-13: script strings, template content and a[href] are not misrepresented as fetched requests", () => {
  const r = review(page({ htmlContent: '<html><body>' +
    '<script>fetch("http://api.test/private")</script>' +
    '<template><img src="http://cdn.test/not-active"></template>' +
    '<a href="http://example.test/nav">Visit</a></body></html>' }));
  assert.equal(r.mixed_blockable_declarations, 0);
  assert.equal(r.mixed_upgradable_declarations, 0);
});

test("P1-13: 400 HTML node and 160 declaration limits explicitly mark incomplete sample", () => {
  const htmlContent = '<html><body>' +
    Array.from({ length: 250 }, (_, i) => '<img src="http://cdn.test/' + i + '.jpg">').join("") +
    '</body></html>';
  const r = review(page({ htmlContent }));
  assert.equal(r.pages[0].declarations_truncated, true);
  assert.equal(r.pages_with_truncated_html, 1);
  assert.equal(r.mixed_upgradable_declarations, MAX_SECURITY_RESOURCE_DECLARATIONS);
  assert.equal(found(r, "html_sampling_limited").length, 1);
  assert(MAX_SECURITY_DOM_ELEMENTS > MAX_SECURITY_RESOURCE_DECLARATIONS);
});

test("P1-13: 8 page cap and 12 findings cap preserve totals and redacted output", () => {
  const pages = Array.from({ length: MAX_SECURITY_PAGES }, (_, i) => page({
    url: https + "sample/" + i,
    htmlContent: '<script src="http://cdn.test/secret.js"></script>',
  }));
  const r = review(...pages);
  assert.equal(r.pages_sampled, MAX_SECURITY_PAGES);
  assert(r.total_findings > MAX_SECURITY_FINDINGS);
  assert.equal(r.findings.length, MAX_SECURITY_FINDINGS);
  assert.equal(r.findings_truncated, true);
  assert(r.findings.slice(0, 8).every((f) => f.severity === "warning"));
  assert(!JSON.stringify(r).includes("/sample/"));
  assert(!JSON.stringify(r).includes("secret.js"));
});

test("P1-13: header source, URL path, HTML and fake secrets never echoed", () => {
  const secret = "FAKE_SECRET_FROM_HEADERS_AND_BODY_P113";
  const r = review(page({
    url: "https://example.test/private/" + secret,
    location: "https://example.test/redirect?token=" + secret,
    strict_transport_security: ["max-age=0"],
    content_security_policy: ["default-src 'self'; report-uri /" + secret],
    htmlContent: '<form action="http://example.test/?key=' + secret + '"></form>',
  }));
  assert.equal(r.insecure_form_actions, 1);
  assert(!JSON.stringify(r).includes(secret));
  assert(!JSON.stringify(r).includes("/private/"));
  assert(!JSON.stringify(r).includes("report-uri"));
});

test("P1-13: queries/fragments/credentials/ports in page URL labels rejected before returning data", () => {
  for (const url of [
    "https://example.test/p?token=FAKE_SECRET",
    "https://example.test/p#secret",
    "https://u:p@example.test/",
    "https://example.test:8080/",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => review(page({ url })));
  }
});

test("P1-13: mixed host, duplicate label, missing status and invalid input lengths fail closed", () => {
  assert.throws(() => review());
  assert.throws(() => review(...Array.from({ length: MAX_SECURITY_PAGES + 1 }, (_, i) => page({
    url: https + i,
  }))));
  assert.throws(() => review(page(), page()));
  assert.throws(() => review(page(), page({ url: "https://other.example.test/" })));
  assert.throws(() => review(page({ status_code: -1 })));
  assert.throws(() => review(page({ status_code: 700 })));
  assert.throws(() => review(page({ htmlContent: "" })));
});

test("P1-13: UTF-8 byte caps, aggregate caps, CRLF and repeated headers are enforced", () => {
  assert.throws(() => review(page({ htmlContent: "é".repeat(MAX_SECURITY_HTML_BYTES / 2 + 1) })));
  assert.throws(() => review(
    page({ url: https + "a", htmlContent: "x".repeat(110_000) }),
    page({ url: https + "b", htmlContent: "x".repeat(110_000) }),
    page({ url: https + "c", htmlContent: "x".repeat(110_000) }),
  ));
  assert(MAX_SECURITY_TOTAL_HTML_BYTES > 2 * 110_000);
  assert.throws(() => review(page({ strict_transport_security: ["max-age=1\r\nInjected: true"] })));
  assert.throws(() => review(page({ content_security_policy: ["é".repeat(1_025)] })));
  assert.throws(() => review(page({ strict_transport_security: Array.from({ length: 5 }, () => "max-age=1") })));
});

test("P1-13: failed-observation scaffold is truthful and safe", () => {
  const r = emptyHttpsSecurityReview();
  assert.equal(r.pages_sampled, 0);
  assert.equal(r.coverage_limited, true);
  assert.equal(r.findings.length, 0);
  assert.equal(r.pages.length, 0);
});
