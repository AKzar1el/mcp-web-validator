import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCrawlerAccess,
  emptyCrawlerAccessReview,
  CRAWLER_PROFILES,
  MAX_CRAWLER_PAGES,
} from "../dist/modules/http-crawl/crawler-access.js";

const site_url = "https://example.com/";
const page = (url, extra = {}) => ({ url: "https://example.com" + url, ...extra });
const html = (tags = "") => "<!doctype html><html><head>" + tags
  + "</head><body><h1>Public page</h1></body></html>";
const find = (review, at, profile) =>
  review.rows.find((row) => row.page === at && row.profile === profile);
const codes = (r) => r.findings.map((item) => item.code);

test("V03: crawler-specific robots groups override wildcard, merge equal groups and distinguish profiles", () => {
  const result = analyzeCrawlerAccess({
    site_url,
    robots_txt: [
      "User-agent: *",
      "Disallow: /private",
      "Allow: /private/public",
      "User-agent: Googlebot",
      "Disallow: /news",
      "User-agent: Googlebot",
      "Allow: /news/public",
      "User-agent: Googlebot-News",
      "Disallow: /news",
      "User-agent: GPTBot",
      "Disallow: /",
    ].join("\n"),
    pages: [
      page("/news/private", { status_code: 200, html: html(), x_robots_tag: [] }),
      page("/private/billing-secret", { status_code: 200, html: html(), x_robots_tag: [] }),
      page("/news/public", { status_code: 200, html: html(), x_robots_tag: [] }),
    ],
  });
  assert.equal(result.rows_checked, 18);
  assert.equal(result.profiles_checked, CRAWLER_PROFILES.length);
  assert.equal(find(result, 1, "googlebot-smartphone").robots_access, "disallowed");
  assert.equal(find(result, 1, "googlebot-desktop").robots_access, "disallowed");
  assert.equal(find(result, 1, "googlebot-news").robots_access, "disallowed");
  assert.equal(find(result, 1, "bingbot").robots_access, "allowed");
  assert.equal(find(result, 1, "gptbot").robots_access, "disallowed");
  assert.equal(find(result, 2, "bingbot").robots_access, "disallowed");
  assert.equal(find(result, 2, "googlebot-smartphone").robots_access, "allowed");
  assert.equal(find(result, 3, "googlebot-smartphone").robots_access, "allowed");
  assert.equal(find(result, 3, "googlebot-news").robots_access, "disallowed");
  assert.equal(result.rows.every((r) => r.indexing_state === "no_noindex_observed"), true);
  assert.equal(result.coverage_limited, true);
  assert(!JSON.stringify(result).includes("billing-secret"));
});

test("V03: separate robots crawl rules and meta/X-Robots-Tag noindex declarations", () => {
  const review = analyzeCrawlerAccess({
    site_url,
    robots_txt: "User-agent: *\nAllow: /",
    pages: [page("/products/secret", {
      status_code: 200,
      html: html('<meta name="robots" content="follow"><meta name="googlebot" content="noindex"><meta name="bingbot" content="index">'),
      x_robots_tag: ["googlebot-news: noindex", "gptbot: noindex"],
    })],
  });
  assert.equal(find(review, 1, "googlebot-smartphone").indexing_state, "explicit_noindex");
  assert.equal(find(review, 1, "googlebot-desktop").indexing_source, "meta");
  assert.equal(find(review, 1, "googlebot-news").indexing_source, "header");
  assert.equal(find(review, 1, "gptbot").indexing_source, "header");
  assert.equal(find(review, 1, "bingbot").indexing_state, "no_noindex_observed");
  assert.equal(find(review, 1, "bingbot").explicit_index_directive, true);
  assert.equal(find(review, 1, "bingbot").effective_access, "crawl_allowed_no_noindex_observed");
  assert.equal(find(review, 1, "googlebot-smartphone").effective_access, "crawl_allowed_noindex_declared");
  assert.equal(review.noindex_declared_rows, 4);
  assert(!JSON.stringify(review).includes("/products/secret"));
});

test("V03: robots-disallowed page with supplied noindex is a visibility trap, not a guaranteed index removal", () => {
  const review = analyzeCrawlerAccess({
    site_url,
    robots_txt: "User-agent: Googlebot\nDisallow: /private/",
    pages: [page("/private/action", {
      status_code: 200, html: html('<meta name="googlebot" content="noindex">'), x_robots_tag: [],
    })], profiles: ["googlebot-smartphone", "bingbot"],
  });
  const google = find(review, 1, "googlebot-smartphone");
  assert.equal(google.robots_access, "disallowed");
  assert.equal(google.indexing_state, "explicit_noindex");
  assert.equal(google.effective_access, "crawl_disallowed");
  assert(codes(review).includes("blocked_with_noindex"));
  assert.equal(find(review, 1, "bingbot").robots_access, "allowed");
});

