import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";

const context = { props: {} } as ExecutionContext;

function createEnv(success = true) {
  return {
    MCP_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success })),
    },
    SITE_AUDIT_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success })),
    },
  } as unknown as Env;
}

async function callTool(name: string, args: Record<string, unknown>, clientHeaders: Record<string, string> = {}) {
  const response = await worker.fetch(
    new Request("https://web-validator-mcp.digestseo.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...clientHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    createEnv(),
    context,
  );
  expect(response.status).toBe(200);
  const payload = await response.text();
  const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine?.slice(6) ?? "{}").result as {
    structuredContent: Record<string, any>;
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

async function listTools() {
  const response = await worker.fetch(
    new Request("https://web-validator-mcp.digestseo.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
    }),
    createEnv(),
    context,
  );
  expect(response.status).toBe(200);
  const payload = await response.text();
  const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine?.slice(6) ?? "{}").result.tools as Array<Record<string, any>>;
}

async function readResource(uri: string) {
  const response = await worker.fetch(
    new Request("https://web-validator-mcp.digestseo.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "resources/read",
        params: { uri },
      }),
    }),
    createEnv(),
    context,
  );
  expect(response.status).toBe(200);
  const payload = await response.text();
  const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine?.slice(6) ?? "{}").result as {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("V01 real hosted MCP tool diagnostics", () => {
  it("discovers the tool, runs offline classification and never leaks challenge identifiers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = (await listTools()).find((entry) => entry.name === "diagnose_http_delivery");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    });
    const result = await callTool("diagnose_http_delivery", {
      observations: [{ url: "https://example.com/", status_code: 429,
        headers: { "cf-mitigated": "challenge", "cf-ray": "hidden-V01-ray" } }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      hops_observed: 1, errors_observed: 1, challenges_observed: 1,
      overview: { status: "needs_attention" },
    });
    expect(JSON.stringify(result)).not.toContain("hidden-V01-ray");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a live same-origin HTTP delivery probe with two stubbed responses", async () => {
    const fetchMock = vi.fn(async (url: URL) => String(url) === "https://example.com/"
      ? new Response(null, { status: 301, headers: { location: "/blocked" } })
      : new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("diagnose_http_delivery", { url: "https://example.com/" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      scope: "live_public_http_probe", hops_observed: 2,
      redirects_observed: 1, errors_observed: 1, challenges_observed: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects URL parameters, invalid input modes, and injected headers", async () => {
    for (const args of [
      { url: "https://example.com/?token=secret" },
      { url: "https://example.com/", observations: [{ url: "https://example.com/", status_code: 200 }] },
      { observations: [{ url: "https://example.com/", status_code: 403,
        headers: { "set-cookie": "private-V01-session" } }] },
    ]) {
      const result = await callTool("diagnose_http_delivery", args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-V01-session");
    }
  });
});

describe("V05 hosted MCP sitemap inventory", () => {
  const sitemap = (path: string) => '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + '<url><loc>https://example.com/' + path + "</loc></url></urlset>";

  it("discovers the read-only tool and reports redacted offline conflicts", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const tool = (await listTools()).find((t) => t.name === "review_sitemap_inventory");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    });
    const r = await callTool("review_sitemap_inventory", {
      site_url: "https://example.com/",
      documents: [{ sitemap_url: "https://example.com/sitemap.xml",
        content: sitemap("private-token") }],
      page_observations: [{ url: "https://example.com/private-token",
        status_code: 404, noindex: true }],
    });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "caller_supplied_sitemap_evidence", documents_observed: 1,
      distinct_page_urls: 1, noindex_conflicts: 1, status_conflicts: 1,
      known_indexability_conflicts: 1, inventory_complete: false,
      overview: { status: "needs_attention" },
    });
    expect(JSON.stringify(r)).not.toContain("private-token");
    expect(mock).not.toHaveBeenCalled();
  });

  it("performs bounded live sitemap GETs and reports unseen children", async () => {
    const mock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/sitemap.xml")
        ? new Response('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + '<sitemap><loc>https://example.com/a.xml</loc></sitemap>'
          + '<sitemap><loc>https://example.com/b.xml</loc></sitemap>'
          + '<sitemap><loc>https://example.com/c.xml</loc></sitemap>'
          + '</sitemapindex>', { status: 200, headers: { "content-type": "application/xml" } })
        : new Response(sitemap("landing"), {
          status: 200, headers: { "content-type": "text/xml" },
        }));
    vi.stubGlobal("fetch", mock);
    const r = await callTool("review_sitemap_inventory",
      { url: "https://example.com/", sitemap_url: "https://example.com/sitemap.xml" });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "live_public_sitemap_sample", documents_observed: 3,
      missing_child_documents: 1, inventory_complete: false,
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("rejects conflicting input modes and URL secret leaks", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const input of [
      { url: "https://example.com/?key=secret-V05" },
      { url: "https://example.com/", site_url: "https://example.com/",
        documents: [{ sitemap_url: "https://example.com/sitemap.xml", content: sitemap("one") }] },
      { site_url: "https://example.com/", documents: [
        { sitemap_url: "https://example.com/sitemap.xml?key=secret-V05", content: sitemap("one") },
      ] },
    ]) {
      const r = await callTool("review_sitemap_inventory", input);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("secret-V05");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("V04 hosted MCP redirect and canonical chain review", () => {
  it("discovers the read-only tool, returns structured offline findings and redacts URL tokens", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const tool = (await listTools()).find((entry) => entry.name === "review_redirect_canonical_chains");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true, openWorldHint: true, destructiveHint: false,
    });
    const report = await callTool("review_redirect_canonical_chains", {
      source_url: "https://example.com/",
      expected_destination: "https://example.com/final",
      observations: [
        { url: "https://example.com/", status_code: 301, location: "/final" },
        { url: "https://example.com/final", status_code: 200,
          html: "<html><head><meta name='robots' content='noindex'></head></html>",
          x_robots_tag: [] },
      ],
    });
    expect(report.isError).not.toBe(true);
    expect(report.structuredContent).toMatchObject({
      scope: "caller_supplied_redirect_evidence", hops_observed: 2,
      redirects_observed: 1, chain_complete: true, expected_destination_match: true,
      nonindexable_destination: true, overview: { status: "needs_attention" },
    });
    expect(JSON.stringify(report)).not.toContain("https://example.com/final");
    expect(mock).not.toHaveBeenCalled();
  });

  it("calls the actual hosted live MCP with bounded redirect/HTML probes", async () => {
    let n = 0;
    const mock = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(null, {
        status: 301, headers: { location: "/final" },
      });
      if (n === 2) return new Response(null, { status: 200 });
      return new Response("<html><head><link rel='canonical' href='/final'></head></html>", {
        status: 200, headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", mock);
    const report = await callTool("review_redirect_canonical_chains", {
      url: "https://example.com/",
      expected_destination: "https://example.com/final",
    });
    expect(report.isError).not.toBe(true);
    expect(report.structuredContent).toMatchObject({
      scope: "live_public_redirect_probe", hops_observed: 2,
      final_status_code: 200, chain_complete: true,
      expected_destination_match: true,
      destination_indexing_state: "no_noindex_observed",
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("rejects conflicting modes, unsafe source URLs and malicious evidence", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const args of [
      { url: "https://example.com/?token=SECRET_V04" },
      { url: "https://example.com/", source_url: "https://example.com/",
        observations: [{ url: "https://example.com/", status_code: 200 }] },
      { source_url: "https://example.com/", observations: [
        { url: "https://example.com/", status_code: 200 },
        { url: "https://example.com/unrelated", status_code: 200 },
      ] },
      { source_url: "https://example.com/", observations: [
        { url: "https://example.com/", status_code: 200,
          canonicals: ["a".repeat(1025)] },
      ] },
    ]) {
      const r = await callTool("review_redirect_canonical_chains", args);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("SECRET_V04");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("V03 hosted MCP crawler-access matrix", () => {
  it("discovers the new read-only tool and runs a redacted offline profile comparison", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const tool = (await listTools()).find((entry) => entry.name === "review_crawler_access");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true, openWorldHint: true, destructiveHint: false,
    });
    const r = await callTool("review_crawler_access", {
      site_url: "https://example.com/",
      robots_txt: "User-agent: Googlebot\nDisallow: /private",
      pages: [{
        url: "https://example.com/private/not-for-output",
        status_code: 200,
        html: "<meta name='googlebot' content='noindex'>",
        x_robots_tag: [],
      }],
      profiles: ["googlebot-smartphone", "bingbot"],
    });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "caller_supplied_crawler_evidence", rows_checked: 2,
      crawler_disallowed_rows: 1, noindex_declared_rows: 1,
      overview: { status: "needs_attention" },
    });
    expect(mock).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("not-for-output");
  });

  it("live MCP fetches robots.txt and an authorized HTML page, without a crawler identity claim", async () => {
    const mock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /", {
          status: 200, headers: { "content-type": "text/plain" },
        })
        : new Response("<html><head><meta name='robots' content='noindex'></head></html>", {
          status: 200, headers: { "content-type": "text/html" },
        }));
    vi.stubGlobal("fetch", mock);
    const r = await callTool("review_crawler_access", { url: "https://example.com/" });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "live_public_crawler_probe", rows_checked: 6,
      noindex_declared_rows: 6,
      unknown_access_rows: 0,
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting live/offline modes and secret-bearing URL inputs", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    for (const args of [
      { url: "https://example.com/?token=SECRET_V03" },
      { url: "https://example.com/", site_url: "https://example.com/" },
      { site_url: "https://example.com/", pages: [
        { url: "https://other.example.net/", html: "<h1>mismatch</h1>" },
      ] },
    ]) {
      const r = await callTool("review_crawler_access", args);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("SECRET_V03");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("V02 hosted MCP availability history and bounded repeat probes", () => {
  it("lists a stateless, read-only tool and compares offline observations", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const registered = (await listTools()).find((tool) => tool.name === "review_availability_history");
    expect(registered?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    });
    const r = await callTool("review_availability_history", { observations: [
      { observed_at: "2026-11-20T09:00:00Z", status_code: 200 },
      { observed_at: "2026-11-20T09:01:00Z", status_code: 503 },
      { observed_at: "2026-11-20T09:02:00Z", status_code: 200 },
    ] });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      observations_count: 3, observed_success_percent: 67,
      observed_http_5xx: 1, intermittent_non_success: true,
      scope: "caller_supplied_history", overview: { status: "needs_attention" },
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("calls the genuine hosted MCP tool for three bounded sequential GET outcomes", async () => {
    let ordinal = 0;
    const mock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      ordinal++;
      return new Response(null, { status: ordinal === 2 ? 429 : 200,
        headers: ordinal === 2 ? { "cf-mitigated": "challenge" } : {},
      });
    });
    vi.stubGlobal("fetch", mock);
    const r = await callTool("review_availability_history",
      { url: "https://example.com/", checks: 3 });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "live_bounded_burst", observations_count: 3,
      observed_success_percent: 67, observed_rate_limits: 1, observed_challenges: 1,
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("refuses URL secrets, invalid sample chronology and impossible input combinations", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const cases = [
      { url: "https://example.com/?secret=V02HIDDEN" },
      { url: "https://example.com/", checks: 4 },
      { observations: [{ observed_at: "2026-11-20T09:00:00Z", status_code: 200 }] },
      { observations: [
        { observed_at: "2026-11-20T09:02:00Z", status_code: 200 },
        { observed_at: "2026-11-20T09:00:00Z", status_code: 200 },
      ] },
      { url: "https://example.com/", observations: [
        { observed_at: "2026-11-20T09:00:00Z", status_code: 200 },
        { observed_at: "2026-11-20T09:01:00Z", status_code: 200 },
      ] },
    ];
    for (const input of cases) {
      const r = await callTool("review_availability_history", input);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("V02HIDDEN");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP HTTP boundary", () => {
  it("serves independent ChatGPT-style clients without cookies or server-side sessions", async () => {
    const env = createEnv();
    for (const [name, ip] of [
      ["chatgpt-client-one", "198.51.100.21"],
      ["chatgpt-client-two", "198.51.100.22"],
    ]) {
      const response = await worker.fetch(
        new Request("https://web-validator-mcp.digestseo.com/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            origin: "https://chatgpt.com",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name, version: "1.0.0" },
            },
          }),
        }),
        env,
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain('"serverInfo"');
    }
    expect(env.MCP_RATE_LIMITER.limit).toHaveBeenCalledTimes(2);
    const toolNames = (await listTools()).map((tool) => tool.name);
    expect(toolNames).toContain("compare_site_audits");
    expect(toolNames).not.toContain("audit.history"); // Local-only; no accidental hosted persistence.
  });

  it("serves the current and cached legacy widget resource URIs", async () => {
    const current = await readResource("ui://web-validator/results-v5.html");
    const legacy = await readResource("ui://web-validator/results-v4.html");

    expect(current.contents[0]).toMatchObject({
      uri: "ui://web-validator/results-v5.html",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(legacy.contents[0]).toMatchObject({
      uri: "ui://web-validator/results-v4.html",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(legacy.contents[0]?.text).toBe(current.contents[0]?.text);
  });

  it("rejects untrusted browser origins before invoking the limiter", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      env,
      context,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(env.MCP_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("rejects unexpected and mismatched Host headers before invoking the MCP parser", async () => {
    const env = createEnv();
    for (const [url, host] of [
      ["https://attacker.example/mcp", undefined],
      ["https://web-validator-mcp.digestseo.com/mcp", "attacker.example"],
    ] as const) {
      const response = await worker.fetch(
        new Request(url, { method: "POST", ...(host ? { headers: { host } } : {}) }),
        env,
        context,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(env.MCP_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("returns an exact CORS origin for approved preflights", async () => {
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://chatgpt.com" },
      }),
      createEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("rate limits an actor without exposing its raw identifier", async () => {
    const env = createEnv(false);
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      context,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    const key = (env.MCP_RATE_LIMITER.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("203.0.113.10");
  });

  it("uses the Cloudflare IP for limiting even when clients rotate session IDs", async () => {
    const env = createEnv();
    for (const sessionId of ["session-one", "session-two"]) {
      await worker.fetch(
        new Request("https://web-validator-mcp.digestseo.com/mcp", {
          method: "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.11",
            "mcp-session-id": sessionId,
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        }),
        env,
        context,
      );
    }

    const calls = (env.MCP_RATE_LIMITER.limit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.key).toBe(calls[1]?.[0]?.key);
  });

  it("rejects oversized requests before MCP JSON parsing", async () => {
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
      createEnv(),
      context,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("2 MiB") },
    });
  });

  it("allows server-to-server clients without emitting wildcard CORS", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body,
      }),
      createEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toContain('"serverInfo"');
  });

  it("turns pre-handler failures into a structured JSON-RPC response", async () => {
    const env = {
      MCP_RATE_LIMITER: { limit: vi.fn(async () => Promise.reject(new Error("limiter unavailable"))) },
    } as unknown as Env;
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: { origin: "https://chatgpt.com" },
      }),
      env,
      context,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { message: "The MCP request could not be completed." },
    });
  });
});

describe("hosted tool contract", () => {
  it("discovers twenty-five accurately annotated tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "validate_html",
      "validate_css",
      "audit_seo_metadata",
      "validate_schema_markup",
      "check_broken_links",
      "generate_validation_report",
      "audit_public_webpage",
      "audit_public_site",
      "preview_regression_alerts",
      "compare_historical_audits",
      "compare_site_audits",
      "verify_product_claims",
      "verify_content_provenance",
      "compare_competitor_intent",
      "validate_supported_schema",
      "review_internal_links",
      "review_metadata_consistency",
      "review_sitemap_inventory",
      "review_redirect_canonical_chains",
      "review_crawler_access",
      "review_availability_history",
      "diagnose_http_delivery",
      "review_url_variants",
      "review_https_security",
      "review_http_directives",
    ]);
    const noAuthSecuritySchemes = [{ type: "noauth" }];
    for (const tool of tools) {
      expect(tool.securitySchemes).toEqual(noAuthSecuritySchemes);
      expect(tool._meta?.securitySchemes).toEqual(noAuthSecuritySchemes);
      expect(tool.securitySchemes).toEqual(tool._meta?.securitySchemes);
      expect(tool.securitySchemes).not.toContainEqual(expect.objectContaining({ type: "oauth2" }));
    }

    const webpage = tools.find((tool) => tool.name === "audit_public_webpage");
    expect(webpage).toMatchObject({
      title: "Audit public webpage",
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        properties: {
          max_links: { maximum: 20, default: 15 },
          check_links: { default: false },
        },
      },
    });
    expect(tools.find((tool) => tool.name === "validate_schema_markup")?.title)
      .toBe("Validate JSON-LD syntax");
    expect(tools.find((tool) => tool.name === "audit_public_site")).toMatchObject({
      title: "Audit public site",
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        properties: {
          max_pages: { maximum: 8, default: 5 },
          page_offset: { minimum: 0, default: 0 },
        },
      },
    });
    for (const name of ["validate_html", "check_broken_links", "generate_validation_report"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
    }
  });
});

describe("validation report", () => {
  it("counts only Nu errors as html_errors and includes actionable details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          messages: [
            { type: "error", message: "Missing alt" },
            { type: "info", subType: "warning", message: "Add lang" },
          ],
        }),
      ),
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "generate_validation_report",
        arguments: {
          html: "<!doctype html><html lang=\"en\"><head><title>Hi</title></head><body><img src=x></body></html>",
          check_links: false,
        },
      },
    });
    const response = await worker.fetch(
      new Request("https://web-validator-mcp.digestseo.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body,
      }),
      createEnv(),
      context,
    );
    const payload = await response.text();
    const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
    const message = JSON.parse(dataLine?.slice(6) ?? "{}");

    expect(message.result.structuredContent).toMatchObject({
      html_errors: 1,
      html_warnings: 1,
      html_info: 0,
      html_messages: [
        { type: "error", message: "Missing alt" },
        { type: "warning", message: "Add lang" },
      ],
    });
    expect(message.result.structuredContent.seo_findings.length).toBeGreaterThan(0);
    expect(message.result.structuredContent.overview.counts).toEqual([
      { key: "errors", label: "Errors", value: 4, tone: "error" },
      { key: "warnings", label: "Warnings", value: 2, tone: "warning" },
      { key: "notes", label: "Notes", value: 3, tone: "info" },
      { key: "checks_passed", label: "Checks passed", value: 0, tone: "success" },
    ]);
  });
});

