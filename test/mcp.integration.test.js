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

test("stdio MCP exposes valid contracts and structured offline results", { timeout: 60_000 }, async () => {
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
      "audit.history",
      "content.duplicates",
      "css.local",
      "html.local",
      "html.url",
      "links.broken",
      "report.validation",
      "schema.markup",
      "screenshot.capture",
      "seo.metadata",
      "site.hreflang",
    ]);

    const seoTool = tools.find((tool) => tool.name === "seo.metadata");
    assert.ok((seoTool?.description ?? "").includes("Use for a quick on-page check"));
    assert.ok((seoTool?.description ?? "").includes("html.local/html.url"));
    assert.ok((seoTool?.description ?? "").includes("schema.markup"));
    assert.ok((seoTool?.description ?? "").includes("report.validation"));
    function assertInputDescriptions(schema, path) {
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        assert.equal(
          typeof property.description,
          "string",
          `${path}.${name} must describe what the input accepts`,
        );
        assertInputDescriptions(property, `${path}.${name}`);
      }
      if (schema.items) {
        assertInputDescriptions(schema.items, `${path}[]`);
      }
    }

    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9._-]{1,64}$/);
      assert.match(tool.name, /^[^.]+\.[^.]+$/, `${tool.name} must use a shallow dot-notation path`);
      assert.equal(typeof tool.title, "string");
      assertInputDescriptions(tool.inputSchema, tool.name);
      assert.ok(tool.outputSchema, `${tool.name} must advertise structured output`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean");
    }

    const seo = await client.callTool({
      name: "seo.metadata",
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

    const duplicateWords = Array.from({ length: 130 }, (_, i) => `safetopic${i}`).join(" ");
    const duplicatePages = ["a", "b"].map((name) => ({
      url: `https://example.test/${name}`,
      htmlContent: `<!doctype html><html lang="en"><body><main><p>${duplicateWords}</p></main></body></html>`,
    }));
    const duplicates = await client.callTool({
      name: "content.duplicates",
      arguments: { pages: duplicatePages },
    });
    assert.equal(duplicates.isError, undefined);
    assert.equal(duplicates.structuredContent?.total_pairs, 1);
    assert.equal(duplicates.structuredContent?.pairs?.[0]?.kind, "exact");
    assert.equal(duplicates.structuredContent?.pairs?.[0]?.similarity_percent, 100);
    assert.match(textContent(duplicates), /same-language/i);
    assert.doesNotMatch(JSON.stringify(duplicates), /safetopic50/);

    const english = "https://example.test/en/";
    const german = "https://example.test/de/";
    const head = (self, links) => '<!doctype html><html lang="'
      + (self === english ? "en" : "de")
      + '"><head><link rel="canonical" href="' + self + '">'
      + links.map(([locale, url]) => '<link rel="alternate" hreflang="' + locale + '" href="' + url + '">').join("")
      + '</head><body><main>Localized page</main></body></html>';
    const hreflang = await client.callTool({
      name: "site.hreflang",
      arguments: {
        pages: [
          { url: english, htmlContent: head(english, [["en", english], ["de", german]]) },
          { url: german, htmlContent: head(german, [["de", german]]) },
        ],
      },
    });
    assert.equal(hreflang.isError, undefined);
    assert.equal(hreflang.structuredContent?.sampled_pages, 2);
    assert.equal(hreflang.structuredContent?.unobserved_targets, 0);
    assert(hreflang.structuredContent?.findings?.some((finding) =>
      finding.code === "multilingual.return_link_missing"));
    assert.match(textContent(hreflang), /hreflang/i);

    const schema = await client.callTool({
      name: "schema.markup",
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
      name: "schema.markup",
      arguments: { htmlContent: "<!doctype html><html><body><h1>No schema</h1></body></html>" },
    });
    assert.deepEqual(absentSchema.structuredContent?.issues, []);
    assert.match(textContent(absentSchema), /^### JSON-LD syntax: not present/m);
    assert.match(textContent(absentSchema), /No JSON-LD script blocks were found/);

    const schemaBlockCount = 205;
    const truncatedSchema = await client.callTool({
      name: "schema.markup",
      arguments: {
        htmlContent: Array.from(
          { length: schemaBlockCount },
          () => '<script type="application/ld+json">{</script>',
        ).join(""),
      },
    });
    const schemaDetails = truncatedSchema.structuredContent;
    assert.ok(schemaDetails?.issues.length > 0);
    assert.ok(schemaDetails.issues.length < 200, "MCP output must not expose the entire oversized issue list");
    assert.equal(schemaDetails.totalIssues, schemaBlockCount);
    assert.equal(schemaDetails.counts.error, schemaBlockCount);
    assert.equal(schemaDetails.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(schemaDetails), "utf8") < 18_000,
      "MCP structured diagnostics must stay below the gateway's response budget");
    assert.match(textContent(truncatedSchema),
      new RegExp(`Showing the first ${schemaDetails.issues.length} of 205 findings`));

    // Long untrusted elements can make even a modest issue count exceed gateway limits.
    const images = Array.from({ length: 240 }, (_, i) =>
      `<img src="/${"a".repeat(400)}-${i}.png">`).join("");
    const floodSeo = await client.callTool({
      name: "seo.metadata",
      arguments: { htmlContent: `<!doctype html><html><body>${images}</body></html>` },
    });
    const seoDetails = floodSeo.structuredContent;
    assert.ok(seoDetails?.counts.error >= 240);
    assert.ok(seoDetails.issues.length > 0 && seoDetails.issues.length < 240);
    assert.equal(seoDetails.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(seoDetails), "utf8") < 18_000,
      "Long untrusted HTML attributes must not overwhelm the MCP response");

    const blockedLinks = await client.callTool({
      name: "links.broken",
      arguments: {
        htmlContent: Array.from({ length: 25 }, (_, i) =>
          `<a href="http://127.0.0.1/private/${i}/${"a".repeat(1900)}">blocked</a>`).join(""),
        maxLinks: 25,
      },
    });
    const boundedLinks = blockedLinks.structuredContent;
    assert.equal(blockedLinks.isError, undefined);
    assert.equal(boundedLinks.totalLinks, 25);
    assert.equal(boundedLinks.truncated, true);
    assert.ok(boundedLinks.links.length > 0 && boundedLinks.links.length < 25);
    assert.ok(boundedLinks.links.every((link) => link.status === "blocked"));
    assert.ok(Buffer.byteLength(JSON.stringify(boundedLinks), "utf8") < 18_000);
    assert.match(textContent(blockedLinks), /all results/i);

    const unreadableReport = await client.callTool({
      name: "report.validation",
      arguments: { htmlFilePath: "definitely-missing-report-input.html" },
    });
    assert.equal(unreadableReport.isError, true);
    assert.deepEqual(unreadableReport.structuredContent?.failedChecks, ["input"]);
    assert.match(textContent(unreadableReport), /^### Validation report: could not finish/m);

    const screenshot = tools.find((tool) => tool.name === "screenshot.capture");
    assert.equal(screenshot?.annotations?.readOnlyHint, false);
    assert.equal(screenshot?.annotations?.destructiveHint, true);
    const history = tools.find((tool) => tool.name === "audit.history");
    assert.equal(history?.annotations?.readOnlyHint, false);
    assert.equal(history?.annotations?.destructiveHint, true);
  } finally {
    await client.close();
  }
});

test("stdio MCP rejects HTML input beyond the UTF-8 byte cap", { timeout: 60_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, "dist", "index.js")],
    stderr: "pipe",
  });
  const client = new Client({ name: "utf8-size-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const validHtml = "\u00e9".repeat(1_000_000);
    const validResult = await client.callTool({
      name: "schema.markup",
      arguments: { htmlContent: validHtml },
    });
    assert.equal(validResult.isError, undefined, "exactly 2,000,000 UTF-8 bytes must remain valid");

    // The character count is below the HTML limit, but UTF-8 takes 2 bytes per character.
    const oversizedHtml = "\u00e9".repeat(1_000_001);
    const result = await client.callTool({
      name: "seo.metadata",
      arguments: { htmlContent: oversizedHtml },
    });
    assert.equal(result.isError, true, "2,000,002 UTF-8 bytes must not pass a 2,000,000-byte cap");
    assert.match(textContent(result), /UTF-8 bytes/i);
  } finally {
    await client.close();
  }
});