test("V03: folded X-Robots-Tag scopes are uncertain, not copied as global noindex", () => {
  const review = analyzeCrawlerAccess({
    site_url, robots_txt: "",
    pages: [page("/a", {
      status_code: 200,
      html: html(),
      x_robots_tag: ["bingbot: noindex, noindex", "googlebot: max-snippet:1, follow"],
    })], profiles: ["googlebot-smartphone", "bingbot"],
  });
  const google = find(review, 1, "googlebot-smartphone");
  const bing = find(review, 1, "bingbot");
  assert.equal(google.indexing_state, "no_noindex_observed");
  assert.equal(google.x_robots_scope_ambiguous, true);
  assert.equal(bing.indexing_state, "explicit_noindex");
  assert.equal(google.indexing_source, "none");
  assert(codes(review).includes("x_robots_scope_ambiguous"));
});

test("V03: equal-length allow wins, wildcard and anchored $ have bounded deterministic matches", () => {
  const review = analyzeCrawlerAccess({
    site_url,
    robots_txt: [
      "User-agent: *", "Disallow: /catalog/*", "Allow: /catalog/open$",
      "Disallow: /same", "Allow: /same",
      "Disallow: /%7Esecret$",
    ].join("\n"),
    pages: [
      page("/catalog/open", { html: html(), x_robots_tag: [] }),
      page("/catalog/open/deeper", { html: html(), x_robots_tag: [] }),
      page("/same", { html: html(), x_robots_tag: [] }),
      page("/~secret", { html: html(), x_robots_tag: [] }),
      page("/~secret/deeper", { html: html(), x_robots_tag: [] }),
    ],
    profiles: ["bingbot"],
  });
  assert.equal(find(review, 1, "bingbot").robots_access, "allowed");
  assert.equal(find(review, 2, "bingbot").robots_access, "disallowed");
  assert.equal(find(review, 3, "bingbot").robots_access, "allowed");
  assert.equal(find(review, 4, "bingbot").robots_access, "disallowed");
  assert.equal(find(review, 5, "bingbot").robots_access, "allowed");
});

test("V03: missing robots and missing HTML/header evidence are unknown, not healthy", () => {
  const noEvidence = analyzeCrawlerAccess({
    site_url,
    pages: [page("/a")],
    profiles: ["googlebot-desktop"],
  });
  const row = noEvidence.rows[0];
  assert.equal(row.robots_access, "unknown");
  assert.equal(row.indexing_state, "unknown");
  assert.equal(row.effective_access, "unverified");
  assert.equal(noEvidence.unknown_access_rows, 1);
  assert.equal(noEvidence.unknown_indexing_rows, 1);
  assert(codes(noEvidence).includes("robots_unavailable"));

  const noFile = analyzeCrawlerAccess({
    site_url, robots_status_code: 404,
    pages: [page("/a", { html: html(), x_robots_tag: [] })],
    profiles: ["googlebot-desktop", "bingbot"],
  });
  assert(noFile.rows.every((entry) => entry.robots_access === "allowed"));
  const unavailable = analyzeCrawlerAccess({
    site_url, robots_status_code: 503,
    pages: [page("/a", { status_code: 503 })],
    profiles: ["googlebot-desktop"],
  });
  assert.equal(unavailable.rows[0].robots_access, "unknown");
  assert(codes(unavailable).includes("page_http_error"));
});

test("V03: disallowed/contradictory indexing directives remain visible without content echo", () => {
  const review = analyzeCrawlerAccess({
    site_url, robots_txt: "",
    pages: [page("/secret/path", {
      html: html('<meta name="googlebot" content="index, noindex">'),
      x_robots_tag: ["googlebot: noindex", "set-cookie: confidential"],
    })],
    profiles: ["googlebot-desktop"],
  });
  assert.equal(review.rows[0].conflicting_index_directives, true);
  assert.equal(review.rows[0].indexing_source, "both");
  assert(codes(review).includes("conflicting_indexing_directives"));
  assert(!JSON.stringify(review).includes("confidential"));
  assert(!JSON.stringify(review).includes("secret/path"));
});

test("V03: rejects unsafe URLs, origin drift, huge samples, and contradictory robots statuses", () => {
  const baseline = { site_url, robots_txt: "", pages: [page("/a")] };
  const invalid = [
    { ...baseline, site_url: "https://example.com/?secret=42" },
    { ...baseline, pages: [] },
    { ...baseline, pages: Array.from({ length: MAX_CRAWLER_PAGES + 1 }, () => page("/a")) },
    { ...baseline, pages: [{ url: "https://other.example.net/a" }] },
    { ...baseline, pages: [{ url: "https://u:pw@example.com/a" }] },
    { ...baseline, pages: [{ url: "http://example.com/a" }] },
    { ...baseline, pages: [page("/a", { status_code: 600 })] },
    { ...baseline, robots_status_code: 503 },
    { ...baseline, profiles: ["bingbot", "bingbot"] },
    { ...baseline, profiles: ["weirdbot"] },
    { ...baseline, profiles: [] },
    { ...baseline, robots_txt: "a".repeat(65000) },
    { ...baseline, pages: [page("/a", { html: "x".repeat(150001) })] },
    { ...baseline, pages: [page("/a", { x_robots_tag: ["secret".repeat(200)] })] },
  ];
  for (const item of invalid) assert.throws(() => analyzeCrawlerAccess(item));
  const empty = emptyCrawlerAccessReview();
  assert.equal(empty.rows_checked, 0);
  assert.equal(empty.coverage_limited, true);
});
