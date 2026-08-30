import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repositoryRoot, "dist", "index.js")],
  stderr: "pipe",
});
const client = new Client({ name: "manifest-synchronizer", version: packageJson.version });

await client.connect(transport);
let tools;
try {
  ({ tools } = await client.listTools());
} finally {
  await client.close();
}

const manifestTools = tools.map(({ name, description }) => ({
  name,
  ...(description ? { description } : {}),
}));
const files = [
  { name: "manifest.json", tools: manifestTools },
  { name: "server.json", tools },
];
const checkOnly = process.argv.includes("--check");

for (const { name, tools: expectedTools } of files) {
  const filePath = path.join(repositoryRoot, name);
  const current = JSON.parse(await readFile(filePath, "utf8"));
  const expected = { ...current, version: packageJson.version, tools: expectedTools };

  if (checkOnly) {
    assert.deepStrictEqual(
      current,
      expected,
      `${name} is stale. Run npm run sync:manifests and commit the result.`,
    );
  } else {
    await writeFile(filePath, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
    console.log(`Updated ${name} with ${expectedTools.length} tool definitions.`);
  }
}
