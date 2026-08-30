import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("MCPB manifest uses static tool declarations only", () => {
  assert.ok(Array.isArray(manifest.tools));
  assert.ok(manifest.tools.length > 0);

  for (const tool of manifest.tools) {
    const keys = Object.keys(tool).sort();
    assert.ok(tool.name, "tool is missing name");
    assert.deepEqual(
      keys,
      tool.description ? ["description", "name"] : ["name"],
      `${tool.name} contains runtime-only MCP fields`,
    );
  }
});
