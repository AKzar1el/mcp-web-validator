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
      "audit.history", "content.duplicates", "content.quality", "css.local", "html.local", "html.url", "links.broken",
      "report.validation", "schema.markup", "screenshot.capture", "seo.metadata", "site.hreflang",
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

  const sampleWords = Array.from({ length: 120 }, (_, i) => `installedtestword${i}`).join(" ");
  const duplicateContent = await client.callTool({
    name: "content.duplicates",
    arguments: {
      pages: ["a", "b"].map((page) => ({
        url: `https://example.test/${page}`,
        htmlContent: `<!doctype html><html lang="en"><main><p>${sampleWords}</p></main></html>`,
      })),
    },
  });
  assert.notEqual(duplicateContent.isError, true);
  assert.equal(duplicateContent.structuredContent?.total_pairs, 1);
  assert.equal(duplicateContent.structuredContent?.pairs?.[0]?.kind, "exact");
  assert.ok(!JSON.stringify(duplicateContent).includes("installedtestword50"));

  const quality = await client.callTool({
    name: "content.quality",
    arguments: {
      pages: ["one", "two"].map((page) => ({
        url: `https://example.test/products/${page}`,
        htmlContent: "<!doctype html><html lang=en><main></main></html>",
      })),
    },
  });
  assert.notEqual(quality.isError, true);
  assert.equal(quality.structuredContent?.empty_main_pages, 2);
  assert.ok(quality.structuredContent?.findings?.some((f) => f.code === "content.family_empty"));

  const en = "https://example.test/en/", de = "https://example.test/de/";
  const hreflangHead = (canonical, alternates) =>
    '<html lang="en"><head><link rel="canonical" href="' + canonical + '">'
    + alternates.map(([locale, target]) =>
      '<link rel="alternate" hreflang="' + locale + '" href="' + target + '">').join("")
    + '</head><body><main>Test page</main></body></html>';
  const multilingual = await client.callTool({
    name: "site.hreflang",
    arguments: {
      pages: [
        { url: en, htmlContent: hreflangHead(en, [["en", en], ["de", de]]) },
        { url: de, htmlContent: hreflangHead(de, [["de", de]]) },
      ],
    },
  });
  assert.notEqual(multilingual.isError, true);
  assert.ok(multilingual.structuredContent?.findings?.some((finding) =>
    finding.code === "multilingual.return_link_missing"));

  if (process.env.MCP_SMOKE_SKIP_SCREENSHOT === "1") {
    console.log("Installed npm tarball MCP handshake and offline feature tools: PASS (screenshot intentionally skipped)");
  } else {
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
    console.log("Installed npm tarball MCP handshake, offline audits, multilingual comparison and sandboxed screenshot: PASS");
  }
} finally {
  if (client) await client.close();
  try {
    // Windows can briefly retain Chromium file handles after MCP shutdown.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    // Report cleanup separately from functional test failure. The scratch path
    // is a unique OS temp directory, never a user or project directory.
    if (process.platform !== "win32" ||
      !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
    console.warn("Windows kept the package smoke temporary directory locked; functional checks above are unaffected.");
  }
}
