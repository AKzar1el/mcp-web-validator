import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../dist/index.js";
import {
  compareProductClaims, registeredToolEvidence,
} from "../dist/modules/content-schema/product-claims.js";
import { observeProductClaims } from "../dist/modules/content-schema/extract-product-claims.js";
import { z } from "zod";

const names = [
  "validate_html", "audit_public_webpage", "audit_public_site", "validate_css",
  "audit_seo_metadata", "check_broken_links", "validate_schema_markup",
  "generate_validation_report",
];
const main = (codes, extra = "") => '<!doctype html><html><body><nav><code>pretend_danger_tool</code></nav>'
  + '<main><section><h2>Public ChatGPT capabilities</h2>'
  + codes.map((name) => "<div><code>" + name + "</code></div>").join("") + '</section>'
  + '<div>Site batch Up to 8 pages</div>'
  + '<p>The hosted app is read-only. It cannot create screenshots.</p>'
  + '<p>The separate local MCP is the only surface for responsive screenshots.</p>'
  + extra + '</main><footer><code>invented_footer_tool</code></footer></body></html>';
const catalog = names.map((name) => ({
  name, readOnlyHint: true,
  ...(name === "audit_public_site" ? { maxPages: 8 } : {}),
}));

test("P1-04 matches all eight explicit hosted tool promises and bounded site batch", () => {
  const observed = observeProductClaims(main(names));
  assert.equal(observed.hasMain, true);
  assert.equal(observed.hostedSectionFound, true);
  assert.equal(observed.siteBatchLimit, 8);
  assert.equal(observed.hostedTools.length, 8);
  assert.equal(observed.hostedReadOnlyClaim, true);
  assert.equal(observed.hostedNoScreenshotsClaim, true);
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.tool_claims_checked, 8);
  assert.equal(result.checked_claims, 11);
  assert.equal(result.consistent_claims, 11);
  assert.equal(result.contradicted_claims, 0);
  assert.equal(result.coverage_limited, false);
  assert.equal(result.total_findings, 0);
});

test("P1-04 flags a listed but unavailable tool, without confusing README code blocks and nav with promises", () => {
  const observed = observeProductClaims(main([...names, "instant_rank_tracker"],
    '<pre><code>some_random_tool</code></pre><script>const token="FAKE_PRIVATE_ABC"</script>'));
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.contradicted_claims, 1);
  assert(result.findings.some((finding) =>
    finding.code === "product.tool_missing" && finding.claim === "instant_rank_tracker"));
  assert(!result.advertised_tools.some(({ name }) => name === "pretend_danger_tool"));
  assert(!result.advertised_tools.some(({ name }) => name === "invented_footer_tool"));
  assert(!result.advertised_tools.some(({ name }) => name === "some_random_tool"));
  assert.doesNotMatch(JSON.stringify(result), /FAKE_PRIVATE_ABC/);
});

test("P1-04 detects numeric site-batch overclaims from actual registered max pages", () => {
  const observed = observeProductClaims(main(names).replace("Up to 8 pages", "Up to 500 pages"));
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.site_batch_limit?.advertised, 500);
  assert.equal(result.site_batch_limit?.registered, 8);
  assert(result.findings.some(({ code }) => code === "product.site_batch_overclaim"));
});

test("P1-04 also detects four-digit and larger advertised site batches", () => {
  const observed = observeProductClaims(main(names).replace("Up to 8 pages", "Up to 10000 pages"));
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.site_batch_limit?.advertised, 10000);
  assert(result.findings.some(({ code }) => code === "product.site_batch_overclaim"));
});

test("P1-04 does not turn missing limits or an unknown registry into unsupported claims", () => {
  const observed = observeProductClaims(main(names));
  const noLimit = compareProductClaims(observed,
    catalog.map(({ maxPages: _ignored, ...tool }) => tool), "hosted");
  assert(noLimit.findings.some(({ code, verdict }) =>
    code === "product.site_batch_limit_unknown" && verdict === "unverifiable"));
  const absent = compareProductClaims(observed, [], "hosted");
  assert.equal(absent.catalog_available, false);
  assert.equal(absent.contradicted_claims, 0);
  assert.equal(absent.coverage_limited, true);
});

