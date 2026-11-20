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
      "audit.monitor",
      "audit.trends",
      "availability.history",
      "browser.wcag",
      "content.competitors",
      "content.duplicates",
      "content.metadata",
      "content.provenance",
      "content.quality",
      "crawler.access",
      "css.local",
      "html.local",
      "html.url",
      "http.availability",
      "http.delivery",
      "http.directives",
      "http.security",
      "http.variants",
      "links.broken",
      "media.diagnostics",
      "product.claims",
      "report.validation",
      "schema.markup",
      "schema.supported",
      "screenshot.capture",
      "seo.metadata",
      "site.hreflang",
      "site.links",
    ]);

    const crawlerTool = tools.find((tool) => tool.name === "crawler.access");
    assert.equal(crawlerTool?.annotations?.readOnlyHint, true);
    assert.equal(crawlerTool?.outputSchema?.properties?.rows_checked?.maximum, 48);
    const robots = await client.callTool({
      name: "crawler.access",
      arguments: {
        site_url: "https://example.com/",
        robots_txt: "User-agent: Googlebot\nDisallow: /private",
        pages: [{
          url: "https://example.com/private/secret-to-redact",
          status_code: 200,
          html: "<meta name='googlebot' content='noindex'>",
          x_robots_tag: [],
        }],
        profiles: ["googlebot-smartphone", "bingbot"],
      },
    });
    assert.equal(robots.isError, undefined);
    assert.equal(robots.structuredContent?.rows_checked, 2);
    assert.equal(robots.structuredContent?.crawler_disallowed_rows, 1);
    assert.equal(robots.structuredContent?.noindex_declared_rows, 1);
    assert.equal(robots.structuredContent?.coverage_limited, true);
    assert(!JSON.stringify(robots).includes("secret-to-redact"));

    const deliveryTool = tools.find((tool) => tool.name === "http.delivery");
    assert.equal(deliveryTool?.annotations?.readOnlyHint, true);
    assert.equal(deliveryTool?.outputSchema?.properties?.hops_observed?.maximum, 4);
    const edgeSample = await client.callTool({
      name: "http.delivery",
      arguments: { observations: [{ url: "https://example.com/",
        status_code: 429, headers: {
          "cf-mitigated": "challenge", "cf-ray": "confidential-edge-ID",
          "retry-after": "20",
        } }] },
    });
    assert.equal(edgeSample.isError, undefined);
    assert.equal(edgeSample.structuredContent?.errors_observed, 1);
    assert.equal(edgeSample.structuredContent?.challenges_observed, 1);
    assert.equal(edgeSample.structuredContent?.hops?.[0]?.retry_after_seconds, 20);
    assert(!JSON.stringify(edgeSample).includes("confidential-edge-ID"));
    const availabilityTool = tools.find((tool) => tool.name === "http.availability");
    assert.equal(availabilityTool?.annotations?.readOnlyHint, true);
    assert.equal(availabilityTool?.outputSchema?.properties?.observations_count?.maximum, 48);
    const availabilitySample = await client.callTool({
      name: "http.availability",
      arguments: { observations: [
        { observed_at: "2026-11-20T09:00:00Z", status_code: 200 },
        { observed_at: "2026-11-20T09:01:00Z", status_code: 503 },
        { observed_at: "2026-11-20T09:02:00Z", status_code: 200 },
      ] },
    });
    assert.equal(availabilitySample.isError, undefined);
    assert.equal(availabilitySample.structuredContent?.observed_success_percent, 67);
    assert.equal(availabilitySample.structuredContent?.intermittent_non_success, true);
    assert.equal(availabilitySample.structuredContent?.observed_http_5xx, 1);
    assert.equal(availabilitySample.structuredContent?.coverage_limited, true);
    const historyTool = tools.find((tool) => tool.name === "availability.history");
    assert.equal(historyTool?.annotations?.readOnlyHint, false);
    assert.equal(historyTool?.annotations?.destructiveHint, true);
    const localHistory = await client.callTool({
      name: "availability.history",
      arguments: { action: "list", url: "https://example.com/" },
    });
    assert.equal(localHistory.isError, undefined);
    assert.equal(Array.isArray(localHistory.structuredContent?.records), true);

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

    const media = await client.callTool({
      name: "media.diagnostics",
      arguments: { htmlContent: '<html><body><main><img src="/img.jpg" loading="lazy">' +
        '<video src="/video.mp4"><track kind="captions" src="/captions.vtt"></video>' +
        '</main></body></html>' },
    });
    assert.equal(media.isError, undefined);
    assert.equal(media.structuredContent?.images_observed, 1);
    assert.equal(media.structuredContent?.videos_observed, 1);
    assert.equal(media.structuredContent?.images_without_explicit_alt, 1);
    assert.equal(media.structuredContent?.videos_without_caption_track, 0);
    assert.equal(media.structuredContent?.coverage_limited, true);
    assert.match(textContent(media), /Static media markup diagnostics/);
    assert(!JSON.stringify(media).includes("/video.mp4"));
    const mediaTool = tools.find((tool) => tool.name === "media.diagnostics");
    assert.equal(mediaTool?.annotations?.readOnlyHint, true);
    assert.equal(mediaTool?.annotations?.openWorldHint, false);
    const invalidMedia = await client.callTool({
      name: "media.diagnostics",
      arguments: { htmlContent: "é".repeat(90_001) },
    });
    assert.equal(invalidMedia.isError, true);

    const wcagTool = tools.find((tool) => tool.name === "browser.wcag");
    assert.ok(wcagTool, "browser keyboard/WCAG evidence must be discoverable");
    assert.equal(wcagTool?.annotations?.readOnlyHint, true);
    assert.equal(wcagTool?.annotations?.openWorldHint, false);
    assert.ok(JSON.stringify(wcagTool.inputSchema).includes("maxTabSteps"));
    // Fail before launching Chromium, so this contract also works on hosts
    // where the headless-shell executable cannot start.
    const invalidWcag = await client.callTool({
      name: "browser.wcag",
      arguments: { htmlContent: "é".repeat(90_001) },
    });
    assert.equal(invalidWcag.isError, true);

    const httpEvidence = await client.callTool({
      name: "http.directives",
      arguments: { resources: [{
        url: "https://example.test/files/report.pdf",
        status_code: 200, method: "HEAD",
        content_type: "application/pdf",
        x_robots_tag: ["googlebot: noindex"],
        link: ['<https://example.test/reports>; rel="canonical"'],
      }] },
    });
    assert.equal(httpEvidence.isError, undefined);
    assert.equal(httpEvidence.structuredContent?.scope, "caller_supplied_http_headers_only");
    assert.equal(httpEvidence.structuredContent?.non_html_resources, 1);
    assert.equal(httpEvidence.structuredContent?.googlebot_noindex_resources, 1);
    assert.equal(httpEvidence.structuredContent?.explicit_noindex_resources, 0);
    assert.equal(httpEvidence.structuredContent?.canonical_header_resources, 1);
    assert.equal(httpEvidence.structuredContent?.resources?.[0]?.canonical_state, "one");
    assert.equal(httpEvidence.structuredContent?.coverage_limited, true);
    assert.match(textContent(httpEvidence), /Sampled non-HTML HTTP directive review/);
    assert(!JSON.stringify(httpEvidence).includes("/files/report.pdf"));
    const securityEvidence = await client.callTool({
      name: "http.security",
      arguments: { pages: [{
        url: "https://example.test/private/security",
        status_code: 200,
        strict_transport_security: ["max-age=31536000; includeSubDomains"],
        content_security_policy: ["default-src 'self'; frame-ancestors 'none'"],
        referrer_policy: "strict-origin-when-cross-origin",
        x_content_type_options: "nosniff",
        htmlContent: '<html><body><script src="http://cdn.test/app.js"></script>' +
          '<img src="http://cdn.test/photo.jpg">' +
          '<form action="http://example.test/submit"></form></body></html>',
      }] },
    });
    assert.equal(securityEvidence.isError, undefined);
    assert.equal(securityEvidence.structuredContent?.scope, "caller_supplied_https_security_evidence_only");
    assert.equal(securityEvidence.structuredContent?.pages_sampled, 1);
    assert.equal(securityEvidence.structuredContent?.mixed_blockable_declarations, 1);
    assert.equal(securityEvidence.structuredContent?.mixed_upgradable_declarations, 1);
    assert.equal(securityEvidence.structuredContent?.insecure_form_actions, 1);
    assert.equal(securityEvidence.structuredContent?.pages?.[0]?.hsts_state, "enabled");
    assert.equal(securityEvidence.structuredContent?.coverage_limited, true);
    assert.match(textContent(securityEvidence), /Sampled HTTPS and HTTP security signals/);
    assert(!JSON.stringify(securityEvidence).includes("/private/security"));
    assert(!JSON.stringify(securityEvidence).includes("/submit"));
    const securityTool = tools.find((tool) => tool.name === "http.security");
    assert.equal(securityTool?.annotations?.readOnlyHint, true);
    assert.equal(securityTool?.annotations?.openWorldHint, false);
    const unsafeSecurity = await client.callTool({
      name: "http.security",
      arguments: { pages: [{ url: "https://example.test/?token=FAKE_SECRET", status_code: 200 }] },
    });
    assert.equal(unsafeSecurity.isError, true);
    assert(!JSON.stringify(unsafeSecurity).includes("FAKE_SECRET"));
    const variantTool = tools.find((tool) => tool.name === "http.variants");
    assert.ok(variantTool, "P1-14 local URL variant tool must be discoverable");
    assert.equal(variantTool?.annotations?.readOnlyHint, true);
    assert.equal(variantTool?.annotations?.openWorldHint, false);
    const variantReference = "https://example.test/Products/Widget";
    const variants = await client.callTool({
      name: "http.variants",
      arguments: {
        reference_url: variantReference,
        observations: [
          { url: variantReference, status_code: 200, method: "GET",
            content_sha256: "a".repeat(64), canonicals: [variantReference] },
          { url: "http://example.test/Products/Widget", status_code: 301,
            location: variantReference },
          { url: variantReference + "?session=FAKE_QUERY_SECRET", status_code: 200,
            method: "GET", content_sha256: "a".repeat(64),
            canonicals: [variantReference] },
        ],
      },
    });
    assert.equal(variants.isError, undefined);
    assert.equal(variants.structuredContent?.scope, "caller_supplied_url_variant_evidence_only");
    assert.equal(variants.structuredContent?.pages_sampled, 3);
    assert.equal(variants.structuredContent?.scheme_variants, 1);
    assert.equal(variants.structuredContent?.query_variants, 1);
    assert.equal(variants.structuredContent?.redirects_to_reference, 1);
    assert.equal(variants.structuredContent?.matching_content_variants, 1);
    assert.equal(variants.structuredContent?.coverage_limited, true);
    assert.match(textContent(variants), /Supplied URL variant comparison/);
    assert(!JSON.stringify(variants).includes("FAKE_QUERY_SECRET"));
    assert(!JSON.stringify(variants).includes("/Products/Widget"));
    const rejectedVariant = await client.callTool({
      name: "http.variants",
      arguments: {
        reference_url: variantReference,
        observations: [{
          url: variantReference + "#FAKE_FRAGMENT_SECRET", status_code: 200,
        }],
      },
    });
    assert.equal(rejectedVariant.isError, true);
    assert(!JSON.stringify(rejectedVariant).includes("FAKE_FRAGMENT_SECRET"));
    const httpTool = tools.find((tool) => tool.name === "http.directives");
    assert.equal(httpTool?.annotations?.readOnlyHint, true);
    assert.equal(httpTool?.annotations?.openWorldHint, false);
    const unsafeHttp = await client.callTool({
      name: "http.directives",
      arguments: { resources: [{
        url: "https://example.test/report.pdf?token=FAKE_SECRET",
        status_code: 200, content_type: "application/pdf",
      }] },
    });
    assert.equal(unsafeHttp.isError, true);
    assert(!JSON.stringify(unsafeHttp).includes("FAKE_SECRET"));

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

    const metadataPages = [
      { url: "https://example.test/article",
        htmlContent: '<html><head><title>Primary title</title><title>Second title</title>'
          + '<meta name="description" content="Sample summary">'
          + '<meta property="og:title" content="Social title">'
          + '<link rel="canonical" href="/article"></head></html>' },
      { url: "https://example.test/other",
        htmlContent: '<html><head><title>Other title</title>'
          + '<link rel="canonical" href="https://example.test/other"></head></html>' },
    ];
    const metadata = await client.callTool({
      name: "content.metadata",
      arguments: { pages: metadataPages },
    });
    assert.equal(metadata.isError, undefined);
    assert.equal(metadata.structuredContent?.pages_sampled, 2);
    assert.equal(metadata.structuredContent?.conflicting_declaration_fields, 1);
    assert(metadata.structuredContent?.findings.some((f) => f.code === "conflicting_declaration"));
    assert.equal(metadata.structuredContent?.coverage_limited, true);
    assert.match(textContent(metadata), /Sampled metadata consistency review/);
    assert.doesNotMatch(JSON.stringify(metadata), /Primary title|Second title|Sample summary/);

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

    const redactedBlockedLink = await client.callTool({
      name: "links.broken",
      arguments: {
        htmlContent: '<a href="https://FAKE_USER:FAKE_PASSWORD@example.com/private?token=FAKE_TOKEN">Blocked</a>',
      },
    });
    assert.equal(redactedBlockedLink.isError, undefined);
    assert.equal(redactedBlockedLink.structuredContent?.links?.[0]?.status, "blocked");
    assert.equal(redactedBlockedLink.structuredContent?.links?.[0]?.url, "https://example.com/private");
    assert.doesNotMatch(JSON.stringify(redactedBlockedLink), /FAKE_USER|FAKE_PASSWORD|FAKE_TOKEN/);

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
