import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";

const ENDPOINT = "https://web-validator-mcp.digestseo.com/mcp";
const SENTINEL = "QA_PRIVATE_SENTINEL_20261122_NOVERBATIM";
const ROOT = "https://example.com/";
const OTHER = "https://example.org/";
const context = { props: {} } as ExecutionContext;
function env() {
  return {
    MCP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    SITE_AUDIT_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  } as unknown as Env;
}
async function send(name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request(ENDPOINT, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 377, method: "tools/call",
      params: { name, arguments: args } }),
  }), env(), context);
  const body = await response.text();
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith("data: "));
  const result = lines.length ? JSON.parse(lines[0].slice(6)) : JSON.parse(body);
  return { response, body, result };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("phase 3 local-only hostile/edge-case diagnostic safety", () => {
  it("never leaks untrusted supplied URL, header, robots or HTML markers", async () => {
    const net = vi.fn(async () => { throw new Error("offline tool unexpectedly attempted network access"); });
    vi.stubGlobal("fetch", net);
    const cases: [string, Record<string, unknown>][] = [
      ["diagnose_http_delivery", { observations: [{
        url: ROOT, status_code: 403,
        headers: { "cf-ray": SENTINEL, "cf-mitigated": "challenge" },
      }] }],
      ["review_http_directives", { resources: [{
        url: ROOT + "paper.pdf", status_code: 200, content_type: "application/pdf",
        content_disposition: 'attachment; filename="' + SENTINEL + '.pdf"',
        x_robots_tag: ["noindex"],
      }] }],
      ["review_metadata_consistency", { pages: [
        { url: ROOT, htmlContent: '<title>' + SENTINEL + '</title><main><h1>Hello</h1></main>' },
        { url: ROOT + "about", htmlContent: '<title>About</title><main><h1>About</h1></main>' },
      ] }],
      ["review_internal_links", { pages: [{
        url: ROOT,
        htmlContent: '<html lang="en"><title>Index</title><a href="/?secret=' + SENTINEL + '">Help</a></html>',
      }] }],
      ["review_crawler_access", {
        site_url: ROOT, robots_status_code: 200,
        robots_txt: "User-agent: *\nDisallow: /" + SENTINEL,
        pages: [{ url: ROOT, html: "<title>Test</title>" }],
        profiles: ["googlebot-smartphone"],
      }],
      ["review_url_variants", { reference_url: ROOT,
        observations: [{ url: ROOT, status_code: 200 },
          { url: ROOT + "?secret=" + SENTINEL, status_code: 200 }] }],
      ["review_https_security", { pages: [{
        url: ROOT, status_code: 200,
        content_security_policy: ["default-src 'self'; report-uri /" + SENTINEL],
        htmlContent: "<title>Healthy</title>",
      }] }],
      ["review_sitemap_inventory", { site_url: ROOT,
        documents: [{ sitemap_url: ROOT + "sitemap.xml",
          content: '<urlset><url><loc>' + ROOT + "?" + SENTINEL + '</loc></url></urlset>' }],
      }],
      ["compare_production_snapshots", { page_url: ROOT,
        baseline: { observed_at: "2026-11-20T00:00:00Z", http_status: 200,
          html: "<title>" + SENTINEL + "</title>" },
        current: { observed_at: "2026-11-21T00:00:00Z", http_status: 200,
          html: "<title>Updated</title>" },
      }],
    ];
    for (const [name, args] of cases) {
      const { response, body } = await send(name, args);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("set-cookie"), name).toBeNull();
      expect(response.headers.get("access-control-allow-origin"), name).toBe("https://chatgpt.com");
      expect(Buffer.byteLength(body), name).toBeLessThan(131_072);
      expect(body, name).not.toContain(SENTINEL);
    }
    expect(net).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects 36 malformed header and URL variants without HTTP 500 or network requests", async () => {
    const net = vi.fn(async () => { throw new Error("invalid caller-supplied data must not fetch"); });
    vi.stubGlobal("fetch", net);
    const mutations = [
      "\r\nSet-Cookie: " + SENTINEL, "\u0000", "\u202e" + SENTINEL, "A".repeat(1800),
      '<' + SENTINEL + '>', 'noindex, ' + SENTINEL,
      'noindex; max-age="a,b"', "noindex", "", "\\", "\u200d", "1e309",
    ];
    let attempts = 0;
    for (const raw of mutations) {
      for (const [name, args] of [
        ["review_http_directives", { resources: [{ url: ROOT + "file.pdf",
          status_code: 200, x_robots_tag: [raw] }] }],
        ["diagnose_http_delivery", { observations: [{ url: ROOT, status_code: 403,
          headers: { "cf-ray": raw } }] }],
        ["review_https_security", { pages: [{ url: ROOT, status_code: 200,
          content_security_policy: [raw] }] }],
      ] as [string, Record<string, unknown>][]) {
        const { response, body } = await send(name, args);
        expect(response.status, name).not.toBe(500);
        expect(response.status, name).toBeLessThan(500);
        expect(body.length, name).toBeLessThan(130_000);
        attempts += 1;
      }
    }
    expect(attempts).toBe(36);
    expect(net).not.toHaveBeenCalled();
  }, 45_000);
});
