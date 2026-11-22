#!/usr/bin/env node
// Opt-in live interoperability check. Contacts an explicitly authorized site
// through the published hosted MCP, then stores only a disposable local snapshot.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const siteSetting = process.env.MCP_AUDIT_TARGET_URL;
if (!siteSetting) {
  console.error("Set MCP_AUDIT_TARGET_URL to the HTTPS root of a site you own or may audit.");
  process.exit(2);
}
const site = new URL(siteSetting);
if (site.protocol !== "https:" || site.username || site.password
    || site.search || site.hash || site.port || site.pathname !== "/") {
  throw new Error("MCP_AUDIT_TARGET_URL must be an HTTPS site root without credentials, port, query or fragment.");
}
const hosted = new URL(process.env.MCP_WEB_VALIDATOR_HOSTED_URL
  ?? "https://web-validator-mcp.digestseo.com/mcp");
if (hosted.protocol !== "https:" || hosted.username || hosted.password
    || hosted.search || hosted.hash || hosted.port || hosted.pathname !== "/mcp") {
  throw new Error("The hosted endpoint must be an HTTPS /mcp URL without credentials or query values.");
}
const sourceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = process.env.MCP_WEB_VALIDATOR_LOCAL_ENTRYPOINT
  ?? path.join(sourceRoot, "dist", "index.js");
if (!path.isAbsolute(entrypoint)) {
  throw new Error("MCP_WEB_VALIDATOR_LOCAL_ENTRYPOINT must be an absolute path.");
}
await fs.access(entrypoint);

let nextId = 0;
const startedAt = Date.now();
const stage = (message) => console.error(`[interop] ${message} (+${Date.now() - startedAt}ms)`);
async function callHosted(name, args) {
  const id = ++nextId;
  const response = await fetch(hosted, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: "https://chatgpt.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(90_000),
  });
  const wire = await response.text();
  assert.equal(response.status, 200, `Hosted ${name} returned HTTP ${response.status}`);
  assert.ok(Buffer.byteLength(wire, "utf8") < 4_000_000, "Hosted result was unexpectedly large");
  const replies = response.headers.get("content-type")?.includes("text/event-stream")
    ? wire.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(wire)];
  const reply = replies.find((item) => item.id === id);
  assert.ok(reply, `Hosted ${name} returned no matching JSON-RPC result`);
  assert.equal(reply.error, undefined, `Hosted ${name} returned an RPC error`);
  assert.notEqual(reply.result?.isError, true, `Hosted ${name} returned a tool error`);
  return reply.result?.structuredContent;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wv-hosted-local-smoke-"));
let localClient;
try {
  // Only one live site audit: avoid surprise crawling and excessive validator traffic.
  stage("starting single-page hosted audit");
  const audit = await callHosted("audit_public_site", { site_url: site.href, max_pages: 1 });
  assert.ok(audit?.site_url && Array.isArray(audit.pages), "Hosted audit lacked structured result");
  stage("hosted audit returned structured result");
  const snapshotJson = JSON.stringify(audit);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: { ...process.env, MCP_WEB_VALIDATOR_WORKSPACE_ROOT: root },
    stderr: "pipe",
  });
  localClient = new Client({ name: "web-validator-interop-smoke", version: "1.0.0" });
  stage("connecting isolated local stdio server");
  await localClient.connect(transport);
  stage("local stdio connection established");

  const tools = (await localClient.listTools(undefined, { timeout: 90_000 })).tools;
  stage("local tool inventory received");
  assert.ok(tools.some((tool) => tool.name === "audit.history"), "Local MCP lacks audit.history");

  const history = (args) => localClient.callTool({ name: "audit.history", arguments: args }, undefined, { timeout: 90_000 });
  const empty = await history({ action: "list" });
  assert.equal(empty.structuredContent?.count, 0);
  assert.deepEqual(await fs.readdir(root), [], "Read-only listing must not create storage");

  stage("saving one snapshot to disposable local history");
  const saved = await history({ action: "save", snapshotJson });
  assert.notEqual(saved.isError, true, `Local save rejected the hosted result: ${saved.structuredContent?.error ?? "unknown error"}`);
  assert.equal(saved.structuredContent?.count, 1);

  stage("restoring saved history snapshot");
  const restored = await history({ action: "get", id: saved.structuredContent.items[0].id });
  assert.notEqual(restored.isError, true, "Local history could not restore the saved result");
  const baseline = JSON.parse(restored.structuredContent.snapshot_json);
  assert.equal(baseline.site_url, audit.site_url);
  assert.ok(!("indexability_graph" in baseline), "The compact local store must not keep the full graph");

  // Compare with exactly the same observed audit: zero regression claims.
  stage("comparing hosted audit against restored local baseline");
  const comparison = await callHosted("compare_site_audits", { baseline, current: audit });
  assert.ok(comparison?.status, "Comparison lacked structured status");
  assert.equal(comparison.regressed_pages, 0);
  stage("hosted-to-local interoperability verified");
  console.log(JSON.stringify({
    status: "passed",
    hosted_site: site.origin,
    snapshot_bytes: Buffer.byteLength(snapshotJson, "utf8"),
    pages_discovered: audit.pages_discovered,
    pages_selected: audit.pages_selected,
    pages_audited: audit.pages_audited,
    pages_partial: audit.pages_partial,
    pages_failed: audit.pages_failed,
    truncated: audit.truncated,
    html_validation_statuses: audit.pages.map((page) => page.html_validation_status),
    local_history_versions: saved.structuredContent.count,
    comparison_status: comparison.status,
    all_discovered_pages_fully_audited:
      comparison.status === "comparable"
      && audit.pages_discovered > 0
      && audit.pages_audited === audit.pages_discovered
      && audit.pages_selected === audit.pages_discovered
      && audit.pages_partial === 0
      && audit.pages_failed === 0
      && audit.pages_skipped_robots === 0
      && audit.truncated === false
      && audit.issue_groups_truncated === false,
    cloud_storage: "none",
  }, null, 2));
} finally {
  if (localClient) await localClient.close();
  const real = await fs.realpath(root).catch(() => null);
  const tmp = await fs.realpath(os.tmpdir());
  if (real && path.dirname(real) === tmp && path.basename(real).startsWith("wv-hosted-local-smoke-")) {
    await fs.rm(real, { recursive: true, force: true });
  }
}
