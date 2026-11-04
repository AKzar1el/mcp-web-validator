#!/usr/bin/env node
// Offline metadata gate using the published local stdio MCP server.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  console.error("Usage: node check-metadata.mjs <built-html-file>");
  process.exitCode = 2;
} else {
  const client = new Client({ name: "web-validator-ci-example", version: "1.0.0" });
  try {
    const htmlContent = await readFile(inputPath, "utf8");
    if (htmlContent.length === 0 || htmlContent.length > 2_000_000) {
      throw new Error("HTML must contain 1 to 2,000,000 characters");
    }
    // An explicit local path enables offline regression tests; the normal
    // workflow resolves the installed npm package, not a remote server.
    const serverEntry = process.env.WEB_VALIDATOR_SERVER_PATH
      ? path.resolve(process.env.WEB_VALIDATOR_SERVER_PATH)
      : createRequire(import.meta.url).resolve("mcp-web-validator");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      stderr: "pipe",
    });
    await client.connect(transport);
    const response = await client.callTool({
      name: "seo.metadata",
      arguments: { htmlContent },
    });
    const counts = response.structuredContent?.counts;
    if (response.isError || !counts ||
        !["error", "warning", "info"].every((key) =>
          Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
      throw new Error("Web Validator did not return valid SEO issue counts");
    }
    console.log(`Web Validator metadata: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info`);
    if (counts.error > 0) {
      for (const issue of (response.structuredContent.issues ?? [])
        .filter((item) => item.severity === "error")
        .slice(0, 10)) {
        // Codes are fixed by the validator. Avoid logging arbitrary page text.
        console.error(`- ${issue.code}`);
      }
      console.error("Metadata gate failed: review error codes; warnings are advisory");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Metadata gate could not finish: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  } finally {
    await client.close();
  }
}