describe("polished tool responses", () => {
  it("fetches and validates a public page when validate_html receives url", async () => {
    const html = '<!doctype html><html lang="en"><head><title>Page</title></head><body><h1>Page</h1></body></html>';
    const fetchMock = vi.fn(async (target: RequestInfo | URL, options?: RequestInit) => {
      if (String(target) === "https://example.com/page" && options?.method === "GET") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (String(target) === "https://html5.validator.nu/?out=json" && options?.method === "POST") {
        return Response.json({ messages: [{ type: "error", message: "Missing alt" }] });
      }
      throw new Error(`Unexpected fetch: ${String(target)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("validate_html", { url: "https://example.com/page" });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      fetched_url: "https://example.com/page",
      total_messages: 1,
      overview: { kind: "html", status: "needs_attention" },
    });
    expect(result.structuredContent.overview.detail).toContain("Fetched and validated https://example.com/page.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "manual", body: html });
  });

  it("treats a standalone URL in the legacy html field as a webpage, not as HTML source", async () => {
    const html = '<!doctype html><html lang="en"><head><title>Example</title></head><body></body></html>';
    const fetchMock = vi.fn(async (target: RequestInfo | URL, options?: RequestInit) => {
      if (String(target) === "https://example.com/") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (String(target) === "https://html5.validator.nu/?out=json" && options?.method === "POST") {
        return Response.json({ messages: [] });
      }
      throw new Error(`Unexpected fetch: ${String(target)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("validate_html", { html: "  https://example.com/ \n" });

    expect(result.structuredContent).toMatchObject({
      fetched_url: "https://example.com/",
      total_messages: 0,
      overview: { status: "passed" },
    });
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "POST"]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(html);
  });

  it("refuses private URL validation and ambiguous inputs without network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const privateUrl = await callTool("validate_html", { url: "http://127.0.0.1/admin" });
    expect(privateUrl.isError).toBe(true);
    expect(privateUrl.structuredContent.overview.status).toBe("failed");
    expect(privateUrl.structuredContent.error).toContain("public HTTP(S) URL");

    const both = await callTool("validate_html", {
      html: "<!doctype html><title>Test</title>",
      url: "https://example.com/",
    });
    expect(both.isError).toBe(true);
    expect(both.structuredContent.error).toContain("not both");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a truthful HTML overview and limits Fix first copy to three prioritized findings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          messages: [
            { type: "info", subType: "warning", message: "Warning first", lastLine: 8 },
            { type: "error", message: "Error one", lastLine: 2, lastColumn: 4 },
            { type: "error", message: "Error two", lastLine: 3 },
            { type: "info", subType: "warning", message: "Warning two", lastLine: 9 },
          ],
        }),
      ),
    );

    const result = await callTool("validate_html", { html: "<!doctype html><title>private-demo-marker</title>" });
    const text = result.content[0]?.text ?? "";

    expect(result.structuredContent).toMatchObject({
      total_messages: 4,
      truncated: false,
      overview: {
        kind: "html",
        status: "needs_attention",
        total: 4,
        shown: 4,
        counts: [
          { key: "errors", label: "Errors", value: 2, tone: "error" },
          { key: "warnings", label: "Warnings", value: 2, tone: "warning" },
          { key: "notes", label: "Notes", value: 0, tone: "info" },
        ],
      },
    });
    expect(text).toContain("HTML needs attention: 2 errors and 2 warnings.");
    expect(text.match(/^- \*\*/gm)).toHaveLength(3);
    expect(text.indexOf("Error · `Line 2, column 4`")).toBeLessThan(text.indexOf("Warning · `Line 8`"));
    expect(text).not.toContain("private-demo-marker");
    expect(text).not.toContain('"errors":');
  });

  it("reports HTML truncation through the messages contract", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      type: "error",
      message: `Error ${index + 1}`,
      lastLine: index + 1,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages })));

    const result = await callTool("validate_html", { html: "<p>test</p>" });

    expect(result.structuredContent.messages).toHaveLength(200);
    expect(result.structuredContent).toMatchObject({
      total_messages: 205,
      truncated: true,
      overview: { total: 205, shown: 200, truncated: true },
    });
    expect(result.content[0]?.text).toContain("showing the first 200");
  });

  it("uses warning-only guidance when HTML has no errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({
        messages: [{ type: "info", subType: "warning", message: "Add a lang attribute" }],
      })),
    );

    const result = await callTool("validate_html", { html: "<!doctype html><title>Test</title>" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("HTML needs attention: 1 warning.");
    expect(text).toContain("Review the warnings");
    expect(text).not.toContain("Fix errors");
  });

  it("distinguishes absent JSON-LD from valid JSON-LD", async () => {
    const absent = await callTool("validate_schema_markup", { html: "<main>No schema</main>" });
    const valid = await callTool("validate_schema_markup", {
      html: '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
    });

    expect(absent.structuredContent).toMatchObject({
      blocks_checked: 0,
      overview: { status: "not_applicable" },
    });
    expect(absent.content[0]?.text).toContain("No JSON-LD blocks were found");
    expect(valid.structuredContent).toMatchObject({
      blocks_checked: 1,
      overview: {
        status: "passed",
        counts: [
          { key: "valid_blocks", label: "Valid blocks", value: 1, tone: "success" },
          { key: "errors", label: "Errors", value: 0, tone: "error" },
          { key: "warnings", label: "Warnings", value: 0, tone: "warning" },
        ],
      },
    });
  });

  it("uses tool-specific units for CSS and SEO metrics", async () => {
    const css = await callTool("validate_css", { css: "a { color: red;" });
    const seo = await callTool("audit_seo_metadata", {
      html: "<!doctype html><html lang=\"en\"><head></head><body><h1>Test</h1></body></html>",
    });

    expect(css.structuredContent.overview.counts).toEqual([
      { key: "syntax_errors", label: "Syntax errors", value: 1, tone: "error" },
    ]);
    expect(seo.structuredContent.overview.counts).toEqual([
      { key: "errors", label: "Errors", value: 3, tone: "error" },
      { key: "warnings", label: "Warnings", value: 0, tone: "warning" },
      { key: "notes", label: "Notes", value: 2, tone: "info" },
    ]);
  });

  it("separates healthy, redirected, and unreachable links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 301 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 })),
    );

    const result = await callTool("check_broken_links", {
      html: [
        '<a href="https://example.com/ok">OK</a>',
        '<a href="https://example.com/moved">Moved</a>',
        '<a href="https://example.com/missing">Missing</a>',
      ].join(""),
      max_links: 3,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 3,
      eligible_links: 3,
      links_truncated: false,
      healthy_links: 1,
      redirects: 1,
      unreachable_links: 1,
      overview: {
        status: "needs_attention",
        truncated: false,
        counts: [
          { key: "checked", label: "Checked", value: 3, tone: "info" },
          { key: "healthy", label: "Healthy", value: 1, tone: "success" },
          { key: "redirects", label: "Redirects", value: 1, tone: "warning" },
          { key: "unreachable", label: "Unreachable", value: 1, tone: "error" },
        ],
      },
    });
    expect(result.content[0]?.text).toContain("1 healthy link, 1 redirect, and 1 unreachable link");
  });

  it("marks link checks partial when the maximum hides distinct eligible links", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/first">First</a><a href="https://example.com/first">Duplicate</a><a href="https://example.com/second">Second</a>',
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 1,
      eligible_links: 2,
      links_truncated: true,
      overview: { status: "partial", total: 2, shown: 1, truncated: true },
    });
    expect(result.content[0]?.text).toContain("1 of 2 eligible links");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a rate-limited link as unverified, not unreachable or healthy", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })));

    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/limited">Limited</a><a href="https://example.com/ok">OK</a>',
      max_links: 2,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 2,
      healthy_links: 1,
      unreachable_links: 0,
      unverified_links: 1,
      overview: { status: "partial" },
    });
    expect(result.content[0]?.text).toContain("unverified");
    expect(result.content[0]?.text).not.toContain("returned status 429");
  });

  it("checks GET after HEAD 500 before counting an otherwise healthy link as unreachable", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      requests.push(options?.method ?? "");
      return new Response(null, { status: options?.method === "HEAD" ? 500 : 200 });
    }));

    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/error">Error</a>',
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 1,
      healthy_links: 1,
      unreachable_links: 0,
      unverified_links: 0,
      overview: { status: "passed" },
    });
    expect(requests).toEqual(["HEAD", "GET"]);
  });

  it("treats 401 and 403 as access-restricted checks, not confirmed broken links", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL, options?: RequestInit) => {
      methods.push(options?.method ?? "");
      return new Response(null, { status: String(target).endsWith("/login") ? 401 : 403 });
    }));
    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/login">Login</a><a href="https://example.com/forbidden">Forbidden</a>',
      max_links: 2,
    });
    expect(result.structuredContent).toMatchObject({
      links_checked: 2,
      healthy_links: 0,
      unreachable_links: 0,
      unverified_links: 2,
      overview: { status: "partial" },
    });
    expect(methods.sort()).toEqual(["GET", "GET", "HEAD", "HEAD"]);
  });

  it("confirms a HEAD 401 with GET when the public destination is accessible", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_target: RequestInfo | URL, options?: RequestInit) => {
      methods.push(options?.method ?? "");
      return new Response(null, { status: options?.method === "HEAD" ? 401 : 200 });
    }));
    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/login">Login</a>',
      max_links: 1,
    });
    expect(result.structuredContent).toMatchObject({
      healthy_links: 1,
      unreachable_links: 0,
      unverified_links: 0,
      overview: { status: "passed" },
    });
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("marks a combined audit partial when a link is rate-limited, without calling it broken", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL, options?: RequestInit) => {
      const url = String(target);
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      if (url === "https://example.com/limited" && options?.method === "HEAD") {
        return new Response(null, { status: 429 });
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("generate_validation_report", {
      html: '<!doctype html><html lang="en"><head><title>Example</title></head><body><h1>Example</h1><a href="https://example.com/limited">Link</a></body></html>',
      check_links: true,
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 1,
      broken_links: 0,
      unreachable_links: 0,
      unverified_links: 1,
      overview: { status: "partial" },
    });
    expect(result.content[0]?.text).toContain("remains unverified");
  });

  it("makes an otherwise clear combined report partial when link coverage is capped", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      if (String(target).startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("generate_validation_report", {
      html: '<!doctype html><html lang="en"><head><title>Example</title></head><body><h1>Example</h1><a href="https://example.com/a">A</a><a href="https://example.com/b">B</a></body></html>',
      check_links: true,
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 1,
      eligible_links: 2,
      links_truncated: true,
      overview: { status: "partial" },
    });
    expect(result.structuredContent.overview.detail).toContain("1 of 2 eligible links");
    expect(fetchMock.mock.calls.filter(([target]) => !String(target).startsWith("https://html5.validator.nu/"))).toHaveLength(1);
  });

  it("checks fragment-only links pointing to a different HTML base document", async () => {
    const fetchMock = vi.fn(async (_target: unknown, _options?: RequestInit) => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const remote = await callTool("check_broken_links", {
      html: '<base href="https://example.com/docs/"><a href="#missing">Missing on base page</a>',
      base_url: "https://example.com/source",
      max_links: 1,
    });
    expect(remote.structuredContent).toMatchObject({ links_checked: 1, unreachable_links: 1 });
    expect(fetchMock.mock.calls.map(([target]) => String(target))).toEqual([
      "https://example.com/docs/",
      "https://example.com/docs/",
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual(["HEAD", "GET"]);

    const samePage = await callTool("check_broken_links", {
      html: '<base href="/source"><a href="#local">Same page</a>',
      base_url: "https://example.com/source",
      max_links: 1,
    });
    expect(samePage.structuredContent).toMatchObject({ links_checked: 0 });

    const privateBase = await callTool("check_broken_links", {
      html: '<base href="http://127.0.0.1/private"><a href="#secret">Unsafe base</a>',
      base_url: "https://example.com/source",
      max_links: 1,
    });
    expect(privateBase.structuredContent).toMatchObject({ links_checked: 0 });
    expect(fetchMock.mock.calls).toHaveLength(2);
  });
  it("does not classify an unconditional HTTP 304 as a healthy link or redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 304 })));

    const result = await callTool("check_broken_links", {
      html: '<a href="https://example.com/not-modified">Cached</a>',
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 1,
      healthy_links: 0,
      redirects: 0,
      unreachable_links: 0,
      unverified_links: 1,
      overview: {
        status: "partial",
      },
    });
    expect(result.content[0]?.text).toContain("unverified");
    expect(result.content[0]?.text).not.toContain("redirect status 304");
  });

  it("keeps a combined report usable when HTML validation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("upstream unavailable"))));

    const result = await callTool("generate_validation_report", {
      html: "<!doctype html><html><head></head><body><h1>Test</h1></body></html>",
      check_links: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      links_requested: false,
      failed_checks: ["html"],
      html_messages: [],
      overview: { status: "partial" },
    });
    expect(result.structuredContent.seo_findings.length).toBeGreaterThan(0);
    expect(result.content[0]?.text).toContain("Validation report is partial");
    expect(result.content[0]?.text).toContain("Links were not requested");
  });

  it("marks a failed single-tool invocation as failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("upstream unavailable"))));

    const result = await callTool("validate_html", { html: "<p>test</p>" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      messages: [],
      total_messages: 0,
      overview: { kind: "html", status: "failed" },
    });
    expect(result.content[0]?.text).toContain("HTML validation could not be completed");
  });
});

