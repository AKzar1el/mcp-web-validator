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
  { name: "manifest.json", tools: manifestTools, isMcpb: true },
  { name: "server.json", tools, isMcpb: false },
];
const versionOnlyFiles = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"];
const checkOnly = process.argv.includes("--check");

for (const { name, tools: expectedTools, isMcpb } of files) {
  const filePath = path.join(repositoryRoot, name);
  const current = JSON.parse(await readFile(filePath, "utf8"));
  const expected = {
    ...current,
    version: packageJson.version,
    tools: expectedTools,
    ...(isMcpb
      ? {
          server: {
            ...current.server,
            mcp_config: {
              ...current.server.mcp_config,
              env: {
                ...(current.server.mcp_config?.env ?? {}),
                PUPPETEER_CACHE_DIR: "${__dirname}/.mcpb-browser-cache",
              },
            },
          },
          compatibility: {
            ...(current.compatibility ?? {}),
            platforms: ["darwin", "win32"],
            runtimes: {
              ...(current.compatibility?.runtimes ?? {}),
              node: packageJson.engines.node,
            },
          },
        }
      : {}),
  };

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

for (const name of versionOnlyFiles) {
  const filePath = path.join(repositoryRoot, name);
  const current = JSON.parse(await readFile(filePath, "utf8"));
  const expected = { ...current, version: packageJson.version };

  if (checkOnly) {
    assert.deepStrictEqual(
      current,
      expected,
      `${name} is stale. Run npm run sync:manifests and commit the result.`,
    );
  } else {
    await writeFile(filePath, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
    console.log(`Updated ${name} to version ${packageJson.version}.`);
  }
}

const registryPath = path.join(repositoryRoot, "registry", "server.json");
const registryCurrent = JSON.parse(await readFile(registryPath, "utf8"));
assert.ok(
  registryCurrent.packages?.some(
    (registryPackage) => registryPackage.registryType === "npm" && registryPackage.identifier === packageJson.name,
  ),
  `registry/server.json must declare npm package ${packageJson.name}.`,
);
const registryExpected = {
  ...registryCurrent,
  version: packageJson.version,
  packages: registryCurrent.packages.map((registryPackage) =>
    registryPackage.registryType === "npm" && registryPackage.identifier === packageJson.name
      ? { ...registryPackage, version: packageJson.version }
      : registryPackage
  ),
};

if (checkOnly) {
  assert.deepStrictEqual(
    registryCurrent,
    registryExpected,
    "registry/server.json is stale. Run npm run sync:manifests and commit the result.",
  );
} else {
  await writeFile(registryPath, `${JSON.stringify(registryExpected, null, 2)}\n`, "utf8");
  console.log(`Updated registry/server.json to version ${packageJson.version}.`);
}
