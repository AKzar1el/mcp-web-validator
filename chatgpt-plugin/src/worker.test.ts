import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";

const context = { props: {} } as ExecutionContext;

function createEnv(success = true) {
  return {
    MCP_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success })),
    },
  } as unknown as Env;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request("https://web-validator-mcp.digestseo.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP HTTP boundary", () => {
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
  it("discovers seven accurately annotated tools", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "validate_html",
      "validate_css",
      "audit_seo_metadata",
      "validate_schema_markup",
      "check_broken_links",
      "generate_validation_report",
      "audit_public_webpage",
    ]);

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
          html: "<!doctype html><html><head><title>Hi</title></head><body><img src=x></body></html>",
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
      { key: "errors", label: "Errors", value: 5, tone: "error" },
      { key: "warnings", label: "Warnings", value: 3, tone: "warning" },
      { key: "notes", label: "Notes", value: 1, tone: "info" },
      { key: "checks_passed", label: "Checks passed", value: 0, tone: "success" },
    ]);
  });
});

describe("polished tool responses", () => {
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
    expect(text.indexOf("Error · Line 2, column 4")).toBeLessThan(text.indexOf("Warning · Line 8"));
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
      html: "<!doctype html><html><head></head><body><h1>Test</h1></body></html>",
    });

    expect(css.structuredContent.overview.counts).toEqual([
      { key: "syntax_errors", label: "Syntax errors", value: 1, tone: "error" },
    ]);
    expect(seo.structuredContent.overview.counts).toEqual([
      { key: "errors", label: "Errors", value: 3, tone: "error" },
      { key: "warnings", label: "Warnings", value: 1, tone: "warning" },
      { key: "notes", label: "Notes", value: 1, tone: "info" },
    ]);
  });

  it("separates healthy, redirected, and unreachable links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 301 }))
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
      healthy_links: 1,
      redirects: 1,
      unreachable_links: 1,
      overview: {
        status: "needs_attention",
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
