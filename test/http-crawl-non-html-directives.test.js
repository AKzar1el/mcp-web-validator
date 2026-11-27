import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeHttpDirectives, emptyHttpDirectiveReview, safeHttpResourceUrl,
  MAX_HTTP_FINDINGS, MAX_HTTP_RESOURCES, MAX_HTTP_HEADER_VALUES,
  MAX_HTTP_HEADER_BYTES, MAX_HTTP_TOTAL_BYTES,
} from "../dist/modules/http-crawl/non-html-directives.js";

const url = "https://example.test/documents/report.pdf";
const item = (fields = {}) => ({
  url, status_code: 200, content_type: "application/pdf",
  method: "HEAD", ...fields,
});
const matches = (review, code) => review.findings.filter((finding) => finding.code === code);

test("P1-11: bounded PDF HTTP metadata exposes noindex and a single canonical as observed evidence", () => {
  const result = analyzeHttpDirectives([item({
    x_robots_tag: ["noindex, nofollow"],
    link: ['<https://example.test/report/>; rel="canonical"'],
  })]);
  assert.equal(result.scope, "caller_supplied_http_headers_only");
  assert.equal(result.resources_sampled, 1);
  assert.equal(result.non_html_resources, 1);
  assert.equal(result.explicit_noindex_resources, 1);
  assert.equal(result.googlebot_noindex_resources, 1);
  assert.equal(result.canonical_header_resources, 1);
  assert.equal(result.conflicting_robots_resources, 0);
  assert.equal(result.conflicting_canonical_resources, 0);
  assert.equal(result.resources[0].canonical_state, "one");
  assert.equal(result.resources[0].mime_category, "pdf");
  assert.equal(result.resources[0].method, "HEAD");
  assert.equal(matches(result, "explicit_noindex").length, 1);
  assert(result.limitations.join(" ").includes("HEAD response headers"));
  assert(!JSON.stringify(result).includes("/documents/"));
});

test("P1-11: googlebot-specific noindex does not invent global noindex", () => {
  const r = analyzeHttpDirectives([item({ x_robots_tag: ["googlebot: noindex, nofollow"] })]);
  assert.equal(r.resources[0].explicit_noindex, false);
  assert.equal(r.resources[0].googlebot_noindex, true);
  assert.equal(matches(r, "googlebot_noindex").length, 1);
  assert.equal(matches(r, "explicit_noindex").length, 0);
});

test("P1-11: an unrelated user agent or googlebot-news does not become googlebot generic", () => {
  const r = analyzeHttpDirectives([item({
    x_robots_tag: ["otherbot: noindex", "googlebot-news: noindex"],
  })]);
  assert.equal(r.explicit_noindex_resources, 0);
  assert.equal(r.googlebot_noindex_resources, 0);
  assert.equal(r.conflicting_robots_resources, 0);
  assert.equal(matches(r, "googlebot_noindex").length, 0);
});

test("P1-11: distinct named crawler scopes do not create false conflicts", () => {
  const r = analyzeHttpDirectives([item({
    x_robots_tag: ["bingbot: index, follow", "yandex: noindex, nofollow"],
  })]);
  assert.equal(r.conflicting_robots_resources, 0);
  assert.equal(matches(r, "conflicting_robots").length, 0);
  assert.equal(r.googlebot_noindex_resources, 0);
  const same = analyzeHttpDirectives([item({
    x_robots_tag: ["bingbot: index", "BingBot: noindex"],
  })]);
  assert.equal(same.conflicting_robots_resources, 1);
});

test("P1-11: noimageindex is an image-specific declaration, not a general noindex verdict", () => {
  const image = analyzeHttpDirectives([item({
    content_type: "image/png", x_robots_tag: ["googlebot: noimageindex"],
  })]);
  assert.equal(image.googlebot_noindex_resources, 0);
  assert.equal(image.googlebot_noimageindex_resources, 1);
  assert.equal(image.resources[0].googlebot_noimageindex, true);
  assert.equal(matches(image, "explicit_noimageindex").length, 1);
  const otherBot = analyzeHttpDirectives([item({ x_robots_tag: ["otherbot: noimageindex"] })]);
  assert.equal(otherBot.googlebot_noimageindex_resources, 0);
});

