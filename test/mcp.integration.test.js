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
      "content.competitors",
      "content.duplicates",
      "content.provenance",
      "content.quality",
      "css.local",
      "html.local",
      "html.url",
      "links.broken",
      "product.claims",
      "report.validation",
      "schema.markup",
      "schema.supported",
      "screenshot.capture",
      "seo.metadata",
      "site.hreflang",
      "site.links",
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

    const sampleCompetition = await client.callTool({
      name: "content.competitors",
      arguments: {
        primary: {
          url: "https://example.test/guide",
          htmlContent: '<html><head><title>Posture lesson</title></head><body><main>'
            + '<h1>A posture lesson</h1><p>Read the article.</p></main></body></html>',
        },
        competitors: ["shop-one", "shop-two"].map((site) => ({
          url: "https://" + site + ".test/product",
          htmlContent: '<html><head><title>Best ergonomic chair</title>'
            + '<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":99}}</script>'
            + '</head><body><main><h1>Best ergonomic chair</h1>'
            + '<a href="/checkout">Buy now</a></main></body></html>',
        })),
        expected_intent: "commercial",
        query: "best ergonomic chair",
      },
    });
    assert.equal(sampleCompetition.isError, undefined);
    assert.equal(sampleCompetition.structuredContent?.scope, "caller_supplied_static_html_only");
    assert.equal(sampleCompetition.structuredContent?.competitors_eligible, 2);
    assert.equal(sampleCompetition.structuredContent?.competitors_with_intent_signals, 2);
    assert(sampleCompetition.structuredContent?.findings?.some((f) =>
      f.code === "primary_intent_signal_gap"));
    assert(sampleCompetition.structuredContent?.coverage_limited);
    assert.match(textContent(sampleCompetition), /competitor search-intent/i);
    assert.doesNotMatch(JSON.stringify(sampleCompetition), /Posture lesson/);

    const provenanceSource = "https://doi.org/10.1000/sample";
    const provenancePage = '<html><head><meta property=article:published_time content=2026-11-01>'
      + '<meta property=article:modified_time content=2026-11-10></head><body><main>'
      + '<a rel=cite data-citation-id=study_2026 href="' + provenanceSource + '">Study</a>'
      + '<div data-dataset-id=query_data data-dataset-version=v2 data-dataset-as-of=2026-11-10'
      + ' data-methodology-id=weighted></div>'
      + '<a data-methodology-id=weighted href="https://example.test/methods">Methods</a>'
      + '</main></body></html>';
    const provenance = await client.callTool({
      name: "content.provenance",
      arguments: {
        pages: [{ url: "https://example.test/report", htmlContent: provenancePage }],
        evidence: {
          as_of: "2026-11-19",
          sources: [{ id: "study_2026", url: provenanceSource }],
          datasets: [{ id: "query_data", version: "v2", as_of: "2026-11-10",
            methodology_id: "weighted", max_age_days: 14 }],
          methodologies: [{ id: "weighted", url: "https://example.test/methods" }],
        },
      },
    });
    assert.equal(provenance.isError, undefined);
    assert.equal(provenance.structuredContent?.citations_observed, 1);
    assert.equal(provenance.structuredContent?.datasets_observed, 1);
    assert.equal(provenance.structuredContent?.conflicting_declarations, 0);
    assert.equal(provenance.structuredContent?.unverified_declarations, 0);
    assert.match(textContent(provenance), /citation|methodology/i);
    assert.doesNotMatch(JSON.stringify(provenance), /data-methodology-id=weighted/);

    const goodJsonld = '<html><head><script type="application/ld+json">'
      + '{"@context":"https://schema.org","@graph":['
      + '{"@type":"Article","headline":"A review","author":{"@type":"Person","name":"Writer"}},'
      + '{"@type":"Product","name":"Chair","offers":{"@type":"Offer","price":0,"priceCurrency":"EUR"}}'
      + ']}</script></head><body><main>Review text</main></body></html>';
    const supported = await client.callTool({
      name: "schema.supported",
      arguments: { htmlContent: goodJsonld },
    });
    assert.equal(supported.isError, undefined);
    assert.equal(supported.structuredContent?.blocks_seen, 1);
    assert.equal(supported.structuredContent?.supported_nodes, 2);
    assert.equal(supported.structuredContent?.warnings, 0);
    assert.equal(supported.structuredContent?.errors, 0);
    assert.equal(supported.structuredContent?.coverage_limited, true);
    assert.match(textContent(supported), /JSON-LD structural review/i);
    assert.doesNotMatch(JSON.stringify(supported), /A review/);

    const internalLinks = await client.callTool({
      name: "site.links",
      arguments: {
        pages: [
          {
            url: "https://example.test/guides/work",
            htmlContent: '<html><head><title>Work guide</title></head><body>'
              + '<nav><a href="/products/chairs">Navigation</a></nav>'
              + '<main><h1>Work guide</h1>'
              + '<a href="/products/chairs">read more</a>'
              + '<a href="/products/chairs"><img src="chair.png" alt=""></a>'
              + '<a href="/unknown">An unknown guide</a>'
              + '</main></body></html>',
          },
          {
            url: "https://example.test/products/chairs",
            htmlContent: '<html><head><title>Ergonomic office chairs</title></head>'
              + '<main><h1>Office chairs</h1></main></html>',
          },
        ],
      },
    });
    assert.equal(internalLinks.isError, undefined);
    assert.equal(internalLinks.structuredContent?.pages_sampled, 2);
    assert.equal(internalLinks.structuredContent?.internal_links_observed, 3);
    assert.equal(internalLinks.structuredContent?.linked_sample_targets, 1);
    assert.equal(internalLinks.structuredContent?.unmatched_internal_links, 1);
    assert.equal(internalLinks.structuredContent?.generic_anchor_links, 1);
    assert.equal(internalLinks.structuredContent?.missing_anchor_labels, 1);
    assert(internalLinks.structuredContent?.coverage_limited);
    assert.match(textContent(internalLinks), /internal links and anchor/i);
    assert.doesNotMatch(JSON.stringify(internalLinks), /An unknown guide/);

    const brokenSchema = await client.callTool({
      name: "schema.supported",
      arguments: { htmlContent: '<script type="application/ld+json">'
        + '{"@context":"https://schema.org","@type":"Product","name":12,'
        + '"offers":{"@type":"Offer","price":"FAKE_PRICE"}}'
        + '</script>' },
    });
    assert.equal(brokenSchema.isError, undefined);
    assert(brokenSchema.structuredContent?.findings?.some((f) => f.code === "invalid_price"));
    assert.doesNotMatch(JSON.stringify(brokenSchema), /FAKE_PRICE/);


    const promised = await client.callTool({
      name: "product.claims",
      arguments: {
        htmlContent: '<html><body><main><section><h2>Local MCP tools</h2>'
          + '<code>screenshot.capture</code><code>invented_rank_tool</code>'
          + '</section><p>The local MCP provides responsive screenshots.</p></main></body></html>',
      },
    });
    assert.equal(promised.isError, undefined);
    assert.equal(promised.structuredContent?.catalog_available, true);
    assert.equal(promised.structuredContent?.surface, "local");
    assert.equal(promised.structuredContent?.contradicted_claims, 1);
    assert(promised.structuredContent?.findings?.some((finding) =>
      finding.code === "product.tool_missing" && finding.evidence_tool === "invented_rank_tool"));
    assert.match(textContent(promised), /landing-page promises/i);

    const quality = await client.callTool({
      name: "content.quality",
      arguments: {
        pages: ["one", "two"].map((page) => ({
          url: `https://example.test/products/${page}`,
          htmlContent: "<!doctype html><html lang=en><body><nav>Navigation</nav><main></main></body></html>",
        })),
      },
    });
    assert.equal(quality.isError, undefined);
    assert.equal(quality.structuredContent?.empty_main_pages, 2);
    assert(quality.structuredContent?.findings?.some((f) => f.code === "content.family_empty"));
    assert.match(textContent(quality), /content-quality|main-content quality/i);

    const unrelatedEmpty = await client.callTool({
      name: "content.quality",
      arguments: { pages: ["/privacy", "/contact"].map((path) => ({
        url: "https://example.test" + path,
        htmlContent: "<html lang=en><body><main></main></body></html>",
      })) },
    });
    assert.equal(unrelatedEmpty.isError, undefined);
    assert.equal(unrelatedEmpty.structuredContent?.empty_main_pages, 2);
    assert(!unrelatedEmpty.structuredContent?.findings?.some((f) => f.code === "content.family_empty"));

    const sharedUnpunctuated = Array.from({ length: 115 }, (_, i) => "reusable" + i).join(" ");
    const repeatedMain = await client.callTool({
      name: "content.quality",
      arguments: { pages: ["a", "b", "c"].map((page) => ({
        url: "https://example.test/products/" + page,
        htmlContent: '<html lang=en><body><main><p>' + sharedUnpunctuated
          + '</p><p>' + Array.from({ length: 15 }, (_, i) => "distinct" + page + i).join(" ")
          + '</p></main></body></html>',
      })) },
    });
    assert.equal(repeatedMain.isError, undefined);
    assert.equal(repeatedMain.structuredContent?.repeated_boilerplate_pages, 3);
    assert(repeatedMain.structuredContent?.findings?.some((f) => f.code === "content.family_repeated_boilerplate"));
    assert.doesNotMatch(JSON.stringify(repeatedMain), /reusable50/);

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
