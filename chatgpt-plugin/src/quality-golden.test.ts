import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";

const BASE = "https://example.com/";
const ABOUT = "https://example.com/about";
const OLD = "https://example.com/old";
const NEXT = "https://example.com/next";
const at1 = "2026-11-20T10:00:00Z";
const at2 = "2026-11-20T10:05:00Z";
const html = (title: string, canonical: string) =>
  '<html lang="en"><head><title>' + title + '</title><link rel="canonical" href="' +
  canonical + '"></head><body><h1>' + title + '</h1></body></html>';
const sitemap = (date: string) =>
  '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url>' +
  "<loc>https://example.com/</loc><lastmod>" + date + "</lastmod></url></urlset>";

const truth = [
  {
    label: "JSON-LD syntax", tool: "validate_schema_markup", field: "total_issues",
    negative: { html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>' },
    positive: { html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":</script>' },
  },
  {
    label: "Cloudflare challenge declaration", tool: "diagnose_http_delivery", field: "challenges_observed",
    negative: { observations: [{ url: BASE, status_code: 200, headers: {} }] },
    positive: { observations: [{ url: BASE, status_code: 403, headers: { "cf-mitigated": "challenge" } }] },
  },
  {
    label: "HTTP 429 observed", tool: "review_availability_history", field: "observed_rate_limits",
    negative: { observations: [{ observed_at: at1, status_code: 200 }, { observed_at: at2, status_code: 200 }] },
    positive: { observations: [{ observed_at: at1, status_code: 200 }, { observed_at: at2, status_code: 429 }] },
  },
  {
    label: "declared redirect loop", tool: "review_redirect_canonical_chains", field: "loop_detected",
    negative: { source_url: OLD, observations: [{ url: OLD, status_code: 301, location: ABOUT }, { url: ABOUT, status_code: 200 }] },
    positive: { source_url: OLD, observations: [{ url: OLD, status_code: 301, location: NEXT }, { url: NEXT, status_code: 301, location: OLD }] },
  },
  {
    label: "explicit non-HTML noindex", tool: "review_http_directives", field: "explicit_noindex_resources",
    negative: { resources: [{ url: BASE + "guide.pdf", status_code: 200, content_type: "application/pdf" }] },
    positive: { resources: [{ url: BASE + "guide.pdf", status_code: 200, content_type: "application/pdf", x_robots_tag: ["noindex"] }] },
  },
  {
    label: "insecure form action declaration", tool: "review_https_security", field: "insecure_form_actions",
    negative: { pages: [{ url: BASE, status_code: 200, htmlContent: '<form action="/submit"><button>Submit</button></form>' }] },
    positive: { pages: [{ url: BASE, status_code: 200, htmlContent: '<form action="http://example.com/submit"><button>Submit</button></form>' }] },
  },
  {
    label: "robots.txt disallow", tool: "review_crawler_access", field: "crawler_disallowed_rows",
    negative: { site_url: BASE, robots_txt: "User-agent: *\nDisallow: /private\n", robots_status_code: 200,
      pages: [{ url: ABOUT, status_code: 200, html: "<title>Public</title>" }], profiles: ["googlebot-smartphone"] },
    positive: { site_url: BASE, robots_txt: "User-agent: *\nDisallow: /private\n", robots_status_code: 200,
      pages: [{ url: BASE + "private", status_code: 200, html: "<title>Private</title>" }], profiles: ["googlebot-smartphone"] },
  },
  {
    label: "invalid sitemap lastmod", tool: "review_sitemap_inventory", field: "lastmod_invalid_count",
    negative: { site_url: BASE, documents: [{ sitemap_url: BASE + "sitemap.xml", content: sitemap("2025-01-01") }] },
    positive: { site_url: BASE, documents: [{ sitemap_url: BASE + "sitemap.xml", content: sitemap("not-a-date") }] },
  },
  {
    label: "duplicate title with distinct canonicals", tool: "review_metadata_consistency", field: "duplicate_title_groups",
    negative: { pages: [{ url: BASE, htmlContent: html("Home Page", BASE) },
      { url: ABOUT, htmlContent: html("About Page", ABOUT) }] },
    positive: { pages: [{ url: BASE, htmlContent: html("Same Title", BASE) },
      { url: ABOUT, htmlContent: html("Same Title", ABOUT) }] },
  },
  {
    label: "observed query URL variant", tool: "review_url_variants", field: "query_variants",
    negative: { reference_url: BASE, observations: [{ url: BASE, status_code: 200 }] },
    positive: { reference_url: BASE, observations: [{ url: BASE, status_code: 200 },
      { url: BASE + "?campaign=1", status_code: 200 }] },
  },
] as const;

const context = { props: {} } as ExecutionContext;
async function callTool(name: string, args: Record<string, unknown>) {
  const env = {
    MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SITE_AUDIT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const response = await worker.fetch(new Request("https://web-validator-mcp.digestseo.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 477, method: "tools/call",
      params: { name, arguments: args } }),
  }), env, context);
  expect(response.status).toBe(200);
  const data = (await response.text()).split(/\r?\n/).find((line) => line.startsWith("data: "));
  expect(data).toBeDefined();
  const packet = JSON.parse(data!.slice(6));
  expect(packet.error).toBeUndefined();
  expect(packet.result?.isError).not.toBe(true);
  return packet.result?.structuredContent as Record<string, any>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("phase 4 independent positive/negative evidence flags", () => {
  it.each(truth)("$label", async ({ tool, field, negative, positive }) => {
    const network = vi.fn(async () => { throw new Error("offline QA must never fetch"); });
    vi.stubGlobal("fetch", network);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const [input, expected] of [[negative, false], [positive, true]] as const) {
      const result = await callTool(tool, input as Record<string, unknown>);
      const raw = result?.[field];
      expect(typeof raw === "number" || typeof raw === "boolean", field).toBe(true);
      expect(typeof raw === "boolean" ? raw : raw > 0, field).toBe(expected);
      if (expected) {
        expect(result.overview?.next_action?.trim().length, tool).toBeGreaterThan(11);
        expect(result.total_findings ?? result.total_issues ?? 0, tool).toBeGreaterThan(0);
      }
    }
    expect(network).not.toHaveBeenCalled();
  }, 10_000);
});
