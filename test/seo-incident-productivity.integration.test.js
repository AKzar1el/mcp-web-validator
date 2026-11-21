/**
 * Synthetic SEO incident workflow that exercises complementary real MCP tools.
 * Verifies actionability, evidence boundaries, privacy and sample-only verdicts;
 * it does not contact, index or benchmark a production website.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "https://example.com";
const hidden = "PRIVATE-INCIDENT-EVIDENCE";
const reportText = (r) => (r.content ?? [])
  .filter(c => c.type === "text").map(c => c.text).join("\n");
const html = (noindex) => `<!doctype html><html><head><title>Audited page</title>${noindex ?
  '<meta name="robots" content="noindex">' : ''}</head><body><main><h1>Audited</h1><p>Useful article body</p></main></body></html>`;

test("SEO incident productivity: ten offline tools distinguish delivery, crawl, index and field evidence", { timeout: 90_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe",
  });
  const client = new Client({ name: "incident-triage-benchmark", version: "1.0.0" });
  await client.connect(transport);
  const latencies = [];
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 39);
    const call = async (name, args, verify) => {
      const started = performance.now();
      const r = await client.callTool({ name, arguments: args });
      latencies.push({ tool: name, duration_ms: Math.round(performance.now()-started) });
      assert.equal(r.isError, undefined, name + " unexpectedly failed");
      assert.ok(r.structuredContent, name + " lacks structured result");
      const narrative = reportText(r);
      assert.match(narrative, /\*\*Next step:\*\*/iu, name + " lacks actionable next step");
      assert(!JSON.stringify(r).includes(hidden), name + " leaked private source content");
      assert(narrative.length < 7_000, name + " exceeded concise report budget");
      verify(r.structuredContent);
    };
    await call("audit.production_change", {
      page_url: origin + "/private-incident-" + hidden,
      baseline: { observed_at: "2026-11-10T09:00:00Z", http_status: 200, html: html(false) },
      current: { observed_at: "2026-11-12T09:00:00Z", http_status: 200, html: html(true) },
    }, d => {
      assert.equal(d.noindex_added, true);
      assert.equal(d.status, "comparable_snapshot");
      assert(d.findings.some(f => f.code === "noindex_added"));
    });
    await call("http.delivery", {
      observations: [{ url: origin + "/", status_code: 403,
        headers: { "cf-mitigated": "challenge", "cf-ray": hidden } }],
    }, d => {
      assert.equal(d.errors_observed, 1);
      assert.equal(d.challenges_observed, 1);
    });
    await call("http.availability", {
      observations: [
        {observed_at: "2026-11-11T00:00:00Z",status_code: 200},
        {observed_at: "2026-11-11T00:01:00Z",status_code: 503},
        {observed_at: "2026-11-11T00:02:00Z",status_code: 200},
      ],
    }, d => {
      assert.equal(d.observed_http_5xx, 1);
      assert.equal(d.observed_success_percent, 67);
      assert.equal(d.intermittent_non_success, true);
    });
    await call("crawler.logs", {
      site_origin: origin, important_urls: [origin + "/"],
      cutover_at: "2026-11-12T00:00:00Z", format: "structured",
      observations: [
        {timestamp: "2026-11-11T00:00:00Z",method: "GET",path: "/",status: 200,user_agent: "Googlebot/2.1",client_ip: "203.0.113.7"},
        {timestamp: "2026-11-11T00:01:00Z",method: "HEAD",path: "/",status: 200},
        {timestamp: "2026-11-12T00:01:00Z",method: "GET",path: "/",status: 403,user_agent: "Googlebot/2.1",client_ip: "203.0.113.7"},
        {timestamp: "2026-11-12T00:02:00Z",method: "GET",path: "/",status: 429,user_agent: "Googlebot/2.1"},
      ],
    }, d => {
      assert.equal(d.after.block_401_403, 1);
      assert.equal(d.after.rate_limited_429, 1);
      assert.equal(d.googlebot_ip_evidence.status, "not_requested");
      assert.equal(d.crawler_identities_verified, false);
    });
    await call("browser.resource_failures", {
      mode: "analyze_observations",navigation_completed: true,
      observations: [
        {resource_type: "script",origin: "same_origin",outcome: "http",status_code: 404},
        {resource_type: "fetch",origin: "same_origin",outcome: "transport_failed",failure_reason: "timeout"},
        {resource_type: "stylesheet",origin: "third_party",outcome: "tool_blocked"},
      ],
    }, d => {
      assert.equal(d.critical_resource_failures, 1);
      assert.equal(d.tool_blocked_requests, 1);
      assert.equal(d.http_4xx, 1);
    });
    await call("crawler.access", {
      site_url: origin + "/",
      robots_txt: "User-agent: Googlebot\nDisallow: /private",
      pages: [{url: origin + "/private/incident",status_code: 200,
        html: '<meta name="googlebot" content="noindex">',x_robots_tag: []}],
      profiles: ["googlebot-smartphone","bingbot"],
    }, d => {
      assert.equal(d.crawler_disallowed_rows, 1);
      assert.equal(d.noindex_declared_rows, 1);
    });
    await call("http.redirect_chain", {
      source_url: origin + "/",
      expected_destination: origin + "/landing",
      observations: [
        {url: origin + "/",status_code: 301,location: "/landing"},
        {url: origin + "/landing",status_code: 200,
          html: '<html><head><meta name="robots" content="noindex"></head></html>',
          x_robots_tag: []},
      ],
    }, d => {
      assert.equal(d.chain_complete, true);
      assert.equal(d.nonindexable_destination, true);
      assert.equal(d.expected_destination_match, true);
    });
    await call("site.sitemaps", {
      site_url: origin + "/",
      documents: [{sitemap_url: origin + "/sitemap.xml",
        content: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+
          origin+'/private/incident</loc></url></urlset>'}],
      page_observations: [{url: origin + "/private/incident", status_code: 404, noindex: true}],
    }, d => {
      assert.equal(d.known_indexability_conflicts, 1);
      assert.equal(d.noindex_conflicts, 1);
    });
    const cruxJson = JSON.stringify({
      record: {
        key: { origin, formFactor: "PHONE" },
        collectionPeriod: {
          firstDate: {year: 2026,month: 10,day: 1},
          lastDate: {year: 2026,month: 10,day: 28},
        },
        metrics: {
          largest_contentful_paint: {percentiles: {p75: 4700}},
          interaction_to_next_paint: {percentiles: {p75: 300}},
          cumulative_layout_shift: {percentiles: {p75: "0.08"}},
          first_contentful_paint: {percentiles: {p75: 2000}},
          experimental_time_to_first_byte: {percentiles: {p75: 700}},
        },
      },
      secret_not_for_output: hidden,
    });
    await call("performance.crux_field", {
      source_mode: "supplied_record",mode: "daily",granularity: "origin",
      target: origin,form_factor: "PHONE",record_json: cruxJson,
    }, d => {
      assert.equal(d.source, "caller_supplied");
      assert.equal(d.core_web_vitals, "poor");
      assert.equal(d.p75.largest_contentful_paint, 4700);
    });
    await call("seo.metadata",{
      htmlContent: "<!doctype html><html><head></head><body><main><h1>Article</h1></main></body></html>",
    }, d => {
      assert(d.totalIssues > 0);
    });
    assert.equal(latencies.length,10);
    // Avoid flaky hard latency assertions: emit a bounded, reproducible local benchmark.
    const total=latencies.reduce((n,r)=>n+r.duration_ms,0);
    console.log("SEO_WORKFLOW: 10/10 real MCP scenarios; total_tool_ms=" + total +
      "; slowest=" + latencies.slice().sort((a,b)=>b.duration_ms-a.duration_ms)[0].tool);
  }finally{ await client.close(); }
});
