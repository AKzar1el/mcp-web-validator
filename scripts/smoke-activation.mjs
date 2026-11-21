// Bounded offline canary for a newly built activation candidate.
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), "dist", "index.js")],
  stderr: "pipe",
});
const client = new Client({ name: "activation-canary", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const name of ["seo.metadata", "schema.markup", "http.delivery", "site.sitemaps"]) {
    assert(names.has(name), `Missing essential MCP tool ${name}`);
  }
  assert(tools.length >= 39, `MCP tool catalog unexpectedly shrank to ${tools.length}`);
  const result = await client.callTool({
    name: "seo.metadata",
    arguments: {
      htmlContent: "<!doctype html><html lang=\"en\"><head><title>Activation smoke</title></head><body><main><h1>Smoke</h1></main></body></html>",
    },
  });
  assert.equal(result.isError, undefined, "Offline SEO call returned an MCP error");
  assert(result.structuredContent && typeof result.structuredContent === "object", "Missing structured MCP response");
  console.error(`[web-validator activation] MCP stdio canary passed (${tools.length} tools).`);
} finally {
  await client.close();
}
