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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
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

  it("reports HTML truncation without changing the legacy errors array", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      type: "error",
      message: `Error ${index + 1}`,
      lastLine: index + 1,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages })));

    const result = await callTool("validate_html", { html: "<p>test</p>" });

    expect(result.structuredContent.errors).toHaveLength(200);
    expect(result.structuredContent).toMatchObject({
      total_messages: 205,
      truncated: true,
      overview: { total: 205, shown: 200, truncated: true },
    });
    expect(result.content[0]?.text).toContain("showing the first 200");
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
      errors: [],
      total_messages: 0,
      overview: { kind: "html", status: "failed" },
    });
    expect(result.content[0]?.text).toContain("HTML validation could not be completed");
  });
});
