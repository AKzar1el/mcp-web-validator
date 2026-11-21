import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeProductionChange, MAX_CHANGE_HTML_BYTES, MAX_CHANGE_FINDINGS,
} from "../dist/modules/change-regression/production-change-comparison.js";

const url = "https://example.test/article";
const at = (day) => `2026-11-${String(day).padStart(2, "0")}T11:00:00Z`;
const page = (body = "alpha beta gamma", extras = "") =>
  `<!doctype html><html><head><title>Original</title><meta name="description" content="Safe summary"><link rel="canonical" href="${url}"></head><body><main><h1>Heading</h1><p>${body}</p><a href="/same">same</a></main>${extras}</body></html>`;
function pair(before = page(), after = before, attrs = {}) {
  return {
    page_url: url,
    baseline: { observed_at: at(20), http_status: 200, html: before },
    current: { observed_at: at(21), http_status: 200, html: after },
    ...attrs,
  };
}
const codes = (report) => report.findings.map((f) => f.code);

test("V10: identical successful snapshots produce matching stable fingerprints and no changes", async () => {
  const report = await analyzeProductionChange(pair());
  assert.equal(report.scope, "two_caller_supplied_html_observations");
  assert.equal(report.status, "comparable_snapshot");
  assert.equal(report.html_fingerprint_changed, false);
  assert.equal(report.main_text_fingerprint_changed, false);
  assert.match(report.baseline.html_sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.baseline.html_sha256, report.current.html_sha256);
  assert.equal(report.main_words_added, 0);
  assert.equal(report.main_words_removed, 0);
  assert.equal(report.total_findings, 0);
  assert.equal(report.coverage_limited, true);
});

test("V10: metadata, content, robots, internal links and JSON-LD changes remain redacted", async () => {
  const secret = "PRIVATE-CONTENT-TOKEN";
  const after = `<html><head><title>Updated ${secret}</title><meta name="description" content="new ${secret}"><meta name="robots" content="noindex,nofollow"><link rel="canonical" href="https://example.test/other"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script></head><body><main><h1>Replacement</h1><p>alpha delta ${secret}</p><a href="/new">new</a></main></body></html>`;
  const report = await analyzeProductionChange(pair(page("alpha beta gamma"), after));
  assert.equal(report.status, "comparable_snapshot");
  assert.equal(report.title_changed, true);
  assert.equal(report.description_changed, true);
  assert.equal(report.h1_changed, true);
  assert.equal(report.canonical_changed, true);
  assert.equal(report.robots_changed, true);
  assert.equal(report.noindex_added, true);
  assert.equal(report.noindex_removed, false);
  assert.equal(report.main_text_fingerprint_changed, true);
  assert.equal(report.html_fingerprint_changed, true);
  assert.equal(report.jsonld_blocks_changed, true);
  assert.equal(report.links_added, 1);
  assert.equal(report.links_removed, 1);
  assert(codes(report).includes("noindex_added"));
  assert(codes(report).includes("main_content_changed"));
  const text = JSON.stringify(report);
  assert(!text.includes(secret));
  assert(!text.includes(url));
  assert(!text.includes("Replacement"));
  assert(report.findings.length <= MAX_CHANGE_FINDINGS);
});

test("V10: a whitespace-only HTML update is not a sampled main content regression", async () => {
  const before = page("alpha beta gamma");
  const after = before.replace("alpha beta", "alpha    beta").replace("<head>", "<head>\n");
  const report = await analyzeProductionChange(pair(before, after));
  assert.equal(report.html_fingerprint_changed, true);
  assert.equal(report.main_text_fingerprint_changed, false);
  assert.equal(report.title_changed, false);
  assert.equal(report.description_changed, false);
  assert(codes(report).includes("html_only_changed"));
});

test("V10: a 403 challenge or 429/5xx response is delivery loss, not disappearing SEO content", async () => {
  for (const status of [403, 429, 503]) {
    const report = await analyzeProductionChange(pair(page(), "<html><body>challenge</body></html>", {
      current: { observed_at: at(21), http_status: status, html: "<html>challenge</html>" },
    }));
    assert.equal(report.status, "not_comparable");
    assert.equal(report.http_status_changed, true);
    assert.equal(report.title_changed, null);
    assert.equal(report.noindex_removed, null);
    assert.equal(report.main_words_removed, null);
    assert.equal(report.main_text_fingerprint_changed, null);
    assert(codes(report).includes("delivery_not_comparable"));
  }
});

