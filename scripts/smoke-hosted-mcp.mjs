#!/usr/bin/env node
// Explicit, read-only canary for the public hosted MCP. No site crawls, writes,
// saved versions, credentials, external validator requests, or dependencies.
import assert from "node:assert/strict";

const target = new URL(process.env.MCP_WEB_VALIDATOR_HOSTED_URL ?? "https://web-validator-mcp.digestseo.com/mcp");
if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
  throw new Error("The hosted MCP smoke target must be an HTTPS endpoint without credentials or query strings.");
}

// Keep this public catalog in sync with registerAppTool in chatgpt-plugin/src/worker.ts.
const expectedTools = [
  "validate_html",
  "validate_css",
  "audit_seo_metadata",
  "validate_schema_markup",
  "check_broken_links",
  "generate_validation_report",
  "audit_public_webpage",
  "audit_public_site",
  "preview_regression_alerts",
  "compare_production_snapshots",
  "compare_historical_audits",
  "compare_site_audits",
  "verify_product_claims",
  "verify_content_provenance",
  "compare_competitor_intent",
  "validate_supported_schema",
  "review_internal_link_graph",
  "review_internal_links",
  "review_metadata_consistency",
  "review_sitemap_inventory",
  "review_redirect_canonical_chains",
  "review_crawler_access",
  "review_availability_history",
  "diagnose_http_delivery",
  "review_url_variants",
  "review_https_security",
  "review_http_directives",
];

let requestId = 0;
async function call(method, params) {
  const id = ++requestId;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: "https://chatgpt.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${body.slice(0, 240)}`);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://chatgpt.com");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(body)];
  const matching = messages.find((item) => item.id === id);
  assert.ok(matching, `${method}: no matching JSON-RPC reply`);
  assert.equal(matching.error, undefined, `${method} RPC error: ${JSON.stringify(matching.error)}`);
  return matching.result;
}

try {
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "web-validator-hosted-smoke", version: "1.0.0" },
  });
  assert.ok(init.serverInfo?.name, "MCP initialize must return serverInfo");

  const tools = await call("tools/list", {});
  const names = tools.tools.map(({ name }) => name);
  assert.ok(!names.includes("audit.history"), "Local filesystem history must never be exposed as a public hosted MCP tool");

  const checked = await call("tools/call", {
    name: "validate_schema_markup",
    arguments: {
      html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>',
    },
  });
  assert.notEqual(checked.isError, true);
  assert.ok(checked.structuredContent, "A hosted offline tool must return structured results");
  const missing = expectedTools.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expectedTools.includes(name));
  console.log(JSON.stringify({
    status: missing.length === 0 && extra.length === 0 ? "passed" : "deployed_version_mismatch",
    target: target.origin + target.pathname,
    initialized: true,
    tools: names.length,
    missing_tools: missing,
    unexpected_tools: extra,
    hosted_history: "not implemented (stateless by design)",
    offline_tool: "validate_schema_markup passed",
  }, null, 2));
  if (missing.length || extra.length) {
    throw new Error("The public MCP does not match the verified source. Deploy the Worker and re-run this read-only smoke before claiming new hosted functionality.");
  }
} catch (error) {
  console.error("Hosted MCP read-only smoke failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
