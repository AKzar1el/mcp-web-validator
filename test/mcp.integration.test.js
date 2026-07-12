import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("stdio MCP exposes valid contracts and structured offline results", { timeout: 15_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, "dist", "index.js")],
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "css_validate_local",
      "html_validate_local",
      "html_validate_url",
      "links_check_broken",
      "report_generate_validation",
      "schema_validate_markup",
      "screenshot_capture",
      "seo_audit_metadata",
    ]);

    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.equal(typeof tool.title, "string");
      assert.ok(tool.outputSchema, `${tool.name} must advertise structured output`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean");
    }

    const seo = await client.callTool({
      name: "seo_audit_metadata",
      arguments: { htmlContent: "<!doctype html><html><head></head><body><h1>Test</h1></body></html>" },
    });
    assert.equal(seo.isError, undefined);
    assert.ok(Array.isArray(seo.structuredContent?.issues));
    assert.equal(typeof seo.structuredContent?.totalIssues, "number");
    const seoText = textContent(seo);
    assert.match(seoText, /^### SEO audit: attention needed/m);
    assert.match(seoText, /\*\*Fix first\*\*/);
    assert.match(seoText, /\*\*Next step:\*\*/);
    assert.ok(
      seoText.split("\n").filter((line) => line.startsWith("- **")).length <= 3,
      "SEO narration must show at most three prioritized findings",
    );
    assert.doesNotMatch(seoText, /"(?:issues|totalIssues|truncated)"\s*:/);

    const schema = await client.callTool({
      name: "schema_validate_markup",
      arguments: {
        htmlContent:
          '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>',
      },
    });
    assert.deepEqual(schema.structuredContent?.issues, []);
    const schemaText = textContent(schema);
    assert.match(schemaText, /^### JSON-LD syntax: clean/m);
    assert.match(schemaText, /1 JSON-LD block parsed without syntax errors/);
    assert.match(schemaText, /syntax only/i);
    assert.match(schemaText, /\*\*Next step:\*\*/);
    assert.doesNotMatch(schemaText, /"(?:issues|totalIssues|truncated)"\s*:/);

    const absentSchema = await client.callTool({
      name: "schema_validate_markup",
      arguments: { htmlContent: "<!doctype html><html><body><h1>No schema</h1></body></html>" },
    });
    assert.deepEqual(absentSchema.structuredContent?.issues, []);
    assert.match(textContent(absentSchema), /^### JSON-LD syntax: not present/m);
    assert.match(textContent(absentSchema), /No JSON-LD script blocks were found/);

    const schemaBlockCount = 205;
    const truncatedSchema = await client.callTool({
      name: "schema_validate_markup",
      arguments: {
        htmlContent: Array.from(
          { length: schemaBlockCount },
          () => '<script type="application/ld+json">{</script>',
        ).join(""),
      },
    });
    assert.equal(truncatedSchema.structuredContent?.issues.length, 200);
    assert.equal(truncatedSchema.structuredContent?.totalIssues, schemaBlockCount);
    assert.equal(truncatedSchema.structuredContent?.truncated, true);
    assert.match(textContent(truncatedSchema), /Showing the first 200 of 205 findings/);

    const screenshot = tools.find((tool) => tool.name === "screenshot_capture");
    assert.equal(screenshot?.annotations?.readOnlyHint, false);
    assert.equal(screenshot?.annotations?.destructiveHint, true);
  } finally {
    await client.close();
  }
});