describe("public webpage audit", () => {
  it("reports a fetched X-Robots-Tag noindex directive as an SEO warning", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/header-noindex") {
        return new Response(
          "<!doctype html><html><head><title>Example page title for validation</title></head><body><h1>Example</h1></body></html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-robots-tag": "none",
            },
          },
        );
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/header-noindex",
      check_links: false,
    });

    expect(result.structuredContent.seo_findings).toContainEqual(expect.objectContaining({
      code: "seo.robots.noindex",
      severity: "warning",
    }));
  });

  it("fetches one page and returns the existing report without exposing its HTML", async () => {
    const privateMarker = "private-page-marker-that-must-not-be-returned";
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url.startsWith("https://example.com/page")) {
        return new Response(
          `<!doctype html><html><head><title>Example page title for validation</title></head><body><h1>Example</h1><!--${privateMarker}--></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.startsWith("https://html5.validator.nu/")) {
        return Response.json({ messages: [{ type: "error", message: "Example HTML problem" }] });
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/page#fragment",
      check_links: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      requested_url: "https://example.com/page",
      fetched_url: "https://example.com/page",
      redirects_followed: 0,
      http_status: 200,
      content_type: "text/html",
      page_fetched: true,
      css_checked: false,
      links_requested: false,
      links_checked: 0,
      html_errors: 1,
      overview: { kind: "report", title: "Public webpage audit" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(result.content[0]?.text).toContain("Audited https://example.com/page");
    expect(result.content[0]?.text).toContain("Linked and external CSS were not checked");
  });

  it("preserves XHTML media type through a public webpage audit", async () => {
    const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Example XHTML page for validation</title></head><body><h1>Example</h1></body></html>';
    const fetchMock = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      if (url === "https://example.com/page.xhtml") {
        return new Response(xhtml, { headers: { "content-type": "application/xhtml+xml; charset=utf-8" } });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/page.xhtml",
      check_links: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      content_type: "application/xhtml+xml",
      page_fetched: true,
    });
    const validatorCall = fetchMock.mock.calls.find(([target]) => String(target).startsWith("https://html5.validator.nu/"));
    expect(validatorCall?.[1]?.headers).toMatchObject({
      "content-type": "application/xhtml+xml; charset=utf-8",
    });
  });
  it("uses the final redirected URL to resolve optional relative links", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/folder/page" } });
      }
      if (url === "https://example.com/folder/page") {
        return new Response('<!doctype html><title>Page</title><a href="child">Child</a>', {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      if (url === "https://example.com/folder/child" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/start",
      check_links: true,
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      fetched_url: "https://example.com/folder/page",
      redirects_followed: 1,
      links_requested: true,
      links_checked: 1,
      healthy_links: 1,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/folder/child"))
      .toBe(true);
  });

  it("uses the first safe document base href to resolve optional relative links", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      if (url === "https://example.com/folder/page") {
        return new Response(
          '<!doctype html><head><base href="assets/"></head><body><a href="child">Child</a></body>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      if (url === "https://example.com/folder/assets/child" && init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/folder/page",
      check_links: true,
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      fetched_url: "https://example.com/folder/page",
      links_requested: true,
      links_checked: 1,
      healthy_links: 1,
      unreachable_links: 0,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/folder/assets/child"))
      .toBe(true);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/folder/child"))
      .toBe(false);
  });
  it("skips relative link checks when the first document base href is not public", async () => {
    const fetchMock = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      if (url === "https://example.com/folder/page") {
        return new Response(
          '<!doctype html><head><base href="http://127.0.0.1/private/"></head><body><a href="child">Child</a></body>',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/folder/page",
      check_links: true,
      max_links: 1,
    });

    expect(result.structuredContent).toMatchObject({
      links_checked: 0,
      healthy_links: 0,
      unreachable_links: 0,
    });
    expect(fetchMock.mock.calls.some(([target]) => String(target).startsWith("http://127.0.0.1/")))
      .toBe(false);
    expect(fetchMock.mock.calls.some(([target]) => String(target) === "https://example.com/folder/child"))
      .toBe(false);
  });
  it("returns a clear failure and performs no validation for a blocked URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "http://127.0.0.1/private",
      check_links: false,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      page_fetched: false,
      css_checked: false,
      failed_checks: ["fetch"],
      overview: { status: "failed", title: "Public webpage audit" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call the validator after a non-HTML page response", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_webpage", {
      url: "https://example.com/api",
      check_links: false,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ page_fetched: false, failed_checks: ["fetch"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("P1-04 product promise verification through hosted MCP HTTP", () => {
  const advertised = [
    "validate_html", "audit_public_webpage", "audit_public_site", "validate_css",
    "audit_seo_metadata", "check_broken_links", "validate_schema_markup",
    "generate_validation_report",
  ];
  const landing = (codes = advertised, limit = 8) =>
    '<!doctype html><html><body><main><section><h2>Public ChatGPT capabilities</h2>'
      + codes.map((name) => '<p><code>' + name + '</code></p>').join("")
      + '</section><div>Site batch Up to ' + limit + ' pages</div>'
      + '<p>The hosted app is read-only. It cannot create screenshots.</p>'
      + '<p>The separate local MCP is the only surface for responsive screenshots.</p>'
      + '</main></body></html>';

  it("compares actual registered hosted tools, schema bounds and read-only metadata", async () => {
    const exposed = await listTools();
    expect(exposed.map((tool) => tool.name)).toContain("verify_product_claims");
    expect(exposed.map((tool) => tool.name)).toContain("audit_public_site");
    const result = await callTool("verify_product_claims", { html: landing() });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "landing_html_vs_registered_mcp_metadata",
      surface: "hosted",
      catalog_available: true,
      tool_claims_checked: 8,
      contradicted_claims: 0,
      unverified_claims: 0,
      coverage_limited: false,
      site_batch_limit: { advertised: 8, registered: 8 },
    });
    expect(result.structuredContent.consistent_claims).toBeGreaterThanOrEqual(8);
    expect(result.structuredContent.registered_tools).toBe(exposed.length);
    expect(result.structuredContent.overview.status).toBe("passed");
  });

  it("flags invented public tools and inflated site batches without echoing input secrets", async () => {
    const html = landing([...advertised, "impossible_ai_rank_tracker"], 300)
      .replace("</main>", '<script>FAKE_PRODUCT_SECRET</script></main>');
    const result = await callTool("verify_product_claims", { html });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.contradicted_claims).toBe(2);
    expect(result.structuredContent.findings.map((item: { code: string }) => item.code))
      .toEqual(expect.arrayContaining(["product.tool_missing", "product.site_batch_overclaim"]));
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(JSON.stringify(result)).not.toContain("FAKE_PRODUCT_SECRET");
  });

  it("fetches exactly one authorized public product HTML document without extra requests", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      calls.push(url);
      if (url === "https://example.com/product") return new Response(landing(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      throw new Error("Unexpected fetch " + url);
    }));
    const result = await callTool("verify_product_claims", { public_url: "https://example.com/product" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.tool_claims_checked).toBe(8);
    expect(calls).toEqual(["https://example.com/product"]);
  });

  it("refuses missing or simultaneous HTML+URL without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const args of [{}, {
      html: landing(), public_url: "https://example.com/product",
    }]) {
      const result = await callTool("verify_product_claims", args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.catalog_available).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("P1-05 provenance verification through hosted MCP HTTP", () => {
  const page = "https://example.com/report";
  const source = "https://doi.org/10.1000/sample";
  const method = "https://example.com/methods";
  const manifest = {
    as_of: "2026-11-19",
    sources: [{ id: "study_2026", url: source }],
    datasets: [{ id: "query_data", version: "v2", as_of: "2026-11-10",
      max_age_days: 14, methodology_id: "weighted" }],
    methodologies: [{ id: "weighted", url: method }],
  };
  const html = (sourceTarget = source, version = "v2", snapshot = "2026-11-10") =>
    '<html lang=en><head><meta property=article:published_time content=2026-11-01>'
      + '<meta property=article:modified_time content=2026-11-10></head><body><main>'
      + '<a rel=cite data-citation-id=study_2026 href="' + sourceTarget + '">Source</a>'
      + '<div data-dataset-id=query_data data-dataset-version="' + version
      + '" data-dataset-as-of="' + snapshot + '" data-methodology-id=weighted></div>'
      + '<a data-methodology-id=weighted href="' + method + '">Method</a></main></body></html>';

  it("uses the real Worker tool and does not fetch citation or dataset URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exposed = await listTools();
    const tool = exposed.find((item) => item.name === "verify_content_provenance");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true, openWorldHint: false, destructiveHint: false,
    });
    const result = await callTool("verify_content_provenance", {
      pages: [{ url: page, htmlContent: html() }], evidence: manifest,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "supplied_static_html_and_evidence", pages_sampled: 1, pages_eligible: 1,
      citations_observed: 1, datasets_observed: 1, methodologies_observed: 1,
      conflicting_declarations: 0, unverified_declarations: 0, coverage_limited: false,
    });
    expect(result.structuredContent.overview.status).toBe("passed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports caller-evidence contradictions and preserves a bounded redacted response", async () => {
    const result = await callTool("verify_content_provenance", {
      pages: [{ url: page, htmlContent: html("https://example.com/alternate", "v99") }],
      evidence: manifest,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.conflicting_declarations).toBeGreaterThanOrEqual(2);
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(result.structuredContent.findings.map((finding: { code: string }) => finding.code))
      .toEqual(expect.arrayContaining([
        "citation_target_differs_from_supplied_evidence", "dataset_version_conflict",
      ]));
    expect(result.content[0].text).not.toContain(html());
  });

  it("without an evidence manifest reports uncertainty rather than a false clean verdict", async () => {
    const result = await callTool("verify_content_provenance", {
      pages: [{ url: page, htmlContent: html() }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.conflicting_declarations).toBe(0);
    expect(result.structuredContent.unverified_declarations).toBeGreaterThan(0);
    expect(result.structuredContent.coverage_limited).toBe(true);
    expect(result.structuredContent.overview.status).toBe("partial");
  });

  it("rejects query-bearing input URL labels and oversized HTML through MCP validation", async () => {
    for (const arguments_ of [
      { pages: [{ url: page + "?token=FAKE_SECRET", htmlContent: html() }] },
      { pages: [{ url: page, htmlContent: "x".repeat(200_001) }] },
    ]) {
      const result = await callTool("verify_content_provenance", arguments_);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    }
  });
});

describe("P1-06 competitor intent comparison through hosted MCP HTTP", () => {
  const primary = {
    url: "https://publisher.test/guide",
    htmlContent: '<html><head><title>Posture lesson</title></head><body>'
      + '<nav><a href="/checkout">Buy now</a></nav>'
      + '<main><h1>Posture overview</h1><p>Healthier desk work tips.</p></main></body></html>',
  };
  const shop = (host: string) => ({
    url: "https://" + host + ".test/chairs",
    htmlContent: '<html><head><title>Best ergonomic chair</title>'
      + '<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":99}}</script>'
      + '</head><body><main><h1>Best ergonomic chair</h1>'
      + '<a href="/checkout">Buy now</a></main></body></html>',
  });

  it("lists the hosted tool with offline read-only annotations and calls it without fetch", async () => {
    const fetching = vi.fn();
    vi.stubGlobal("fetch", fetching);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "compare_competitor_intent")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("compare_competitor_intent", {
      primary, competitors: [shop("shop-one"), shop("shop-two")],
      expected_intent: "commercial", query: "best ergonomic chair",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_static_html_only",
      competitors_submitted: 2, competitors_eligible: 2,
      competitors_with_intent_signals: 2,
      coverage_limited: true,
    });
    expect(result.structuredContent.findings.map((f: { code: string }) => f.code))
      .toEqual(expect.arrayContaining([
        "primary_intent_signal_gap", "primary_heading_query_gap",
      ]));
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(fetching).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Posture overview");
    expect(JSON.stringify(result)).not.toContain("/chairs");
  });

  it("keeps absent intent and query evidence explicitly partial", async () => {
    const result = await callTool("compare_competitor_intent", {
      primary, competitors: [shop("shop-one")],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.query_supplied).toBe(false);
    expect(result.structuredContent.usable_query_terms).toBe(0);
    expect(result.structuredContent.coverage_limited).toBe(true);
    expect(result.structuredContent.overview.status).toBe("partial");
  });

  it("rejects same-origin, invalid token-bearing URL, and oversize input safely", async () => {
    for (const args of [
      { primary, competitors: [{ ...shop("shop-one"), url: "https://publisher.test/other" }] },
      { primary, competitors: [{ ...shop("shop-one"), url: "https://shop-one.test/chairs?secret=FAKE_TOKEN" }] },
      { primary, competitors: [{ ...shop("shop-one"), htmlContent: "x".repeat(150_001) }] },
    ]) {
      const result = await callTool("compare_competitor_intent", args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
    }
  });

  it("does not hallucinate a search-engine verdict from one supplied competitor", async () => {
    const result = await callTool("compare_competitor_intent", {
      primary, competitors: [shop("shop-one")], expected_intent: "informational",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.coverage_limited).toBe(true);
    expect(result.structuredContent.limitations.join(" ")).toContain("not Google's interpretation");
    expect(result.structuredContent.competitors_submitted).toBe(1);
  });
});

describe("P1-07 supported structured-data review through hosted MCP HTTP", () => {
  const valid = '<html><head><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@graph":['
    + '{"@type":"Article","headline":"Useful article","author":{"@type":"Person","name":"A"}},'
    + '{"@type":"Product","name":"Chair","offers":{"@type":"Offer","price":"0","priceCurrency":"EUR"}}'
    + ']}</script></head><body><main>Human-visible content.</main></body></html>';
  const broken = '<html><head><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"Product","name":43,'
    + '"offers":{"@type":"Offer","price":"NO_PRICE","priceCurrency":"euros"}}'
    + '</script></head></html>';

  it("discovers the no-network tool and invokes it with actual HTTP MCP messages", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "validate_supported_schema")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("validate_supported_schema", { html: valid });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "bounded_jsonld_structural_profiles",
      blocks_seen: 1, supported_nodes: 2, errors: 0, warnings: 0,
      coverage_limited: true,
    });
    expect(result.structuredContent.types_checked).toEqual(["Article", "Product"]);
    expect(result.structuredContent.overview.status).toBe("partial");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Useful article");
  });

  it("returns fixed structural review findings without echoing price/name secrets", async () => {
    const result = await callTool("validate_supported_schema", { html: broken });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.errors).toBe(0);
    expect(result.structuredContent.warnings).toBeGreaterThanOrEqual(3);
    expect(result.structuredContent.findings.map((finding: { code: string }) => finding.code))
      .toEqual(expect.arrayContaining([
        "invalid_field_type", "invalid_price", "invalid_currency",
      ]));
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(JSON.stringify(result)).not.toContain("NO_PRICE");
  });

  it("rejects UTF-8 oversized HTML and preserves the old syntax-only API", async () => {
    const invalid = await callTool("validate_supported_schema", { html: "é".repeat(125_001) });
    expect(invalid.isError).toBe(true);
    const old = await callTool("validate_schema_markup", { html: broken });
    expect(old.isError).toBeUndefined();
    expect(old.structuredContent.blocks_checked).toBe(1);
    expect(old.structuredContent.total_issues).toBe(0);
    const malformed = await callTool("validate_supported_schema", {
      html: '<script type="application/ld+json">{"FAKE_SECRET":,}</script>',
    });
    expect(malformed.isError).toBeUndefined();
    expect(malformed.structuredContent.errors).toBe(1);
    expect(JSON.stringify(malformed)).not.toContain("FAKE_SECRET");
  });

  it("leaves unrecognized remote contexts and unsupported types unverified", async () => {
    const result = await callTool("validate_supported_schema", {
      html: '<script type="application/ld+json">'
        + '{"@context":"https://FAKE_PRIVATE.example/context","@type":"Product","name":"SECRET"}'
        + '</script>',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.supported_nodes).toBe(0);
    expect(result.structuredContent.context_unverified_nodes).toBeGreaterThan(0);
    expect(result.structuredContent.coverage_limited).toBe(true);
    expect(result.structuredContent.overview.status).toBe("partial");
    expect(JSON.stringify(result)).not.toContain("FAKE_PRIVATE");
  });
});

describe("P1-08 contextual internal-link review through hosted MCP HTTP", () => {
  const source = {
    url: "https://example.com/guides/work",
    htmlContent: '<html><head><title>Work guide</title></head><body>'
      + '<nav><a href="/products/chairs">Global navigation</a></nav>'
      + '<main><h1>Work guide</h1>'
      + '<a href="/products/chairs">read more</a>'
      + '<a href="/products/chairs"><img alt="" src="chair.png"></a>'
      + '<a href="https://external.test/research">External research</a>'
      + '</main></body></html>',
  };
  const destination = {
    url: "https://example.com/products/chairs",
    htmlContent: '<html><head><title>Office ergonomic chairs</title></head>'
      + '<main><h1>Ergonomic office chairs</h1></main></html>',
  };

  it("discovers a read-only no-fetch tool and compares observed link/anchor evidence", async () => {
    const mockedFetch = vi.fn();
    vi.stubGlobal("fetch", mockedFetch);
    const advertised = await listTools();
    expect(advertised.find((tool) => tool.name === "review_internal_links")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("review_internal_links", { pages: [source, destination] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_same_origin_html_only",
      pages_sampled: 2, pages_eligible: 2,
      internal_links_observed: 2, external_links_observed: 1,
      linked_sample_targets: 1, missing_anchor_labels: 1,
      generic_anchor_links: 1, coverage_limited: true,
    });
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/products/chairs");
  });

  it("treats unsupplied and query-variant destinations as unknown, never broken", async () => {
    const input = { ...source,
      htmlContent: '<html><main><a href="/not-supplied">Catalog</a>'
        + '<a href="/products/chairs?token=FAKE_TOKEN">Chairs</a></main></html>' };
    const result = await callTool("review_internal_links", { pages: [input, destination] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.unmatched_internal_links).toBe(2);
    expect(result.structuredContent.linked_sample_targets).toBe(0);
    expect(result.structuredContent.coverage_limited).toBe(true);
    expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
  });

  it("rejects different origins and unsafe source labels without echoing secrets", async () => {
    for (const pages of [
      [source, { ...destination, url: "https://other.example/x" }],
      [source, { ...destination, url: destination.url + "?token=FAKE_TOKEN" }],
      [source, { ...destination, url: source.url }],
    ]) {
      const result = await callTool("review_internal_links", { pages });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
    }
  });

  it("rejects UTF-8 oversized documents and preserves existing link checker behavior", async () => {
    const result = await callTool("review_internal_links", { pages: [
      source, { ...destination, htmlContent: "é".repeat(80_001) },
    ] });
    expect(result.isError).toBe(true);
    const tools = await listTools();
    expect(tools.some((tool) => tool.name === "check_broken_links")).toBe(true);
  });
});

describe("P1-09 metadata consistency through hosted MCP HTTP", () => {
  const article = (title = "Site title") => ({
    url: "https://example.com/article",
    htmlContent: '<html><head><title>' + title + '</title>'
      + '<meta name="description" content="Unique metadata summary">'
      + '<link rel="canonical" href="/article">'
      + '<meta property="og:title" content="Site title">'
      + '</head><body><main>Text</main></body></html>',
  });
  const other = {
    url: "https://example.com/product",
    htmlContent: '<html><head><title>Other title</title>'
      + '<link rel="canonical" href="/product">'
      + '</head><body><main>Text</main></body></html>',
  };

  it("discovers the read-only offline tool and invokes it without a page fetch", async () => {
    const fetching = vi.fn();
    vi.stubGlobal("fetch", fetching);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "review_metadata_consistency")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("review_metadata_consistency", {
      pages: [article(), other],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_same_origin_metadata_only",
      pages_sampled: 2, conflicting_declaration_fields: 0,
      duplicate_declaration_fields: 0, coverage_limited: true,
    });
    expect(result.structuredContent.overview.status).toBe("partial");
    expect(fetching).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Unique metadata summary");
  });

  it("reports incompatible declarations and keeps social differences informational", async () => {
    const mutated = { ...article(),
      htmlContent: article().htmlContent.replace("</title>", "</title><title>Second title</title>")
        .replace('content="Site title"', 'content="Different social title"') };
    const result = await callTool("review_metadata_consistency", { pages: [mutated] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.conflicting_declaration_fields).toBe(1);
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(result.structuredContent.findings.some((f: { code: string }) =>
      f.code === "conflicting_declaration")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Second title");
  });

  it("retains cross-page duplicate groups as review leads, not automatic SEO failures", async () => {
    const result = await callTool("review_metadata_consistency", {
      pages: [article(), { ...other,
        htmlContent: '<html><head><title>Site title</title>'
          + '<meta name="description" content="Unique metadata summary">'
          + '<link rel="canonical" href="/product"></head></html>' }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.duplicate_title_groups).toBe(1);
    expect(result.structuredContent.duplicate_description_groups).toBe(1);
    expect(result.structuredContent.conflicting_declaration_fields).toBe(0);
    expect(result.structuredContent.coverage_limited).toBe(true);
  });

  it("rejects unsafe labels, duplicate pages, mixed origins and oversized UTF-8 inputs", async () => {
    for (const pages of [
      [article(), { ...other, url: other.url + "?token=FAKE_SECRET" }],
      [article(), article()],
      [article(), { ...other, url: "https://other.example.com/product" }],
      [{ ...article(), htmlContent: "é".repeat(90_001) }],
    ]) {
      const result = await callTool("review_metadata_consistency", { pages });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    }
  });
});

describe("P1-14 observed URL variant MCP contract", () => {
  const reference = "https://example.com/Products/Widget";
  const baseObservation = {
    url: reference, status_code: 200, method: "GET" as const,
    content_sha256: "a".repeat(64), canonicals: [reference],
  };

  it("discovers and invokes genuine read-only hosted MCP tool without network access", async () => {
    const fetching = vi.fn();
    vi.stubGlobal("fetch", fetching);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "review_url_variants")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("review_url_variants", {
      reference_url: reference,
      observations: [
        baseObservation,
        { url: "http://example.com/Products/Widget", status_code: 301,
          location: reference },
        { url: reference + "?session=FAKE_SECRET_QUERY_TOKEN", status_code: 200,
          content_sha256: "a".repeat(64), canonicals: [reference] },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_url_variant_evidence_only",
      pages_sampled: 3, reference_observed: true,
      scheme_variants: 1, query_variants: 1,
      redirects_to_reference: 1, matching_content_variants: 1,
      coverage_limited: true,
    });
    expect(result.structuredContent.pages[1].response_state).toBe("redirect");
    expect(result.structuredContent.pages[2].canonical_state).toBe("to_reference");
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(fetching).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("FAKE_SECRET_QUERY_TOKEN");
    expect(JSON.stringify(result)).not.toContain("/Products/Widget");
  });

  it("distinguishes exact case and slash candidate dimensions without claiming equivalence", async () => {
    const result = await callTool("review_url_variants", {
      reference_url: reference,
      observations: [
        baseObservation,
        { url: "https://www.example.com/products/widget/", status_code: 200 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.www_variants).toBe(1);
    expect(result.structuredContent.slash_variants).toBe(1);
    expect(result.structuredContent.case_variants).toBe(1);
    expect(result.structuredContent.content_not_comparable_variants).toBe(1);
    expect(result.structuredContent.pages[1].content_matches_reference).toBe(null);
    expect(result.structuredContent.overview.status).toBe("partial");
  });

  it("finds contradictory canonical hints for caller-hash-identical HTTP 200 variants", async () => {
    const result = await callTool("review_url_variants", {
      reference_url: reference,
      observations: [
        baseObservation,
        { url: reference + "/", status_code: 200,
          content_sha256: "a".repeat(64), canonicals: [reference + "/"] },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.findings.some(
      (finding: { code: string }) => finding.code === "canonical_disagrees_with_reference")).toBe(true);
    expect(result.structuredContent.conflicting_canonical_pages).toBe(0);
  });

  it("rejects mixed hosts, unknown reference and source fragment/query tokens without leaking them", async () => {
    const secret = "FAKE_PRIVATE_INVALID_URL";
    for (const payload of [
      { reference_url: reference + "?token=" + secret, observations: [baseObservation] },
      { reference_url: reference, observations: [
        baseObservation, { url: "https://blog.example.com/Products/Widget", status_code: 200 }] },
      { reference_url: reference, observations: [baseObservation, baseObservation] },
      { reference_url: reference, observations: [
        { url: reference + "#" + secret, status_code: 200 }] },
    ]) {
      const result = await callTool("review_url_variants", payload);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("does not silently infer body equivalence from HEAD or non-200 response", async () => {
    const result = await callTool("review_url_variants", {
      reference_url: reference,
      observations: [
        { url: reference, status_code: 200, method: "HEAD" },
        { url: reference + "?raw=1", status_code: 206 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.reference_http_200).toBe(true);
    expect(result.structuredContent.matching_content_variants).toBe(0);
    expect(result.structuredContent.pages[1].response_state).toBe("other_success");
  });
});

describe("P1-13 HTTPS security evidence MCP contract", () => {
  const securePage = {
    url: "https://example.com/private/response",
    status_code: 200,
    strict_transport_security: ["max-age=31536000; includeSubDomains"],
    content_security_policy: ["default-src 'self'; frame-ancestors 'none'"],
    x_content_type_options: "nosniff",
    htmlContent: '<html><body><script src="http://cdn.example/app.js"></script>' +
      '<img src="http://cdn.example/image.jpg">' +
      '<form action="http://example.com/submit"></form></body></html>',
  };

  it("discovers and invokes hosted read-only shared security analyzer without network", async () => {
    const fetching = vi.fn();
    vi.stubGlobal("fetch", fetching);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "review_https_security")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("review_https_security", { pages: [securePage] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_https_security_evidence_only",
      pages_sampled: 1, https_observations: 1,
      mixed_blockable_declarations: 1,
      mixed_upgradable_declarations: 1,
      insecure_form_actions: 1,
      coverage_limited: true,
    });
    expect(result.structuredContent.pages[0]).toMatchObject({
      hsts_state: "enabled", csp_state: "enforced", frame_protection_observed: true,
    });
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(fetching).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/private/response");
    expect(JSON.stringify(result)).not.toContain("/submit");
  });

  it("distinguishes HTTP upgrade declaration from actual verified redirect", async () => {
    const result = await callTool("review_https_security", { pages: [
      { url: "http://example.com/", status_code: 301, location: "https://example.com/" },
      { url: "http://example.com/unsafe", status_code: 200 },
    ] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.http_observations).toBe(2);
    expect(result.structuredContent.https_redirect_declarations).toBe(1);
    expect(result.structuredContent.http_without_secure_redirect).toBe(1);
    expect(result.structuredContent.overview.status).toBe("needs_attention");
  });

  it("report-only CSP, HSTS=0 and secret header values are not mistaken for secure enforcement", async () => {
    const secret = "FAKE_SECURITY_SECRET_P113";
    const result = await callTool("review_https_security", {
      pages: [{
        ...securePage,
        strict_transport_security: ["max-age=0"],
        content_security_policy: [],
        content_security_policy_report_only: ["upgrade-insecure-requests; report-uri /" + secret],
        htmlContent: '<form action="http://example.com/submit?token=' + secret + '"></form>',
      }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.pages[0].hsts_state).toBe("disabled");
    expect(result.structuredContent.pages[0].csp_state).toBe("report_only");
    expect(result.structuredContent.pages[0].csp_upgrade_insecure_requests).toBe(false);
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("fails closed with no secrets for unsafe URL, differing host, duplicates, oversized HTML and header injection", async () => {
    const marker = "FAKE_SECRET_SECURITY_INVALID";
    for (const pages of [
      [{ ...securePage, url: "https://example.com/?key=" + marker }],
      [securePage, securePage],
      [securePage, { ...securePage, url: "https://other.example.com/" }],
      [{ ...securePage, htmlContent: "é".repeat(60_001) }],
      [{ ...securePage, strict_transport_security: ["max-age=0\r\nCookie: " + marker] }],
    ]) {
      const result = await callTool("review_https_security", { pages });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});

describe("P1-11 HTTP response directive MCP contract", () => {
  const pdf = {
    url: "https://example.com/files/report.pdf", status_code: 200,
    method: "HEAD", content_type: "application/pdf",
    x_robots_tag: ["googlebot: noindex"],
    link: ['<https://example.com/reports/latest>; rel="canonical"'],
  };

  it("discovers and invokes the offline non-HTML tool with genuine MCP RPC, no fetch", async () => {
    const fetching = vi.fn();
    vi.stubGlobal("fetch", fetching);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "review_http_directives")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("review_http_directives", { resources: [pdf] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      scope: "caller_supplied_http_headers_only", resources_sampled: 1,
      non_html_resources: 1, googlebot_noindex_resources: 1,
      conflicting_robots_resources: 0, canonical_header_resources: 1,
      coverage_limited: true,
    });
    expect(result.structuredContent.resources[0]).toMatchObject({
      mime_category: "pdf", canonical_state: "one", method: "HEAD",
    });
    expect(result.structuredContent.overview.status).toBe("partial");
    expect(fetching).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("/files/report.pdf");
    expect(JSON.stringify(result)).not.toContain("/reports/latest");
  });

  it("prioritizes contradictory indexing and canonical declarations without echoing secrets", async () => {
    const secret = "FAKE_HTTP_TOKEN_FROM_HEADERS";
    const result = await callTool("review_http_directives", {
      resources: [{
        ...pdf, x_robots_tag: ["index, noindex"],
        link: [
          "<https://example.com/a?token=" + secret + ">; rel=canonical",
          "<https://example.com/b>; rel=canonical",
        ],
        content_disposition: 'attachment; filename="' + secret + '"',
      }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.conflicting_robots_resources).toBe(1);
    expect(result.structuredContent.conflicting_canonical_resources).toBe(1);
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("fails closed for unsafe labels, mixed origins and oversized header values", async () => {
    for (const resources of [
      [{ ...pdf, url: "https://example.com/report.pdf?token=FAKE_SECRET" }],
      [pdf, pdf],
      [pdf, { ...pdf, url: "https://another.example.com/file.pdf" }],
      [{ ...pdf, x_robots_tag: ["é".repeat(1_025)] }],
      [{ ...pdf, content_disposition: "attachment\r\nSet-Cookie: FAKE_SECRET" }],
    ]) {
      const result = await callTool("review_http_directives", { resources });
      expect(result.isError).toBe(true);
      // Zod rejects malformed input *before* the tool callback, whereas
      // same-origin/dedup guards return a structured tool error.
      expect(result.structuredContent?.error || result.content?.length).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    }
  });
});

describe("public site audit", () => {
  it("keeps unrelated empty pages separate and detects unpunctuated repeated main content via MCP (#463)", async () => {
    const root = "https://example.com/";
    const paths = ["/privacy", "/contact", "/products/a", "/products/b", "/products/c"];
    const common = Array.from({ length: 115 }, (_, i) => "sharedtemplate" + i).join(" ");
    const visited: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset>" + ["/", ...paths].map((p) =>
          "<url><loc>https://example.com" + p + "</loc></url>").join("") + "</urlset>",
          { headers: { "content-type": "application/xml" } });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      const pathname = new URL(url).pathname;
      if (pathname === "/") return new Response(
        "<html lang=en><body><main><p>" + Array.from({ length: 90 }, (_, i) =>
          "homepage" + i).join(" ") + "</p></main></body></html>",
        { headers: { "content-type": "text/html" } });
      if (pathname === "/privacy" || pathname === "/contact") {
        return new Response("<html lang=en><body><main></main></body></html>",
          { headers: { "content-type": "text/html" } });
      }
      if (pathname.startsWith("/products/")) return new Response(
        "<html lang=en><body><main><p>" + common + "</p><p>"
          + Array.from({ length: 15 }, (_, i) => "unique" + pathname.slice(-1) + i).join(" ")
          + "</p></main></body></html>", { headers: { "content-type": "text/html" } });
      throw new Error("Unexpected URL " + url);
    }));
    const result = await callTool("audit_public_site", { site_url: root, max_pages: 6 });
    expect(result.isError).toBeUndefined();
    const quality = result.structuredContent.content_quality;
    expect(quality.empty_main_pages).toBe(2);
    expect(quality.repeated_boilerplate_pages).toBe(3);
    expect(quality.findings.map((f: { code: string }) => f.code)).not.toContain("content.family_empty");
    expect(quality.findings.map((f: { code: string }) => f.code)).toContain("content.family_repeated_boilerplate");
    expect(JSON.stringify(result)).not.toContain("sharedtemplate51");
    expect(visited.filter((url) => url === root || paths.some((path) => url === root.slice(0, -1) + path)))
      .toHaveLength(6);
  });

  it("returns P1-03 empty-family review evidence from a real hosted MCP request without extra fetches", async () => {
    const root = "https://example.com/";
    const a = "https://example.com/faq/a", b = "https://example.com/faq/b";
    const visited: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") return new Response(
        "User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url === "https://example.com/sitemap.xml") return new Response(
        "<urlset><url><loc>" + root + "</loc></url><url><loc>" + a + "</loc></url><url><loc>" + b + "</loc></url></urlset>",
        { headers: { "content-type": "application/xml" } });
      if (url === root) return new Response(
        "<!doctype html><html lang=en><head><title>Root</title></head><body><main>"
          + Array.from({ length: 95 }, (_, i) => "original" + i).join(" ")
          + "</main></body></html>", { headers: { "content-type": "text/html" } });
      if (url === a || url === b) return new Response(
        "<!doctype html><html lang=en><head><title>FAQ</title></head><body><nav>Useful navigation</nav><main></main></body></html>",
        { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + url);
    }));
    const response = await callTool("audit_public_site", { site_url: root, max_pages: 3 });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent.content_quality).toMatchObject({
      scope: "sampled_pages_only", sampled_pages: 3, eligible_pages: 3, empty_main_pages: 2,
    });
    const quality = response.structuredContent.content_quality;
    expect(quality.findings.map((f: { code: string }) => f.code)).toContain("content.family_empty");
    expect(response.structuredContent.overview.counts).toContainEqual(expect.objectContaining({
      key: "content_quality_findings", value: quality.total_findings,
    }));
    expect(response.structuredContent.pages.every((p: Record<string, unknown>) => !("mainContent" in p))).toBe(true);
    expect(visited.filter((url) => url === root || url === a || url === b)).toEqual([root, a, b]);
  });

  it("exposes P1-02 multilingual cluster errors in a real MCP HTTP response without extra fetches", async () => {
    const english = "https://example.com/";
    const german = "https://example.com/de/";
    const visited: string[] = [];
    const page = (language: string, refs: Array<[string, string]>, canonical: string) =>
      '<!doctype html><html lang="' + language + '"><head><title>Localized page</title>'
        + '<link rel="canonical" href="' + canonical + '">'
        + refs.map(([locale, url]) => '<link rel="alternate" hreflang="' + locale + '" href="' + url + '">').join("")
        + '</head><body><main>Localized content</main></body></html>';
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>" + english + "</loc></url><url><loc>" + german + "</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
      }
      if (url === english) return new Response(page("en", [["en", english], ["de", german]], english), { headers: { "content-type": "text/html" } });
      if (url === german) return new Response(page("de", [["de", german]], german), { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected fetch: " + url);
    }));

    const response = await callTool("audit_public_site", { site_url: english, max_pages: 2 });
    expect(response.isError).toBeUndefined();
    const evidence = response.structuredContent.multilingual_clusters;
    expect(evidence).toMatchObject({
      scope: "sampled_pages_only", sampled_pages: 2, eligible_pages: 2,
      locales_observed: 2, unobserved_targets: 0, coverage_limited: false,
    });
    expect(evidence.findings.map((item: { code: string }) => item.code))
      .toContain("multilingual.return_link_missing");
    expect(response.structuredContent.overview.status).toBe("needs_attention");
    expect(response.structuredContent.overview.counts).toContainEqual(expect.objectContaining({
      key: "multilingual_cluster_findings", value: evidence.total_findings,
    }));
    expect(response.content[0].text).toMatch(/multilingual/i);
    expect(visited.filter((url) => url === english || url === german)).toEqual([english, german]);
  });

  it("reports same-language duplicate main content through the real hosted HTTP MCP contract", async () => {
    const main = Array.from({ length: 130 }, (_, i) => `releaseconcept${i}`).join(" ");
    const document = (lang: string) => `<!doctype html><html lang="${lang}"><head><title>Content page</title></head><body><nav>${"navigation ".repeat(130)}</nav><main><p>${main}</p></main></body></html>`;
    const visited: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      visited.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/copy</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
      }
      if (url === "https://example.com/") return new Response(document("en-US"), { headers: { "content-type": "text/html" } });
      if (url === "https://example.com/copy") return new Response(document("en-GB"), { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error("Unexpected URL " + url);
    }));
    const result = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 2 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.content_duplicates).toMatchObject({
      scope: "sampled_pages_only", eligible_pages: 2, total_pairs: 1,
      pairs: [{ kind: "exact", language: "en", similarity_percent: 100 }],
    });
    expect(result.structuredContent.overview.status).toBe("needs_attention");
    expect(result.structuredContent.overview.counts).toContainEqual(expect.objectContaining({
      key: "content_duplicate_pairs", value: 1,
    }));
    expect(result.content[0].text).toMatch(/duplicate/i);
    expect(JSON.stringify(result)).not.toContain("releaseconcept50");
    expect(visited.filter((url) => url === "https://example.com/" || url === "https://example.com/copy")).toEqual([
      "https://example.com/", "https://example.com/copy",
    ]);
  });

  it("returns bounded cross-page canonical and sitemap/noindex evidence using already fetched HTML", async () => {
    const requested = new Set<string>();
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      requested.add(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url === "https://example.com/") {
        return new Response("<!doctype html><html lang='en'><head><title>Home</title></head><body><h1>Home</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/a") {
        return new Response("<!doctype html><html lang='en'><head><title>Alpha</title><link rel=canonical href='/b'></head><body><h1>Alpha</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/b") {
        return new Response("<!doctype html><html lang='en'><head><title>Beta</title><link rel=canonical href='/a'><meta name=robots content=noindex></head><body><h1>Beta</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) {
        return Response.json({ messages: [] });
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("audit_public_site", {
      site_url: "https://example.com/",
      max_pages: 3,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      pages_selected: 3,
      indexability_graph: {
        scope: "sampled_pages_only",
        sampled_pages: 3,
        sitemap_pages_sampled: 3,
        coverage_limited: false,
      },
      overview: { kind: "site", status: "needs_attention" },
    });
    expect(result.structuredContent.indexability_graph.findings.map((finding: { code: string }) => finding.code))
      .toEqual(expect.arrayContaining([
        "indexability.canonical_cycle",
        "indexability.canonical_to_noindex",
        "indexability.sitemap_noindex",
      ]));
    expect(result.structuredContent.pages.find((p: { url: string }) => p.url === "https://example.com/b").indexability)
      .toMatchObject({ canonical_url: "https://example.com/a", noindex_observed: true });
    expect(requested.has("https://example.com/a")).toBe(true);
    expect(requested.has("https://example.com/b")).toBe(true);
    expect([...requested].filter((url) => !url.startsWith("https://html5.validator.nu/")).length).toBe(5);
  });

  it("explains unsupported sitemap queries without exposing their values or claiming full coverage", async () => {
    const privateMarker = "private-sitemap-token-should-not-escape";
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") {
        return new Response(`User-agent: *\nSitemap: /map.xml?key=${privateMarker}\n`, {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/") return new Response("<!doctype html><html lang='en'><title>Example</title><body><h1>Example</h1></body></html>", { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      discovery: "root_only",
      discovery_error: "sitemap_query_unsupported",
      overview: { status: "partial" },
    });
    expect(result.structuredContent.overview.detail).toContain("query-bearing sitemap");
    expect(result.structuredContent.overview.next_action).toContain("without query parameters");
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it("does not claim a complete pass when sitemap discovery fails but the root audit succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") {
        return new Response("<!doctype html><html><head><title>Example site root</title></head><body><h1>Example</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") return new Response("Unavailable", { status: 503 });
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 1 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      discovery: "root_only",
      discovery_error: "sitemap_unavailable",
      pages_audited: 1,
      pages_selected: 1,
      score_coverage_percent: 100,
      overview: { status: "partial" },
    });
    expect(result.structuredContent.overview.next_action).toContain("sitemap");
    expect(result.structuredContent.overview.detail).toContain("not site-wide coverage");
  });

  it("explains a robots-excluded coverage gap even when the eligible page audit finishes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") {
        return new Response("<!doctype html><html lang='en'><head><title>Example</title></head><body><h1>Example</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/private</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 2 });

    expect(result.structuredContent).toMatchObject({
      pages_selected: 1,
      pages_audited: 1,
      pages_skipped_robots: 1,
      overview: { status: "partial" },
    });
    expect(result.structuredContent.overview.next_action).toContain("robots.txt");
    expect(result.structuredContent.overview.counts).toContainEqual(expect.objectContaining({
      key: "pages_skipped_robots",
      value: 1,
    }));
    expect(JSON.stringify(result)).not.toContain("https://example.com/private</loc>");
  });

  it("returns compact same-origin sitemap summaries without exposing fetched HTML", async () => {
    const privateMarker = "private-site-marker-that-must-not-be-returned";
    const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") {
        return new Response(`<!doctype html><html><head><title>Example site audit page title</title><meta name=description content='A sufficiently long description for this safe public-site audit test page, with no private content in the response.'><meta name=viewport content='width=device-width'><link rel=canonical href='https://example.com/'></head><body><h1>Example</h1><!--${privateMarker}--></body></html>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTool("audit_public_site", {
      site_url: "https://example.com/",
      max_pages: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      site_url: "https://example.com/",
      discovery: "sitemap",
      pages_selected: 1,
      pages_audited: 1,
      pages_partial: 0,
      pages_failed: 0,
      audit_health_score: expect.any(Number),
      overview: { kind: "site" },
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(result.content[0]?.text).toContain("Public site audit");
  });

  it("explains exhausted or out-of-range site audit continuation offsets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/") {
        return new Response("<!doctype html><html><head><title>Example</title></head><body><h1>Example</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) return Response.json({ messages: [] });
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const first = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 1 });
    expect(first.isError).toBeUndefined();
    const fingerprint = first.structuredContent.discovery_fingerprint;
    for (const offset of [1, 99]) {
      const continuation = await callTool("audit_public_site", {
        site_url: "https://example.com/",
        max_pages: 1,
        page_offset: offset,
        expected_discovery_fingerprint: fingerprint,
      });
      expect(continuation.isError).toBe(true);
      expect(continuation.structuredContent.error).toContain("Invalid site audit continuation");
      expect(continuation.structuredContent.error).toContain("restart with page_offset 0");
    }
  });

  it("keeps failed validation guidance visible alongside a pending site-audit batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (target: RequestInfo | URL) => {
      const url = String(target);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response("<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/next</loc></url></urlset>", {
          headers: { "content-type": "application/xml" },
        });
      }
      if (url === "https://example.com/") {
        return new Response("<!doctype html><html lang='en'><title>Example</title><body><h1>Example</h1></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.startsWith("https://html5.validator.nu/")) throw new Error("validator unavailable");
      throw new Error(`Unexpected fetch target: ${url}`);
    }));

    const result = await callTool("audit_public_site", { site_url: "https://example.com/", max_pages: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      pages_partial: 1,
      pages_audited: 0,
      next_page_offset: 1,
      overview: { status: "partial" },
    });
    const nextAction = result.structuredContent.overview.next_action;
    expect(nextAction).toContain("page_offset 1");
    expect(nextAction).toContain("Review partial and failed page coverage");
  });
});