test("P1-04 validates local screenshots only when its local tool is registered", () => {
  const observed = observeProductClaims(main(names));
  const supported = compareProductClaims(observed, [{ name: "screenshot.capture", readOnlyHint: false }], "local");
  assert.equal(supported.consistent_claims, 1);
  assert.equal(supported.contradicted_claims, 0);
  assert.equal(supported.coverage_limited, true, "No explicit local listing exists; do not imply a complete pass.");
  const missing = compareProductClaims(observed, [{ name: "html.local" }], "local");
  assert(missing.findings.some(({ code }) => code === "product.local_screenshot_unverified"));
});

test("P1-04 treats local screenshot denials as unavailable, not promises", () => {
  for (const statement of [
    "Local screenshots are not available.",
    "Local screenshot capture is unsupported.",
    "Local screen captures are not supported.",
    "The local MCP cannot create screenshots.",
  ]) {
    const observed = observeProductClaims(`<html><main><p>${statement}</p></main></html>`);
    assert.equal(observed.localScreenshotClaim, false, statement);
    const result = compareProductClaims(observed, [{ name: "html.local" }], "local");
    assert.equal(result.contradicted_claims, 0, statement);
  }
  const positive = observeProductClaims("<html><main><p>Local screenshots are available.</p></main></html>");
  assert.equal(positive.localScreenshotClaim, true);
});

test("P1-04 identifies hosted screenshot conflicts without suggesting screenshots can be taken", () => {
  const observed = observeProductClaims(main(names));
  const result = compareProductClaims(observed,
    [...catalog, { name: "screenshot.capture", readOnlyHint: true }], "hosted");
  assert(result.findings.some(({ code }) => code === "product.hosted_screenshot_conflict"));
});

test("P1-04 reports inaccurate read-only metadata as a potential product contradiction", () => {
  const observed = observeProductClaims(main(names));
  const result = compareProductClaims(observed,
    catalog.map((tool) => tool.name === "validate_html" ? { ...tool, readOnlyHint: false } : tool),
    "hosted");
  assert(result.findings.some(({ code }) => code === "product.read_only_conflict"));
});

test("P1-04 rejects a false clean when landing page has no scope-specific tool list", () => {
  const observed = observeProductClaims("<html><main><h1>Automatically fix everything</h1></main></html>");
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.tool_claims_checked, 0);
  assert.equal(result.coverage_limited, true);
  assert.equal(result.consistent_claims, 0);
});

test("P1-04 bounds tools, ignores secret-bearing tool labels and limits raw output", () => {
  const claimed = Array.from({ length: 35 }, (_, i) => "feature_code_" + i);
  const observed = observeProductClaims(main([...claimed, "private_key=FAKE_SECRET"]));
  const result = compareProductClaims(observed, catalog, "hosted");
  assert.equal(result.advertised_tools.length, 20);
  assert.equal(observed.extractionTruncated, true);
  assert.equal(result.findings.length, 10);
  assert.equal(result.findings_truncated, true);
  assert(Buffer.byteLength(JSON.stringify(result), "utf8") < 6500);
  assert(!JSON.stringify(result).includes("FAKE_SECRET"));
});

test("P1-04 metadata snapshot uses the real local MCP runtime registration map", () => {
  const server = createServer();
  const registered = registeredToolEvidence(server._registeredTools, (schema) => z.toJSONSchema(schema));
  assert(registered.some((tool) => tool.name === "screenshot.capture"));
  assert(registered.some((tool) => tool.name === "product.claims"));
  assert(registered.some((tool) => tool.name === "content.quality"));
  assert(registered.some((tool) => tool.name === "content.provenance"));
  assert(registered.length >= 13, "The optional SEO tool catalog can grow without invalidating registry evidence.");
  const result = compareProductClaims(observeProductClaims(main(names)), registered, "local");
  assert.equal(result.consistent_claims, 1);
});

test("P1-04 enforces UTF-8 input limits, missing text and hidden marketing assertions", () => {
  assert.throws(() => observeProductClaims("é".repeat(125001)), /250,000/);
  assert.throws(() => observeProductClaims(""), /must be present/);
  const text = "<html><main><section><h2>Public ChatGPT capabilities</h2>"
    + "<div hidden><code>fake_private_tool</code></div>"
    + '<code aria-hidden="true">secret_tool</code><code>validate_html</code>'
    + "</section></main></html>";
  const result = compareProductClaims(observeProductClaims(text), catalog, "hosted");
  assert.equal(result.tool_claims_checked, 1);
});
