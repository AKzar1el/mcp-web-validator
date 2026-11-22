import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("hosted smoke expected catalog matches every public Worker registration", () => {
  const smoke = readFileSync(new URL("../scripts/smoke-hosted-mcp.mjs", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../chatgpt-plugin/src/worker.ts", import.meta.url), "utf8");
  const expectedBlock = smoke.match(/const expectedTools = \[([\s\S]*?)\];/);
  assert.ok(expectedBlock, "hosted smoke must declare its expected tool catalog");
  const expected = [...expectedBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const registered = [...worker.matchAll(/registerAppTool\(\s*server,\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(registered.length > 0, "hosted Worker must register public MCP tools");
  assert.equal(new Set(expected).size, expected.length, "expected tools must be unique");
  assert.equal(new Set(registered).size, registered.length, "registered tools must be unique");
  assert.deepEqual(expected, registered, "update the hosted smoke catalog alongside Worker tool registrations");
});