describe("hosted site audit comparison", () => {
  function snapshot(issueCount: number, options: Record<string, unknown> = {}) {
    const url = "https://example.com/";
    return {
      site_url: url,
      sitemap_url: url + "sitemap.xml",
      discovery: "sitemap",
      pages_discovered: 1,
      pages_selected: 1,
      pages_audited: 1,
      pages_partial: 0,
      pages_failed: 0,
      pages_skipped_robots: 0,
      truncated: false,
      discovery_fingerprint: "a".repeat(64),
      score_coverage_percent: 100,
      pages: [{
        url, fetched_url: url, status: issueCount > 0 ? "needs_attention" : "passed",
        http_status: 200, redirects_followed: 0, page_fetched: true,
        html_validation_status: "completed",
        html_errors: 0, html_warnings: 0, seo_errors: issueCount, seo_warnings: 0,
        schema_errors: 0, schema_warnings: 0, notes: 0,
        health_score: 100 - issueCount * 12, top_findings: [],
      }],
      issue_groups: issueCount > 0 ? [{
        code: "seo.title.missing", severity: "error", category: "SEO",
        message: "Page title is missing", affected_pages: 1, example_urls: [url],
      }] : [],
      issue_groups_truncated: false,
      ...options,
    };
  }

  const historicalVersions = (...counts: number[]) => counts.map((issueCount, index) => ({
    saved_at: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
    snapshot: snapshot(issueCount),
  }));

  it("P2-02: hosted MCP previews bounded rules without sending, storing or fetching", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("No request in manual monitoring preview"); });
    vi.stubGlobal("fetch", fetchSpy);
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "preview_regression_alerts")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const result = await callTool("preview_regression_alerts", {
      dry_run: true, versions: historicalVersions(0, 2),
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      scope: "manual_sampled_regression_alert_preview_only",
      source: "caller_supplied_snapshots",
      status: "preview_ready", candidate_count: 2,
      review_only_count: 0, suppressed_count: 0,
      manually_invoked: true, dry_run: true,
      scheduler_enabled: false, delivery_enabled: false,
      notifications_sent: 0, external_integrations_used: false,
      overview: { kind: "site", status: "needs_attention" },
    });
    expect(result.structuredContent.rules.map((r: { rule: string }) => r.rule))
      .toEqual(["regressed_pages", "net_error_increase", "net_warning_increase", "coverage_loss", "sitemap_drift"]);
    expect(result.content[0].text).toContain("No notifications");
    expect(JSON.stringify(result)).not.toContain("https://example.com/");
    expect(JSON.stringify(result)).not.toContain("Page title is missing");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("P2-02: user policy can suppress small regressions without changing defaults for next call", async () => {
    const a = await callTool("preview_regression_alerts", {
      versions: historicalVersions(0, 2),
      policy: { min_regressed_pages: 2, min_net_error_increase: 3 },
    });
    expect(a.isError).not.toBe(true);
    expect(a.structuredContent.status).toBe("no_candidate");
    expect(a.structuredContent.candidate_count).toBe(0);
    const b = await callTool("preview_regression_alerts", {
      versions: historicalVersions(0, 2),
    });
    expect(b.structuredContent.candidate_count).toBe(2);
    expect(b.structuredContent.policy.min_regressed_pages).toBe(1);
    expect(b.structuredContent.delivery_enabled).toBe(false);
  });

  it("P2-02: incomplete coverage and sitemap drift yield review-only, not false defect alarms", async () => {
    const versions = historicalVersions(2, 0);
    versions[1].snapshot = snapshot(0, {
      discovery_fingerprint: "b".repeat(64), pages_partial: 1, pages_audited: 0,
      pages: [{
        ...snapshot(0).pages[0], status: "partial",
        html_validation_status: "timeout", health_score: undefined,
      }],
    });
    const r = await callTool("preview_regression_alerts", { versions });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      status: "review_only", candidate_count: 0,
      review_only_count: 2, suppressed_count: 3, notifications_sent: 0,
      latest_comparability: "partial",
    });
    expect(r.structuredContent.rules.find((x: { rule: string }) => x.rule === "coverage_loss").decision)
      .toBe("review_only");
  });

  it("P2-02: persistent regressions require actual consecutive comparable samples", async () => {
    const r = await callTool("preview_regression_alerts", {
      versions: historicalVersions(0, 1, 2),
      policy: { consecutive_regressing_steps: 2 },
    });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent.rules.find((x: { rule: string }) => x.rule === "regressed_pages").decision)
      .toBe("preview_candidate");
    const tooShort = await callTool("preview_regression_alerts", {
      versions: historicalVersions(0, 2),
      policy: { consecutive_regressing_steps: 3 },
    });
    expect(tooShort.structuredContent.rules.find((x: { rule: string }) => x.rule === "regressed_pages").reason_code)
      .toBe("insufficient_streak_history");
  });

  it("P2-02: fail closed for non-dry-run, invalid policy, foreign origins and saved IDs", async () => {
    const secret = "PRIVATE_WEBHOOK_TOKEN_P202";
    const versions = historicalVersions(0, 2);
    for (const input of [
      { versions, dry_run: false },
      { versions, policy: { min_regressed_pages: -1 } },
      { versions, policy: { webhook_url: "https://private.example/?key=" + secret } },
      { versions: [versions[0], { ...versions[1], snapshot: {
        ...versions[1].snapshot, site_url: "https://elsewhere.example/",
      } }] },
      { ids: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] },
    ]) {
      const response = await callTool("preview_regression_alerts", input);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain(secret);
    }
  });

  it("P2-01: discovers and invokes hosted historical comparison fully offline with stable cohort trends", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Historical comparison must be offline"); }));
    const tools = await listTools();
    expect(tools.find((tool) => tool.name === "compare_historical_audits")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    const r = await callTool("compare_historical_audits", {
      versions: historicalVersions(0, 2, 1),
    });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({
      scope: "historical_compact_audit_versions_only",
      source: "caller_supplied_snapshots",
      versions_compared: 3, comparisons_made: 2,
      status: "comparable_sample",
      total_regressed_page_transitions: 1,
      total_improved_page_transitions: 1,
      complete_stable_cohort_pages: 1,
      coverage_limited: true,
      overview: { kind: "site", status: "needs_attention" },
    });
    expect(r.structuredContent.historical_points.map(
      (point: { cohort_errors: number }) => point.cohort_errors)).toEqual([0, 2, 1]);
    expect(JSON.stringify(r)).not.toContain("https://example.com/");
    expect(JSON.stringify(r)).not.toContain("Page title is missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("P2-01: sitemap drift and validator failure remain partial, with unknown group changes", async () => {
    const versions = historicalVersions(1, 0);
    versions[1].snapshot = snapshot(0, {
      discovery_fingerprint: "b".repeat(64),
      pages_partial: 1, pages_audited: 0,
      pages: [{
        ...snapshot(0).pages[0],
        status: "partial", health_score: undefined,
        html_validation_status: "timeout",
      }],
    });
    const r = await callTool("compare_historical_audits", { versions });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent.status).toBe("partial");
    expect(r.structuredContent.consecutive_changes[0]).toMatchObject({
      coverage_lost_pages: 1, improved_pages: 0,
      issue_group_comparison_available: false,
      no_longer_observed_groups: null,
    });
    expect(r.structuredContent.cohort_metrics_available).toBe(false);
  });

  it("P2-01: rejects invalid chronological order and different site origins without echoing inputs", async () => {
    const versions = historicalVersions(0, 1);
    const secret = "FAKE_SENSITIVE_HISTORY_TOKEN";
    for (const invalid of [
      [...versions].reverse(),
      [{ ...versions[0], snapshot: { ...snapshot(0), site_url: "https://another.example/" } }, versions[1]],
      [{ ...versions[0], snapshot: { ...snapshot(0), pages: [
        { ...snapshot(0).pages[0], url: "https://example.com/?token=" + secret },
      ] } }, versions[1]],
      [{ ...versions[0], snapshot: { ...snapshot(0), discovery_fingerprint: "malformed" } }, versions[1]],
    ]) {
      const result = await callTool("compare_historical_audits", { versions: invalid });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("P2-01: hosted storage remains stateless and tool cannot read local version IDs", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).not.toContain("audit.history");
    const r = await callTool("compare_historical_audits", { ids: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ] });
    expect(r.isError).toBe(true);
  });

  it("exposes a genuinely offline, read-only comparison of previous site audit results", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network should be contacted"); }));
    const result = await callTool("compare_site_audits", {
      baseline: snapshot(0),
      current: snapshot(1),
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "comparable",
      pages_compared: 1,
      regressed_pages: 1,
      issue_group_comparison_available: true,
      newly_observed_issue_groups: [{ code: "seo.title.missing" }],
      overview: { kind: "site", status: "needs_attention" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks unsupported resolution claims for drifted discoveries", async () => {
    const result = await callTool("compare_site_audits", {
      baseline: snapshot(1),
      current: snapshot(0, { discovery_fingerprint: "b".repeat(64), truncated: true }),
    });
    expect(result.structuredContent).toMatchObject({
      status: "partial", issue_group_comparison_available: false,
      no_longer_observed_issue_groups: [],
      overview: { status: "partial" },
    });
  });

  it("rejects malformed site audit snapshots at the tool boundary", async () => {
    const result = await callTool("compare_site_audits", {
      baseline: { ...snapshot(0), discovery_fingerprint: "not-a-sha256" },
      current: snapshot(1),
    });
    expect(result.isError).toBe(true);
  });

  it("does not leak one client's comparison data into a different client's request", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline comparison must not fetch"); }));
    const forSite = (site_url: string, issueCount: number) => {
      const audit = snapshot(issueCount);
      return {
        ...audit,
        site_url,
        sitemap_url: `${site_url}sitemap.xml`,
        pages: audit.pages.map((page) => ({ ...page, url: site_url, fetched_url: site_url })),
        issue_groups: audit.issue_groups.map((group) => ({ ...group, example_urls: [site_url] })),
      };
    };
    const alpha = await callTool("compare_site_audits", {
      baseline: forSite("https://alpha.example/", 0),
      current: forSite("https://alpha.example/", 1),
    }, { origin: "https://chatgpt.com", "cf-connecting-ip": "198.51.100.31" });
    expect(alpha.isError).not.toBe(true);
    expect(alpha.structuredContent.baseline_site_url).toBe("https://alpha.example/");
    expect(alpha.structuredContent.regressed_pages).toBe(1);

    const beta = await callTool("compare_site_audits", {
      baseline: forSite("https://beta.example/", 0),
      current: forSite("https://beta.example/", 0),
    }, { origin: "https://chatgpt.com", "cf-connecting-ip": "198.51.100.32" });
    expect(beta.isError).not.toBe(true);
    expect(beta.structuredContent.baseline_site_url).toBe("https://beta.example/");
    expect(beta.structuredContent.regressed_pages).toBe(0);
    expect(JSON.stringify(beta.structuredContent)).not.toContain("alpha.example");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
