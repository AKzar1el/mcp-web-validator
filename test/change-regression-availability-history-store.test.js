import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import {
  getAvailabilityHistory,
  saveAvailabilityObservation,
  MAX_AVAILABILITY_HISTORY,
} from "../dist/modules/change-regression/availability-history-store.js";

const url = "https://example.com/";
const other = "https://other.example.com/";
const sample = (minute, status_code = 200) => ({
  observed_at: new Date(Date.UTC(2026, 10, 20, 11, minute)).toISOString(),
  status_code,
});
async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-validator-v02-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function file(root) {
  return path.join(root, ".mcp-validator", "availability-history.json");
}

test("V02: an empty local list/compare never creates data, and exact host is isolated", async (t) => {
  const root = await scratch(t);
  assert.deepEqual(await getAvailabilityHistory(url, root), { count: 0, records: [] });
  await assert.rejects(fs.stat(file(root)), { code: "ENOENT" });
  const saved = await saveAvailabilityObservation(url, sample(0), root);
  assert.equal(saved.count, 1);
  assert.equal(saved.records[0].observation.status_code, 200);
  assert.equal(saved.records[0].saved_at.length > 0, true);
  assert.equal((await getAvailabilityHistory(other, root)).count, 0);
  assert(!JSON.stringify(saved).includes(url));
  assert(!JSON.stringify(saved).includes(other));
  const bytes = await fs.readFile(file(root), "utf8");
  const entries = JSON.parse(bytes);
  assert.equal(entries.version, 1);
  assert.equal(entries.items[0].url, url);
  assert.deepEqual(await getAvailabilityHistory(url, root),
    { count: 1, records: saved.records });
});

test("V02: save ten and evict the oldest on eleven, in a small stable archive", async (t) => {
  const root = await scratch(t);
  let first;
  let latest;
  for (let i = 0; i < MAX_AVAILABILITY_HISTORY + 1; i++) {
    const res = await saveAvailabilityObservation(url, sample(i, i === 4 ? 503 : 200), root);
    if (i === 0) first = res.saved_id;
    latest = res;
  }
  assert.equal(latest.count, 10);
  assert.equal(latest.evicted_id, first);
  assert.equal(latest.records[0].observation.observed_at, sample(1).observed_at);
  assert.equal(latest.records[9].observation.observed_at, sample(10).observed_at);
  assert.equal(JSON.parse(await fs.readFile(file(root), "utf8")).items.length, 10);
});

test("V02: duplicate capture is idempotent, but retroactive, inconsistent and invalid samples fail", async (t) => {
  const root = await scratch(t);
  const first = await saveAvailabilityObservation(url, sample(3, 429), root);
  const again = await saveAvailabilityObservation(url, sample(3, 429), root);
  assert.equal(again.saved_id, first.saved_id);
  assert.equal(again.count, 1);
  const originalBytes = await fs.readFile(file(root));
  for (const invalid of [
    sample(2), sample(3, 200), { observed_at: sample(5).observed_at },
    { ...sample(5), status_code: 200, failure: "timeout" },
  ]) {
    await assert.rejects(async () => saveAvailabilityObservation(url, invalid, root));
  }
  await assert.rejects(async () => saveAvailabilityObservation(
    "https://example.com/?token=supersecret", sample(5), root));
  assert.deepEqual(await fs.readFile(file(root)), originalBytes);
});

test("V02: concurrent saves serialize and preserve all observations", async (t) => {
  const root = await scratch(t);
  const results = await Promise.all([
    saveAvailabilityObservation(url, sample(0), root),
    saveAvailabilityObservation(url, sample(1), root),
    saveAvailabilityObservation(url, sample(2), root),
  ]);
  assert.equal(results.length, 3);
  const got = await getAvailabilityHistory(url, root);
  assert.equal(got.count, 3);
  assert.deepEqual(got.records.map((r) => r.observation.status_code), [200, 200, 200]);
  assert.deepEqual(got.records.map((r) => r.observation.observed_at),
    [sample(0).observed_at, sample(1).observed_at, sample(2).observed_at]);
});

test("V02: global ten-entry eviction never reveals another URL's private history ID", async (t) => {
  const root = await scratch(t);
  const outside = await saveAvailabilityObservation(other, sample(0), root);
  let latest;
  for (let i = 0; i < MAX_AVAILABILITY_HISTORY; i++) {
    latest = await saveAvailabilityObservation(url, sample(i), root);
  }
  assert.equal(latest.count, 10);
  assert.equal(latest.evicted_id, undefined);
  assert.equal((await getAvailabilityHistory(other, root)).count, 0);
  assert(!JSON.stringify(latest).includes(outside.saved_id));
});

test("V02: corrupted or oversized local state is not overwritten", async (t) => {
  const root = await scratch(t);
  await fs.mkdir(path.join(root, ".mcp-validator"));
  await fs.writeFile(file(root), "{broken json");
  const before = await fs.readFile(file(root));
  await assert.rejects(getAvailabilityHistory(url, root));
  await assert.rejects(saveAvailabilityObservation(url, sample(0), root));
  assert.deepEqual(await fs.readFile(file(root)), before);
  await fs.writeFile(file(root), "x".repeat(24001));
  await assert.rejects(getAvailabilityHistory(url, root));
  await assert.rejects(saveAvailabilityObservation(url, sample(0), root));
});

test("V02: history directory/file symlink is rejected, where supported", async (t) => {
  const root = await scratch(t);
  const outside = await scratch(t);
  await fs.mkdir(path.join(outside, "real"));
  const link = path.join(root, ".mcp-validator");
  try {
    await fs.symlink(path.join(outside, "real"), link, "junction");
  } catch (cause) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(cause.code)) {
      t.skip("Windows does not permit this symlink on this machine");
      return;
    }
    throw cause;
  }
  await assert.rejects(getAvailabilityHistory(url, root));
  await assert.rejects(saveAvailabilityObservation(url, sample(0), root));
  await assert.rejects(fs.stat(path.join(outside, "real", "availability-history.json")),
    { code: "ENOENT" });
});
