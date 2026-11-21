import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { selectActivation } from "../scripts/activation-core.mjs";

const silent = () => {};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-activation-test-"));
  const upstream = path.join(root, "upstream");
  const home = path.join(root, "cache");
  await mkdir(upstream);
  git(upstream, "init", "-b", "main");
  const fallback = path.join(root, "fallback.js");
  await writeFile(fallback, "console.log('original');\n");
  async function commit(label) {
    await writeFile(path.join(upstream, "source.txt"), label + "\n");
    git(upstream, "-c", "core.autocrlf=false", "add", "-A");
    git(upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "-m", label);
    return git(upstream, "rev-parse", "HEAD");
  }
  const first = await commit("first");
  let installations = 0;
  async function install(dir) {
    installations += 1;
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "index.js"), await readFile(path.join(dir, "source.txt")));
  }
  return { root, upstream, home, fallback, commit, first, install, get installations() { return installations; } };
}

test("activation fetches and verifies an isolated main revision, caching it for re-use", async (t) => {
  const f = await fixture();
  t.after(async () => rm(f.root, { recursive: true, force: true }));
  const args = { home: f.home, origin: f.upstream, fallback: f.fallback, install: f.install, log: silent };
  const first = await selectActivation(args);
  assert.equal(first.sha, f.first);
  assert.equal(first.source, "upstream-main");
  assert.equal((await readFile(first.entry, "utf8")).trim(), "first");
  assert.equal(f.installations, 1);
  const second = await selectActivation(args);
  assert.equal(second.sha, f.first);
  assert.equal(second.source, "cached");
  assert.equal(f.installations, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.home, "active.json"))).sha, f.first);
  assert.equal((await readFile(path.join(f.upstream, "source.txt"), "utf8")).trim(), "first");
});

test("failed new build retains last-known-good build and does not advance state", async (t) => {
  const f = await fixture();
  t.after(async () => rm(f.root, { recursive: true, force: true }));
  const args = { home: f.home, origin: f.upstream, fallback: f.fallback, install: f.install, log: silent };
  const before = await selectActivation(args);
  await f.commit("second");
  const errors = [];
  const selected = await selectActivation({
    ...args, install: async () => { throw new Error("injected test build failure"); },
    log: (message) => errors.push(message),
  });
  assert.equal(selected.sha, before.sha);
  assert.equal(selected.source, "cached");
  assert(errors.some((line) => line.includes("injected test build failure")));
  assert.equal(JSON.parse(await readFile(path.join(f.home, "active.json"))).sha, before.sha);
  const after = await selectActivation(args);
  assert.notEqual(after.sha, before.sha);
  assert.equal((await readFile(after.entry, "utf8")).trim(), "second");
});

test("offline policy and a competing activation lock never modify cached revisions", async (t) => {
  const f = await fixture();
  t.after(async () => rm(f.root, { recursive: true, force: true }));
  const args = { home: f.home, origin: f.upstream, fallback: f.fallback, install: f.install, log: silent };
  const initial = await selectActivation(args);
  const newer = await f.commit("second");
  assert.notEqual(newer, initial.sha);
  const offline = await selectActivation({ ...args, offline: true });
  assert.equal(offline.sha, initial.sha);
  const lock = path.join(f.home, ".activation-lock");
  await mkdir(lock);
  const locked = await selectActivation(args);
  assert.equal(locked.sha, initial.sha);
  await access(lock);
  assert.equal(f.installations, 1);
});

test("invalid cached state cannot traverse directories; first-run offline uses only local fallback", async (t) => {
  const f = await fixture();
  t.after(async () => rm(f.root, { recursive: true, force: true }));
  const first = await selectActivation({
    home: f.home, origin: "C:/nonexistent/remote", fallback: f.fallback, log: silent, offline: true,
  });
  assert.equal(first.source, "local-fallback");
  await mkdir(f.home, { recursive: true });
  await writeFile(path.join(f.home, "active.json"), '{"sha":"../../outside"}\n');
  const offline = await selectActivation({ home: f.home, fallback: f.fallback, offline: true, log: silent });
  assert.equal(offline.source, "local-fallback");
});

test("network failure starts the last verified revision without altering main or its cache", async (t) => {
  const f = await fixture();
  t.after(async () => rm(f.root, { recursive: true, force: true }));
  const before = await selectActivation({
    home: f.home, origin: f.upstream, fallback: f.fallback, install: f.install, log: silent,
  });
  const fallback = await selectActivation({
    home: f.home, origin: path.join(f.root, "missing"), fallback: f.fallback, install: f.install, log: silent,
  });
  assert.equal(fallback.sha, before.sha);
  assert.equal(fallback.source, "cached");
});

test("optional launcher preserves MCP stdout protocol and offline call semantics", { timeout: 120_000 }, async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "activate-web-validator.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    env: { ...process.env, MCP_WEB_VALIDATOR_UPDATE_POLICY: "offline" },
    stderr: "pipe",
  });
  const client = new Client({ name: "activation-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert(tools.length >= 39);
    const result = await client.callTool({ name: "seo.metadata", arguments: {
      htmlContent: "<!doctype html><html lang=\"en\"><head><title>Activation</title></head><body><h1>Test</h1></body></html>",
    } });
    assert.equal(result.isError, undefined);
    assert(result.structuredContent && typeof result.structuredContent === "object");
  } finally {
    await client.close();
  }
});