test("V10: a failed HTTP observation may supply no HTML", async () => {
  const report = await analyzeProductionChange(pair(page(), "", {
    current: { observed_at: at(21), http_status: 503, html: "" },
  }));
  assert.equal(report.current.html_sha256, null);
  assert.equal(report.status, "not_comparable");
  assert.equal(report.html_fingerprint_changed, null);
});

test("V10: unspecified HTTP statuses downgrade comparison without pretending live availability", async () => {
  const input = pair();
  delete input.baseline.http_status;
  const r = await analyzeProductionChange(input);
  assert.equal(r.status, "partial");
  assert.equal(r.http_status_changed, null);
  assert(codes(r).includes("delivery_unverified"));
});

test("V10: equal times are ambiguous; reverse times and naive times are rejected", async () => {
  const input = pair();
  input.current.observed_at = input.baseline.observed_at;
  const report = await analyzeProductionChange(input);
  assert.equal(report.status, "partial");
  assert.equal(report.time_order_ambiguous, true);
  assert(codes(report).includes("time_ambiguous"));
  input.current.observed_at = at(19);
  await assert.rejects(analyzeProductionChange(input));
  input.current.observed_at = "2026-11-21T11:00:00";
  await assert.rejects(analyzeProductionChange(input));
});

test("V10: impossible calendar dates cannot produce comparable production evidence", async () => {
  for (const invalid of [
    "2026-02-30T09:00:00Z",
    "2026-04-31T09:00:00Z",
    "2025-02-29T09:00:00Z",
    "2026-13-21T09:00:00Z",
  ]) {
    const input = pair();
    input.baseline.observed_at = invalid;
    await assert.rejects(analyzeProductionChange(input), /timestamp|date|time/i);
  }
  const valid = pair();
  valid.baseline.observed_at = "2024-02-29T09:00:00+01:00";
  assert.equal((await analyzeProductionChange(valid)).status, "comparable_snapshot");
});

test("V10: page labels with query strings, fragments, credentials and ports fail closed", async () => {
  for (const bad of [
    "https://example.test/x?token=secret", "https://example.test/x#frag",
    "https://user:pass@example.test/x", "http://127.0.0.1:3000/x",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(analyzeProductionChange(pair(page(),page(), { page_url: bad })));
  }
});

test("V10: HTML UTF-8 byte boundaries are enforced, not JavaScript string length", async () => {
  const huge = "<p>" + "ž".repeat(Math.ceil(MAX_CHANGE_HTML_BYTES / 2)) + "</p>";
  await assert.rejects(analyzeProductionChange(pair(page(), huge)));
  await assert.rejects(analyzeProductionChange(pair(page(),page(), {
    current: { observed_at: at(21), http_status: 200, html: "" },
  })));
});

test("V10: long main content yields partial evidence and does not invent a complete text hash", async () => {
  const big = page("word ".repeat(22_000));
  const report = await analyzeProductionChange(pair(big,big));
  assert.equal(report.status, "partial");
  assert.equal(report.baseline.sample_truncated, true);
  assert.equal(report.baseline.main_text_sha256, null);
  assert.equal(report.main_text_fingerprint_changed, null);
  assert.equal(report.main_words_added, null);
  assert.equal(report.links_removed, null);
  assert(codes(report).includes("extraction_limited"));
});

test("V10: a changed canonical URL is flagged without echoing the target", async () => {
  const changed = page().replace(`href="${url}"`, `href="https://example.test/private-secret-target"`);
  const report = await analyzeProductionChange(pair(page(),changed));
  assert.equal(report.canonical_changed, true);
  assert(!JSON.stringify(report).includes("private-secret-target"));
});

test("V10: HTML scripts are parsed as inert text, never executed", async () => {
  delete globalThis.__v10_script_must_not_run;
  const injected = page("normal", `<script>globalThis.__v10_script_must_not_run = true</script>`);
  const report = await analyzeProductionChange(pair(page(), injected));
  assert.equal(globalThis.__v10_script_must_not_run, undefined);
  assert.equal(report.html_fingerprint_changed, true);
});