test("P1-11: contradictory indexing and link-following tokens are advisory conflicts", () => {
  const r = analyzeHttpDirectives([item({ x_robots_tag: ["index, NOINDEX", "FOLLOW, NOFOLLOW"] })]);
  assert.equal(r.conflicting_robots_resources, 1);
  assert.equal(matches(r, "conflicting_robots").length, 1);
  assert.equal(matches(r, "conflicting_robots")[0].severity, "warning");
});

test("P1-11: conflicting generic and googlebot rules are surfaced, never asserted as Google outcome", () => {
  const r = analyzeHttpDirectives([item({ x_robots_tag: ["noindex", "googlebot: index"] })]);
  assert.equal(r.explicit_noindex_resources, 1);
  assert.equal(r.googlebot_noindex_resources, 1);
  assert.equal(r.conflicting_robots_resources, 1);
  assert.equal(r.coverage_limited, true);
});

test("P1-11: all/none aliases and matching repeated directives normalize without false conflict", () => {
  const good = analyzeHttpDirectives([item({ x_robots_tag: ["all", "index, follow", "googlebot: all"] })]);
  assert.equal(good.conflicting_robots_resources, 0);
  assert.equal(good.googlebot_noindex_resources, 0);
  const denied = analyzeHttpDirectives([item({ x_robots_tag: ["none, noindex, nofollow"] })]);
  assert.equal(denied.conflicting_robots_resources, 0);
  assert.equal(denied.explicit_noindex_resources, 1);
});

test("P1-11: unavailable_after date commas and max-snippet values are not invented agent scopes", () => {
  const r = analyzeHttpDirectives([item({
    x_robots_tag: ["unavailable_after: Fri, 20 Nov 2026 12:00:00 GMT, max-snippet: 0", "noindex"],
  })]);
  assert.equal(r.explicit_noindex_resources, 1);
  assert.equal(r.conflicting_robots_resources, 0);
});

test("P1-11: Link header comma inside quoted title and angle target is not a second canonical", () => {
  const r = analyzeHttpDirectives([item({
    link: ['<https://example.test/report.pdf?search=a,b>; rel="canonical"; title="Report, final", ' +
      '<https://example.test/prev>; rel="alternate"'],
  })]);
  assert.equal(r.resources[0].canonical_declarations, 1);
  assert.equal(r.resources[0].canonical_valid_targets, 1);
  assert.equal(r.resources[0].canonical_state, "one");
  assert.equal(r.unresolved_canonical_references, 0);
});

test("P1-11: nonparameter text after a Link URI cannot declare canonical", () => {
  const malformed = analyzeHttpDirectives([item({
    link: ['<https://example.test/a>junk; rel=canonical',
      '<https://example.test/b> junk; rel="canonical"'],
  })]);
  assert.equal(malformed.resources[0].canonical_declarations, 0);
  assert.equal(malformed.resources[0].canonical_state, "absent");

  const mixed = analyzeHttpDirectives([item({
    link: ['<https://example.test/a>junk; rel=canonical, ' +
      '<https://example.test/b>; rel="alternate canonical"'],
  })]);
  assert.equal(mixed.resources[0].canonical_declarations, 1);
  assert.equal(mixed.resources[0].canonical_valid_targets, 1);
  assert.equal(mixed.resources[0].canonical_state, "one");
});

test("P1-11: multi-valued rel and repeated equivalent canonical targets do not conflict", () => {
  const r = analyzeHttpDirectives([item({
    link: ['<https://example.test/a>; rel="alternate canonical"', '<https://example.test/a>; rel=canonical'],
  })]);
  assert.equal(r.resources[0].canonical_declarations, 2);
  assert.equal(r.resources[0].canonical_state, "repeated");
  assert.equal(r.conflicting_canonical_resources, 0);
});

test("P1-11: distinct Link canonical targets are prioritized for human review", () => {
  const r = analyzeHttpDirectives([item({
    link: ['<https://example.test/a>; rel=canonical, <https://example.test/b>; rel=canonical'],
  })]);
  assert.equal(r.resources[0].canonical_declarations, 2);
  assert.equal(r.resources[0].canonical_state, "conflicting");
  assert.equal(r.conflicting_canonical_resources, 1);
  assert.equal(matches(r, "conflicting_canonical").length, 1);
  assert.equal(matches(r, "conflicting_canonical")[0].severity, "warning");
});

