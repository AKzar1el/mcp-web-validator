import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = path.join(repoRoot, "dist", "index.js");

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-validator-stdio-history-"));
  t.after(async () => {
    // Only remove the independent directory created by mkdtemp in this test.
    const actual = await fs.realpath(root);
    const temporary = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual), temporary);
    assert.match(path.basename(actual), /^web-validator-stdio-history-/);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return root;
}

async function connect(root, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: { ...process.env, MCP_WEB_VALIDATOR_WORKSPACE_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const snapshot = (i, site = "https://example.com/") => JSON.stringify({
  site_url: site,
  sitemap_url: new URL("sitemap.xml", site).href,
  discovery: "sitemap",
  pages_discovered: i + 1,
  pages_selected: 1,
  pages_audited: 1,
  pages_partial: 0,
  pages_failed: 0,
  pages_skipped_robots: 0,
  truncated: false,
  discovery_fingerprint: "a".repeat(64),
  audit_health_score: 98,
  score_coverage_percent: 100,
  pages: [{
    url: site,
    fetched_url: site,
    status: "passed",
    page_fetched: true,
    html_validation_status: "completed",
    html_errors: 0,
    html_warnings: 0,
    seo_errors: 0,
    seo_warnings: 0,
    schema_errors: 0,
    schema_warnings: 0,
    notes: 0,
    health_score: 98,
    top_findings: [],
  }],
  issue_groups: [],
  issue_groups_truncated: false,
  overview: { should_not_be_saved: true },
  indexability_graph: { should_not_be_saved: true },
});

async function history(client, action, more = {}) {
  return client.callTool({ name: "audit.history", arguments: { action, ...more } });
}

test("real stdio MCP history survives a restart and evicts exactly the oldest of 11 versions", {
  timeout: 90_000,
}, async (t) => {
  const root = await temporaryRoot(t);
  const ids = [];
  const first = await connect(root, "history-first-session");
  try {
    const tools = await first.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "audit.history"));
    const empty = await history(first, "list");
    assert.equal(empty.isError, undefined);
    assert.deepEqual(empty.structuredContent?.items, []);
    assert.deepEqual(await fs.readdir(root), [], "list must not create storage");

    for (let i = 0; i < 11; i++) {
      const saved = await history(first, "save", { snapshotJson: snapshot(i) });
      assert.notEqual(saved.isError, true);
      assert.equal(saved.structuredContent?.count, Math.min(i + 1, 10));
      const id = saved.structuredContent?.items?.[0]?.id;
      assert.match(id, /^[0-9a-f-]{36}$/i);
      ids.push(id);
      if (i === 10) {
        assert.equal(saved.structuredContent?.evicted_id, ids[0]);
      } else {
        assert.equal(saved.structuredContent?.evicted_id, undefined);
      }
    }

    const current = await history(first, "list");
    assert.equal(current.structuredContent.count, 10);
    assert.deepEqual(current.structuredContent.items.map((item) => item.id), ids.slice(1).reverse());

    const missing = await history(first, "get", { id: ids[0] });
    assert.equal(missing.isError, true);
    assert.match(missing.structuredContent?.error ?? "", /not found/i);

    const bad = await history(first, "save", {
      snapshotJson: snapshot(12, "https://example.com/?secret=never-persist"),
    });
    assert.equal(bad.isError, true);
    assert.equal((await history(first, "list")).structuredContent.count, 10);

    const stored = await fs.readFile(path.join(root, ".mcp-validator", "audit-history.json"), "utf8");
    const parsed = JSON.parse(stored);
    assert.equal(parsed.items.length, 10);
    assert.equal(parsed.items[0].id, ids[1]);
    assert.ok(Buffer.byteLength(stored, "utf8") <= 660_000);
    assert.doesNotMatch(stored, /secret=never-persist/);
    assert.doesNotMatch(stored, /should_not_be_saved/);
    assert.deepEqual(await fs.readdir(path.join(root, ".mcp-validator")), ["audit-history.json"]);
  } finally {
    await first.close();
  }

  // A second process, not the same in-memory MCP server, must recover the data.
  const second = await connect(root, "history-after-restart");
  try {
    const current = await history(second, "list");
    assert.equal(current.structuredContent?.count, 10);
    assert.equal(current.structuredContent?.items?.[0]?.id, ids[10]);
    const restored = await history(second, "get", { id: ids[10] });
    assert.notEqual(restored.isError, true);
    const parsed = JSON.parse(restored.structuredContent?.snapshot_json);
    assert.equal(parsed.pages_discovered, 11);
    assert.equal(parsed.site_url, "https://example.com/");
    assert.equal(parsed.overview, undefined);
    assert.equal(parsed.indexability_graph, undefined);
  } finally {
    await second.close();
  }
});

test("different MCP workspace roots isolate history and cannot retrieve each other's IDs", {
  timeout: 45_000,
}, async (t) => {
  const rootA = await temporaryRoot(t);
  const rootB = await temporaryRoot(t);
  const a = await connect(rootA, "workspace-a");
  let idA;
  try {
    const saved = await history(a, "save", { snapshotJson: snapshot(1, "https://alpha.example/") });
    assert.notEqual(saved.isError, true);
    idA = saved.structuredContent?.items?.[0]?.id;
  } finally {
    await a.close();
  }

  const b = await connect(rootB, "workspace-b");
  try {
    const listB = await history(b, "list");
    assert.equal(listB.structuredContent?.count, 0);
    const getAFromB = await history(b, "get", { id: idA });
    assert.equal(getAFromB.isError, true);
    assert.match(getAFromB.structuredContent?.error ?? "", /not found/i);

    const saveB = await history(b, "save", { snapshotJson: snapshot(2, "https://beta.example/") });
    assert.notEqual(saveB.isError, true);
    assert.equal(saveB.structuredContent?.items?.[0]?.site_url, "https://beta.example/");
  } finally {
    await b.close();
  }
  const storedA = JSON.parse(await fs.readFile(path.join(rootA, ".mcp-validator", "audit-history.json"), "utf8"));
  const storedB = JSON.parse(await fs.readFile(path.join(rootB, ".mcp-validator", "audit-history.json"), "utf8"));
  assert.equal(storedA.items[0].site_url, "https://alpha.example/");
  assert.equal(storedB.items[0].site_url, "https://beta.example/");
  assert.notEqual(storedA.items[0].id, storedB.items[0].id);
});
