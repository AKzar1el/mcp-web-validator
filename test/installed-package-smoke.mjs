import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
let phase = "pack";

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
  phase = "dependency_install";
  await execFileAsync(
    npm,
    [
      "install", "--prefix", consumer, "--omit=dev",
      "--ignore-scripts", "--no-audit", "--no-fund",
      process.env.MCP_WEB_VALIDATOR_SMOKE_OFFLINE === "1" ? "--offline" : "--prefer-offline",
      path.join(scratch, packages[0].filename),
    ],
    // Windows Defender/slow storage can make a cold clean-room npm install
    // reach the old 4-minute limit even after npm reports cache hits. The
    // larger allowance applies only to the explicitly opted-in offline smoke.
    { cwd: scratch, shell: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe") : false, timeout: process.platform === "win32" ? (process.env.MCP_WEB_VALIDATOR_SMOKE_OFFLINE === "1" ? 480_000 : 240_000) : 120_000, maxBuffer: 2_000_000 },
  );

  const installedEntry = path.join(
    consumer, "node_modules", "mcp-web-validator", "dist", "index.js",
  );
  assert.ok((await stat(installedEntry)).isFile());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [installedEntry],
    stderr: "pipe",
    // Never read or modify the user's actual local audit history during a
    // distributable smoke: keep this check in the existing isolated scratch.
    env: { ...process.env, MCP_WEB_VALIDATOR_WORKSPACE_ROOT: scratch },
  });
  client = new Client({ name: "installed-package-smoke", version: "1.0.0" });
  phase = "mcp_initialize";
  await client.connect(transport);

  phase = "mcp_tools_list";
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "audit.history", "audit.monitor", "audit.trends", "availability.history", "browser.wcag", "content.competitors", "content.duplicates", "content.metadata", "content.provenance", "content.quality", "crawler.access", "css.local", "html.local", "html.url", "http.availability", "http.delivery", "http.directives", "http.redirect_chain", "http.security", "http.variants", "links.broken", "media.diagnostics", "product.claims",
      "report.validation", "schema.markup", "schema.supported", "screenshot.capture", "seo.metadata", "site.hreflang", "site.links", "site.sitemaps",
    ],
  );

  phase = "v05_sitemap_inventory";
  const sitemap = await client.callTool({
    name: "site.sitemaps",
    arguments: {
      site_url: "https://example.com/",
      documents: [{
        sitemap_url: "https://example.com/sitemap.xml",
        content: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + '<url><loc>https://example.com/audit-target-v05</loc></url></urlset>',
      }],
      page_observations: [{
        url: "https://example.com/audit-target-v05",
        status_code: 404, noindex: true,
      }],
    },
  });
  assert.notEqual(sitemap.isError, true);
  assert.equal(sitemap.structuredContent?.distinct_page_urls, 1);
  assert.equal(sitemap.structuredContent?.known_indexability_conflicts, 1);
  assert(!JSON.stringify(sitemap).includes("audit-target-v05"));

  phase = "v04_redirect_canonical";
  const chain = await client.callTool({
    name: "http.redirect_chain",
    arguments: {
      source_url: "https://example.com/",
      expected_destination: "https://example.com/redirected",
      observations: [
        { url: "https://example.com/", status_code: 301, location: "/redirected" },
        { url: "https://example.com/redirected", status_code: 200,
          html: "<html><head><meta name='googlebot' content='noindex'></head></html>",
          x_robots_tag: [] },
      ],
    },
  });
  assert.notEqual(chain.isError, true);
  assert.equal(chain.structuredContent?.chain_complete, true);
  assert.equal(chain.structuredContent?.expected_destination_match, true);
  assert.equal(chain.structuredContent?.nonindexable_destination, true);
  assert(!JSON.stringify(chain).includes("/redirected"));

  phase = "v03_crawler_access";
  const crawler = await client.callTool({
    name: "crawler.access",
    arguments: {
      site_url: "https://example.com/",
      robots_txt: "User-agent: Googlebot\nDisallow: /private",
      pages: [{
        url: "https://example.com/private/secret",
        html: "<meta name='googlebot' content='noindex'>",
        x_robots_tag: [],
      }],
      profiles: ["googlebot-smartphone", "bingbot"],
    },
  });
  assert.notEqual(crawler.isError, true);
  assert.equal(crawler.structuredContent?.rows_checked, 2);
  assert.equal(crawler.structuredContent?.crawler_disallowed_rows, 1);
  assert(!JSON.stringify(crawler).includes("/private/secret"));

  phase = "v01_delivery";
  const delivery = await client.callTool({
    name: "http.delivery",
    arguments: { observations: [{
      url: "https://example.com/", status_code: 403,
      headers: { "cf-mitigated": "challenge", "cf-ray": "private-package-test-id" },
    }] },
  });
  assert.notEqual(delivery.isError, true);
  assert.equal(delivery.structuredContent?.hops_observed, 1);
  assert.equal(delivery.structuredContent?.errors_observed, 1);
  assert.equal(delivery.structuredContent?.challenges_observed, 1);
  assert(!JSON.stringify(delivery).includes("private-package-test-id"));
  phase = "v02_availability";
  const availability = await client.callTool({
    name: "http.availability",
    arguments: { observations: [
      { observed_at: "2026-11-20T09:00:00Z", status_code: 200 },
      { observed_at: "2026-11-20T09:01:00Z", status_code: 503 },
      { observed_at: "2026-11-20T09:02:00Z", status_code: 200 },
    ] },
  });
  assert.notEqual(availability.isError, true);
  assert.equal(availability.structuredContent?.observed_success_percent, 67);
  assert.equal(availability.structuredContent?.intermittent_non_success, true);
  const availabilityList = await client.callTool({
    name: "availability.history",
    arguments: { action: "list", url: "https://example.com/" },
  });
  assert.notEqual(availabilityList.isError, true);
  assert.equal(availabilityList.structuredContent?.count, 0);
  await assert.rejects(stat(path.join(scratch, ".mcp-validator", "availability-history.json")),
    { code: "ENOENT" });

  phase = "history_trend";
  const historySnapshot = (count) => JSON.stringify({
    site_url: "https://example.test/", discovery: "sitemap",
    discovery_fingerprint: "a".repeat(64),
    pages_discovered: 1, pages_selected: 1, pages_audited: 1,
    pages_partial: 0, pages_failed: 0, pages_skipped_robots: 0,
    truncated: false, score_coverage_percent: 100,
    pages: [{
      url: "https://example.test/", fetched_url: "https://example.test/",
      status: count ? "needs_attention" : "passed",
      page_fetched: true, html_validation_status: "completed",
      html_errors: 0, html_warnings: 0, seo_errors: count,
      seo_warnings: 0, schema_errors: 0, schema_warnings: 0,
      notes: 0, health_score: 100 - count * 10, top_findings: [],
    }],
    issue_groups: [], issue_groups_truncated: false,
  });
  const storedHistoryIds = [];
  for (const count of [0, 2]) {
    const savedHistory = await client.callTool({
      name: "audit.history", arguments: { action: "save", snapshotJson: historySnapshot(count) },
    });
    assert.notEqual(savedHistory.isError, true);
    storedHistoryIds.push(savedHistory.structuredContent.items[0].id);
  }
  const historyFile = path.join(scratch, ".mcp-validator", "audit-history.json");
  const historyBytesBefore = await readFile(historyFile);
  const historyTrend = await client.callTool({
    name: "audit.trends", arguments: { ids: storedHistoryIds },
  });
  assert.notEqual(historyTrend.isError, true);
  assert.equal(historyTrend.structuredContent?.scope, "historical_compact_audit_versions_only");
  assert.equal(historyTrend.structuredContent?.source, "local_saved_ids");
  assert.equal(historyTrend.structuredContent?.versions_compared, 2);
  assert.equal(historyTrend.structuredContent?.total_regressed_page_transitions, 1);
  assert.equal(historyTrend.structuredContent?.complete_stable_cohort_pages, 1);
  assert.equal(historyTrend.structuredContent?.coverage_limited, true);
  assert.ok(!JSON.stringify(historyTrend).includes("https://example.test/"));
  assert.ok(!JSON.stringify(historyTrend).includes(storedHistoryIds[0]));
  assert.deepEqual(await readFile(historyFile), historyBytesBefore);

  phase = "monitor_dry_run";
  const monitorPreview = await client.callTool({
    name: "audit.monitor",
    arguments: { ids: storedHistoryIds, dry_run: true },
  });
  assert.notEqual(monitorPreview.isError, true);
  assert.equal(monitorPreview.structuredContent?.scope,
    "manual_sampled_regression_alert_preview_only");
  assert.equal(monitorPreview.structuredContent?.source, "local_saved_ids");
  assert.equal(monitorPreview.structuredContent?.candidate_count, 2);
  assert.equal(monitorPreview.structuredContent?.dry_run, true);
  assert.equal(monitorPreview.structuredContent?.notifications_sent, 0);
  assert.equal(monitorPreview.structuredContent?.scheduler_enabled, false);
  assert.equal(monitorPreview.structuredContent?.delivery_enabled, false);
  assert.equal(monitorPreview.structuredContent?.external_integrations_used, false);
  assert.ok(!JSON.stringify(monitorPreview).includes(storedHistoryIds[0]));
  assert.ok(!JSON.stringify(monitorPreview).includes("https://example.test/"));
  assert.deepEqual(await readFile(historyFile), historyBytesBefore);

  // No external validator or third-party website is contacted by this tool.
  phase = "seo_metadata";
  const localAudit = await client.callTool({
    name: "seo.metadata",
    arguments: {
      htmlContent: "<!doctype html><html><head><title>Installed package smoke</title></head><body><h1>Smoke</h1></body></html>",
    },
  });
  assert.notEqual(localAudit.isError, true);
  assert.ok(Array.isArray(localAudit.structuredContent?.issues));

  phase = "media_diagnostics";
  const media = await client.callTool({
    name: "media.diagnostics",
    arguments: { htmlContent: '<html><body><img src="photo.jpg" loading="lazy">' +
      '<video><source src="movie.mp4"><track kind="captions" src="captions.vtt"></video>' +
      '</body></html>' },
  });
  assert.notEqual(media.isError, true);
  assert.equal(media.structuredContent?.images_observed, 1);
  assert.equal(media.structuredContent?.videos_observed, 1);
  assert.equal(media.structuredContent?.images_without_explicit_alt, 1);
  assert.equal(media.structuredContent?.videos_without_caption_track, 0);
  assert.equal(media.structuredContent?.coverage_limited, true);
  assert.ok(!JSON.stringify(media).includes("movie.mp4"));

  phase = "http_directives";
  const responseHeaders = await client.callTool({
    name: "http.directives",
    arguments: { resources: [{
      url: "https://example.test/documents/report.pdf",
      status_code: 200, method: "HEAD", content_type: "application/pdf",
      x_robots_tag: ["noindex, nofollow"],
      link: ['<https://example.test/report>; rel="canonical"'],
    }] },
  });
  assert.notEqual(responseHeaders.isError, true);
  assert.equal(responseHeaders.structuredContent?.non_html_resources, 1);
  assert.equal(responseHeaders.structuredContent?.googlebot_noindex_resources, 1);
  assert.equal(responseHeaders.structuredContent?.resources?.[0]?.canonical_state, "one");
  assert.equal(responseHeaders.structuredContent?.coverage_limited, true);
  assert.ok(!JSON.stringify(responseHeaders).includes("/documents/report.pdf"));

  phase = "https_security";
  const httpsEvidence = await client.callTool({
    name: "http.security",
    arguments: { pages: [{
      url: "https://example.test/private/headers", status_code: 200,
      strict_transport_security: ["max-age=31536000"],
      content_security_policy: ["default-src 'self'"],
      x_content_type_options: "nosniff",
      htmlContent: '<img src="http://cdn.test/image.jpg">' +
        '<script src="http://cdn.test/app.js"></script>',
    }] },
  });
  assert.notEqual(httpsEvidence.isError, true);
  assert.equal(httpsEvidence.structuredContent?.pages_sampled, 1);
  assert.equal(httpsEvidence.structuredContent?.mixed_blockable_declarations, 1);
  assert.equal(httpsEvidence.structuredContent?.mixed_upgradable_declarations, 1);
  assert.equal(httpsEvidence.structuredContent?.pages?.[0]?.hsts_state, "enabled");
  assert.equal(httpsEvidence.structuredContent?.coverage_limited, true);
  assert.ok(!JSON.stringify(httpsEvidence).includes("/private/headers"));

  phase = "url_variants";
  const referenceUrl = "https://example.test/Products/Widget";
  const urlVariants = await client.callTool({
    name: "http.variants",
    arguments: {
      reference_url: referenceUrl,
      observations: [
        { url: referenceUrl, status_code: 200,
          content_sha256: "a".repeat(64), canonicals: [referenceUrl] },
        { url: "http://example.test/Products/Widget", status_code: 308,
          location: referenceUrl },
        { url: referenceUrl + "?token=FAKE_PRIVATE_QUERY", status_code: 200,
          content_sha256: "a".repeat(64), canonicals: [referenceUrl] },
      ],
    },
  });
  assert.notEqual(urlVariants.isError, true);
  assert.equal(urlVariants.structuredContent?.pages_sampled, 3);
  assert.equal(urlVariants.structuredContent?.redirects_to_reference, 1);
  assert.equal(urlVariants.structuredContent?.query_variants, 1);
  assert.equal(urlVariants.structuredContent?.matching_content_variants, 1);
  assert.equal(urlVariants.structuredContent?.coverage_limited, true);
  assert.ok(!JSON.stringify(urlVariants).includes("FAKE_PRIVATE_QUERY"));

  const sampleWords = Array.from({ length: 120 }, (_, i) => `installedtestword${i}`).join(" ");
  phase = "content_duplicates";
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

  const source = "https://doi.org/10.1000/install-smoke";
  phase = "content_provenance";
  const provenance = await client.callTool({
    name: "content.provenance",
    arguments: {
      pages: [{
        url: "https://example.test/report",
        htmlContent: '<html><main><a rel=cite data-citation-id=source_2026 href="' + source
          + '">Citation</a></main></html>',
      }],
      evidence: { sources: [{ id: "source_2026", url: source }] },
    },
  });
  assert.notEqual(provenance.isError, true);
  assert.equal(provenance.structuredContent?.citations_observed, 1);
  assert.equal(provenance.structuredContent?.consistent_declarations, 1);
  assert.equal(provenance.structuredContent?.conflicting_declarations, 0);

  phase = "content_metadata";
  const metadata = await client.callTool({
    name: "content.metadata",
    arguments: { pages: [
      { url: "https://example.test/article",
        htmlContent: '<html><head><title>Example</title>'
          + '<link rel="canonical" href="/article">'
          + '<meta property="og:url" content="https://example.test/article">'
          + '</head></html>' },
    ] },
  });
  assert.notEqual(metadata.isError, true);
  assert.equal(metadata.structuredContent?.pages_sampled, 1);
  assert.equal(metadata.structuredContent?.conflicting_declaration_fields, 0);
  assert.equal(metadata.structuredContent?.cross_field_review_leads, 0);
  assert.equal(metadata.structuredContent?.coverage_limited, true);

  phase = "schema_supported";
  const supported = await client.callTool({
    name: "schema.supported",
    arguments: {
      htmlContent: '<html><head><script type="application/ld+json">'
        + '{"@context":"https://schema.org","@type":"Product","name":"Chair",'
        + '"offers":{"@type":"Offer","price":0,"priceCurrency":"EUR"}}'
        + '</script></head><body><main>Chair</main></body></html>',
    },
  });
  assert.notEqual(supported.isError, true);
  assert.equal(supported.structuredContent?.supported_nodes, 1);
  assert.equal(supported.structuredContent?.warnings, 0);
  assert.equal(supported.structuredContent?.errors, 0);
  assert.equal(supported.structuredContent?.coverage_limited, true);

  phase = "site_links";
  const contextual = await client.callTool({
    name: "site.links",
    arguments: { pages: [
      { url: "https://example.test/guides",
        htmlContent: '<html><head><title>Guides</title></head><main><h1>Guides</h1>'
          + '<a href="/chairs">Office chairs</a></main></html>' },
      { url: "https://example.test/chairs",
        htmlContent: '<html><head><title>Office chairs</title></head><main><h1>Office chairs</h1></main></html>' },
    ] },
  });
  assert.notEqual(contextual.isError, true);
  assert.equal(contextual.structuredContent?.internal_links_observed, 1);
  assert.equal(contextual.structuredContent?.linked_sample_targets, 1);
  assert.equal(contextual.structuredContent?.missing_anchor_labels, 0);
  assert.equal(contextual.structuredContent?.coverage_limited, true);

  phase = "content_competitors";
  const intent = await client.callTool({
    name: "content.competitors",
    arguments: {
      primary: { url: "https://example.test/guide",
        htmlContent: '<html><head><title>Posture guide</title></head><main><h1>Posture</h1></main></html>' },
      competitors: [{ url: "https://competitor.test/chairs",
        htmlContent: '<html><head><title>Ergonomic chairs</title>'
          + '<script type="application/ld+json">{"@type":"Product"}</script></head>'
          + '<main><h1>Chairs</h1></main></html>' }],
      expected_intent: "commercial",
    },
  });
  assert.notEqual(intent.isError, true);
  assert.equal(intent.structuredContent?.competitors_eligible, 1);
  assert.equal(intent.structuredContent?.competitors_with_intent_signals, 1);
  assert.equal(intent.structuredContent?.coverage_limited, true);

  phase = "product_claims";
  const advertised = await client.callTool({
    name: "product.claims",
    arguments: {
      htmlContent: '<html><body><main><section><h2>Local MCP tools</h2>'
        + '<code>screenshot.capture</code><code>missing_fake_tool</code></section>'
        + '<p>The local MCP provides responsive screenshots.</p></main></body></html>',
    },
  });
  assert.notEqual(advertised.isError, true);
  assert.equal(advertised.structuredContent?.catalog_available, true);
  assert.equal(advertised.structuredContent?.contradicted_claims, 1);
  assert.ok(advertised.structuredContent?.findings?.some((f) =>
    f.code === "product.tool_missing" && f.claim === "missing_fake_tool"));

  phase = "content_quality";
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
  phase = "site_hreflang";
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
    phase = "screenshot_capture";
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
    phase = "browser_wcag";
    const wcag = await client.callTool({
      name: "browser.wcag",
      arguments: {
        htmlContent: '<!doctype html><html><head><title>Browser keyboard fixture</title></head>'
          + '<body><button aria-label="Labeled control">Open</button>'
          + '<details><summary>Show details</summary><p>Additional information</p></details></body></html>',
        maxTabSteps: 4,
      },
    });
    assert.notEqual(wcag.isError, true, "Installed MCP browser WCAG tool must launch safely");
    assert.equal(wcag.structuredContent?.browser_executed, true);
    assert.equal(wcag.structuredContent?.scripts_disabled, true);
    assert.equal(wcag.structuredContent?.coverage_limited, true);
    assert.ok(wcag.structuredContent?.unique_tab_targets >= 1);
    assert.equal(wcag.structuredContent?.native_summaries_tested, 1);
    assert.equal(wcag.structuredContent?.native_summaries_toggled, 1);
    console.log("Installed npm tarball MCP handshake, offline audits, sandboxed screenshot and real keyboard/browser WCAG smoke: PASS");
  }
} catch (error) {
  // Do not include untrusted HTML, source URLs or tool input in smoke logs.
  console.error(`Installed package smoke failed at phase: ${phase}`);
  throw error;
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