test("P1-11: credential-bearing and relative Link canonical references stay unresolved and redacted", () => {
  const secret = "FAKE_HTTP_HEADER_SECRET";
  const r = analyzeHttpDirectives([item({
    link: ['</private/' + secret + '>; rel=canonical',
      '<https://user:' + secret + '@example.test/private>; rel=canonical',
      '<javascript:' + secret + '>; rel=canonical'],
  })]);
  assert.equal(r.resources[0].canonical_state, "unresolved");
  assert.equal(r.unresolved_canonical_references, 3);
  assert.equal(r.resources[0].canonical_valid_targets, 0);
  assert.equal(matches(r, "unresolved_canonical").length, 1);
  assert(!JSON.stringify(r).includes(secret));
  assert(!JSON.stringify(r).includes("/private"));
});

test("P1-11: absent X-Robots-Tag never implies Google indexed the PDF", () => {
  const r = analyzeHttpDirectives([item()]);
  assert.equal(r.resources[0].x_robots_observed, false);
  assert.equal(r.explicit_noindex_resources, 0);
  assert.equal(r.googlebot_noindex_resources, 0);
  assert.equal(r.total_findings, 0);
  assert(r.limitations.join(" ").includes("does not prove indexability"));
});

test("P1-11: reports Content-Disposition attachment without treating it as a robots rule", () => {
  const r = analyzeHttpDirectives([item({
    content_disposition: 'attachment; filename="FAKE_SECRET.pdf"',
  })]);
  assert.equal(r.attachment_resources, 1);
  assert.equal(r.resources[0].attachment_declared, true);
  assert.equal(r.googlebot_noindex_resources, 0);
  assert.equal(matches(r, "attachment_disposition").length, 1);
  assert(!JSON.stringify(r).includes("FAKE_SECRET"));
});

test("P1-11: MIME categories reflect supplied headers, not path or binary sniffing", () => {
  const pages = [
    ["https://example.test/a.pdf", "APPLICATION/PDF; charset=UTF-8", "pdf"],
    ["https://example.test/a.png", "image/png", "image"],
    ["https://example.test/a.mp4", "video/mp4", "video"],
    ["https://example.test/a.mp3", "audio/mpeg", "audio"],
    ["https://example.test/a.xml", "application/xml", "data"],
    ["https://example.test/a.txt", "text/plain", "text"],
    ["https://example.test/a.zip", "application/zip", "binary"],
    ["https://example.test/a.html", "text/html", "html"],
  ].map(([u, content_type]) => ({ url: u, status_code: 200, content_type }));
  const r = analyzeHttpDirectives(pages);
  assert.deepEqual(r.resources.map((entry) => entry.mime_category),
    ["pdf", "image", "video", "audio", "data", "text", "binary", "html"]);
  assert.equal(r.non_html_resources, 7);
  assert.equal(r.html_resources, 1);
  assert.equal(matches(r, "html_in_non_html_review").length, 1);
});

test("P1-11: unknown MIME and PDF path mismatch with HTML remain review signals", () => {
  const r = analyzeHttpDirectives([
    { url: "https://example.test/missingtype", status_code: 200 },
    { url: "https://example.test/fake.pdf", status_code: 200, content_type: "text/html" },
  ]);
  assert.equal(r.unknown_mime_resources, 1);
  assert.equal(matches(r, "unknown_content_type").length, 1);
  assert.equal(matches(r, "pdf_type_mismatch").length, 1);
});

test("P1-11: non-success and partial range statuses are not confused with full available documents", () => {
  const r = analyzeHttpDirectives([
    { ...item({ status_code: 206 }), url: "https://example.test/part.pdf" },
    { ...item({ status_code: 404 }), url: "https://example.test/gone.pdf" },
    { ...item({ status_code: 302 }), url: "https://example.test/redirect.pdf" },
  ]);
  // HTTP 206 is 2xx but incomplete; review it separately from 3xx/4xx.
  assert.equal(r.non_success_resources, 2);
  assert.equal(matches(r, "non_success_response").length, 2);
  assert.equal(matches(r, "partial_http_response").length, 1);
  assert.equal(r.resources[1].status_code, 404);
});

test("P1-11: label inputs reject unsafe URL protocols, credentials, queries and nonstandard ports", () => {
  for (const invalid of [
    "javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.test/a",
    "https://example.test/a?token=FAKE_SECRET", "https://example.test/a#anchor",
    "https://example.test/a?", "https://example.test/a#",
    "https://example.test:8443/a", "https://example.test:80/a",
    "http://example.test:443/a", "https://example.test/a\nBad: injected",
  ]) {
    assert.equal(safeHttpResourceUrl(invalid), null, invalid);
    assert.throws(() => analyzeHttpDirectives([item({ url: invalid })]));
  }
});

