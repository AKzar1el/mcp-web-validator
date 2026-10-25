import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = await mkdtemp(path.join(tmpdir(), "mcp-web-validator-installed-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let client;

try {
  // Use the distributable, not repository dist/index.js or source node_modules.
  const { stdout } = await execFileAsync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
    { cwd: repositoryRoot, shell: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe") : false, timeout: 90_000, maxBuffer: 2_000_000 },
  );
  const packages = JSON.parse(stdout);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].name, "mcp-web-validator");

  const consumer = path.join(scratch, "consumer");
  await mkdir(consumer);
  await execFileAsync(
    npm,
    [
      "install", "--prefix", consumer, "--omit=dev",
      "--ignore-scripts", "--no-audit", "--no-fund",
      path.join(scratch, packages[0].filename),
    ],
    { cwd: scratch, shell: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe") : false, timeout: 120_000, maxBuffer: 2_000_000 },
  );

  const installedEntry = path.join(
    consumer, "node_modules", "mcp-web-validator", "dist", "index.js",
  );
  assert.ok((await stat(installedEntry)).isFile());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [installedEntry],
    stderr: "pipe",
  });
  client = new Client({ name: "installed-package-smoke", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "css.local", "html.local", "html.url", "links.broken",
      "report.validation", "schema.markup", "screenshot.capture", "seo.metadata",
    ],
  );

  // No external validator or third-party website is contacted by this tool.
  const localAudit = await client.callTool({
    name: "seo.metadata",
    arguments: {
      htmlContent: "<!doctype html><html><head><title>Installed package smoke</title></head><body><h1>Smoke</h1></body></html>",
    },
  });
  assert.notEqual(localAudit.isError, true);
  assert.ok(Array.isArray(localAudit.structuredContent?.issues));

  const fixture = path.join(scratch, "fixture.html");
  const outputDir = path.join(scratch, "screenshots");
  await writeFile(fixture, "<!doctype html><title>Installed browser smoke</title><h1>Installed browser smoke</h1>");

  // The Ubuntu CI job configures an executable-specific AppArmor rule first;
  // the browser must still launch with its sandbox intact.
  const screenshot = await client.callTool({
    name: "screenshot.capture",
    arguments: {
      targetPath: fixture,
      outputDir,
      viewports: [{ name: "installed", width: 800, height: 600 }],
    },
  });
  assert.notEqual(screenshot.isError, true, JSON.stringify(screenshot.structuredContent));
  assert.equal(screenshot.structuredContent?.screenshots?.length, 1);
  const imagePath = screenshot.structuredContent.screenshots[0].outputPath;
  assert.ok((await stat(imagePath)).size > 0);
  console.log("Installed npm tarball MCP handshake, offline audit and sandboxed screenshot: PASS");
} finally {
  if (client) await client.close();
  await rm(scratch, { recursive: true, force: true });
}
