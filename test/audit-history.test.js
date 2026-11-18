import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_AUDIT_HISTORY,
  getAuditHistorySnapshot,
  listAuditHistory,
  parseCompactAuditSnapshot,
  saveAuditHistorySnapshot,
} from "../dist/audit-history.js";

const FINGERPRINT = "a".repeat(64);
const url = "https://example.com/";

function sample(extra = {}) {
  return JSON.stringify({
    site_url: url,
    sitemap_url: url + "sitemap.xml",
    discovery: "sitemap",
    pages_discovered: 1,
    pages_selected: 1,
    pages_audited: 1,
    pages_partial: 0,
    pages_failed: 0,
    pages_skipped_robots: 0,
    truncated: false,
    discovery_fingerprint: FINGERPRINT,
    score_coverage_percent: 100,
    pages: [{
      url,
      fetched_url: url,
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
      health_score: 100,
      top_findings: [],
    }],
    issue_groups: [],
    issue_groups_truncated: false,
    // Intentionally large opaque fields must never be retained in history.
    indexability_graph: { findings: ["not needed for before/after comparison"] },
    overview: { notes: "not needed in history" },
    ...extra,
  });
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-history-test-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test("history list is read-only and does not create a file", async (t) => {
  const root = await temporaryRoot(t);
  assert.deepEqual(await listAuditHistory(root), { count: 0, items: [] });
  assert.deepEqual(await fs.readdir(root), []);
});

test("compact snapshots omit unrelated fields and can be retrieved faithfully", async (t) => {
  const root = await temporaryRoot(t);
  const raw = sample();
  const compact = parseCompactAuditSnapshot(raw);
  assert.equal(compact.site_url, url);
  assert.equal("indexability_graph" in compact, false);
  assert.equal("overview" in compact, false);
  const saved = await saveAuditHistorySnapshot(raw, root);
  assert.equal(saved.count, 1);
  assert.equal(saved.evicted_id, undefined);
  const restored = await getAuditHistorySnapshot(saved.items[0].id, root);
  assert.deepEqual(JSON.parse(restored.snapshot_json), compact);
  const onDisk = await fs.readFile(path.join(root, ".mcp-validator", "audit-history.json"), "utf8");
  assert.ok(onDisk.length < 3000);
  assert.doesNotMatch(onDisk, /not needed for before\/after comparison/);
  assert.doesNotMatch(onDisk, /not needed in history/);
});

test("saving version 11 evicts the oldest and always caps the file at 10", async (t) => {
  const root = await temporaryRoot(t);
  const ids = [];
  for (let i = 0; i < MAX_AUDIT_HISTORY + 1; i++) {
    const saved = await saveAuditHistorySnapshot(sample({ pages_discovered: i }), root);
    ids.push(saved.items[0].id);
    assert.equal(saved.count, Math.min(i + 1, MAX_AUDIT_HISTORY));
    if (i === MAX_AUDIT_HISTORY) assert.equal(saved.evicted_id, ids[0]);
  }
  const current = await listAuditHistory(root);
  assert.equal(current.items.length, MAX_AUDIT_HISTORY);
  assert.equal(current.items[0].id, ids.at(-1));
  assert.equal(current.items.at(-1).id, ids[1]);
  await assert.rejects(getAuditHistorySnapshot(ids[0], root), /not found/i);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".mcp-validator", "audit-history.json"), "utf8"));
  assert.equal(saved.items.length, 10);
  assert.equal(saved.items[0].id, ids[1]);
});

test("rejects credential/query-bearing URLs rather than persisting tokens", async (t) => {
  const root = await temporaryRoot(t);
  for (const bad of [
    sample({ site_url: "https://example.com/?token=private" }),
    sample({ site_url: "https://user:secret@example.com/" }),
    sample({ pages: [{ ...JSON.parse(sample()).pages[0], url: "https://example.com/a?key=private" }] }),
  ]) {
    assert.throws(() => parseCompactAuditSnapshot(bad), /valid bounded/i);
    await assert.rejects(saveAuditHistorySnapshot(bad, root), /valid bounded/i);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("invalid or corrupt existing history fails closed without data loss", async (t) => {
  const root = await temporaryRoot(t);
  const dir = path.join(root, ".mcp-validator");
  await fs.mkdir(dir);
  const history = path.join(dir, "audit-history.json");
  await fs.writeFile(history, "{corrupt", "utf8");
  await assert.rejects(saveAuditHistorySnapshot(sample(), root), /corrupt/i);
  assert.equal(await fs.readFile(history, "utf8"), "{corrupt");
});

test("concurrent saves serialize without losing entries", async (t) => {
  const root = await temporaryRoot(t);
  await Promise.all(Array.from({ length: 17 }, (_, i) =>
    saveAuditHistorySnapshot(sample({ pages_discovered: i }), root)));
  const current = await listAuditHistory(root);
  assert.equal(current.count, 10);
  assert.equal(new Set(current.items.map((item) => item.id)).size, 10);
  const file = JSON.parse(await fs.readFile(path.join(root, ".mcp-validator", "audit-history.json"), "utf8"));
  assert.deepEqual(file.items.map((item) => item.snapshot.pages_discovered), [7,8,9,10,11,12,13,14,15,16]);
});