test("P1-11: normalized duplicate and mixed-origin labels fail closed; no network requested", () => {
  assert.throws(() => analyzeHttpDirectives([item(), item()]), /Duplicate/);
  assert.throws(() => analyzeHttpDirectives([
    item(), item({ url: "https://other.test/a.pdf" }),
  ]), /single origin/);
  assert.throws(() => analyzeHttpDirectives([]), /between one and eight/);
  assert.throws(() => analyzeHttpDirectives(Array.from({ length: MAX_HTTP_RESOURCES + 1 }, (_, i) =>
    item({ url: "https://example.test/" + i }))), /between one and eight/);
});

test("P1-11: header caps, CRLF and invalid status/method are checked in the pure module", () => {
  assert.throws(() => analyzeHttpDirectives([item({ status_code: 600 })]), /status/);
  assert.throws(() => analyzeHttpDirectives([item({ method: "DELETE" })]), /method/);
  assert.throws(() => analyzeHttpDirectives([item({
    x_robots_tag: ["noindex\r\nSet-Cookie: FAKE_SECRET"],
  })]), /header/);
  assert.throws(() => analyzeHttpDirectives([item({
    x_robots_tag: ["x".repeat(MAX_HTTP_HEADER_BYTES + 1)],
  })]), /byte cap/);
  assert.throws(() => analyzeHttpDirectives([item({
    x_robots_tag: Array.from({ length: MAX_HTTP_HEADER_VALUES + 1 }, () => "noindex"),
  })]), /Too many/);
  assert.throws(() => analyzeHttpDirectives([item({
    x_robots_tag: Array.from({ length: MAX_HTTP_HEADER_VALUES }, () => "x".repeat(MAX_HTTP_HEADER_BYTES)),
    link: Array.from({ length: MAX_HTTP_HEADER_VALUES }, () => "a".repeat(MAX_HTTP_HEADER_BYTES)),
  })]), /combined byte cap/);
  assert.equal(MAX_HTTP_TOTAL_BYTES, 30_000);
});

test("P1-11: stable 12-finding truncation and redaction under adversarial mixed inputs", () => {
  const secret = "FAKE_SECRET_12345";
  const r = analyzeHttpDirectives(Array.from({ length: MAX_HTTP_RESOURCES }, (_, i) => ({
    url: "https://example.test/" + i + ".pdf",
    status_code: 206, content_type: "application/pdf",
    x_robots_tag: ["index, noindex"],
    link: ["<https://example.test/a?token=" + secret + ">; rel=canonical, <https://example.test/b>; rel=canonical"],
    content_disposition: 'attachment; filename="' + secret + '"',
  })));
  assert(r.total_findings > MAX_HTTP_FINDINGS);
  assert.equal(r.findings.length, MAX_HTTP_FINDINGS);
  assert.equal(r.findings_truncated, true);
  assert(r.findings.every((f) => f.severity === "warning"));
  assert(!JSON.stringify(r).includes(secret));
  assert(!JSON.stringify(r).includes("https://"));
  assert(Buffer.byteLength(JSON.stringify(r), "utf8") < 9_000);
  assert.deepEqual(r, analyzeHttpDirectives(Array.from({ length: MAX_HTTP_RESOURCES }, (_, i) => ({
    url: "https://example.test/" + i + ".pdf",
    status_code: 206, content_type: "application/pdf",
    x_robots_tag: ["index, noindex"],
    link: ["<https://example.test/a?token=" + secret + ">; rel=canonical, <https://example.test/b>; rel=canonical"],
    content_disposition: 'attachment; filename="' + secret + '"',
  }))));
});

test("P1-11: Link cap is reported without claiming exhaustive canonical evidence", () => {
  const many = Array.from({ length: 34 }, (_, n) =>
    '<https://example.test/' + n + '>; rel="canonical"').join(",");
  const r = analyzeHttpDirectives([item({ link: [many] })]);
  assert.equal(r.resources[0].header_coverage_limited, true);
  assert.equal(matches(r, "link_header_limited").length, 1);
  assert.equal(r.coverage_limited, true);
});

test("P1-11: failed sample produces bounded empty state, not a success verdict", () => {
  const v = emptyHttpDirectiveReview();
  assert.equal(v.resources_sampled, 0);
  assert.equal(v.coverage_limited, true);
  assert.deepEqual(v.findings, []);
  assert.equal(v.error, undefined);
});
