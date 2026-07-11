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
  });
});
