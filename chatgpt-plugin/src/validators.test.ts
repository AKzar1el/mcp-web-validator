import { afterEach, describe, expect, it, vi } from "vitest";
import { auditSeoMetadata, checkBrokenLinks, toPublicHttpUrl, validateSchemaMarkup } from "./audits";
import { validateHtml, validateHtmlDetailed } from "./validators";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateHtml", () => {
  it("preserves Nu errors, warning subtypes, and informational messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          messages: [
            { type: "error", message: "Missing alt", lastLine: 3, lastColumn: 9 },
            { type: "info", subType: "warning", message: "Add lang", lastLine: 1 },
            { type: "info", message: "Informational" },
          ],
        }),
      ),
    );

    await expect(validateHtml("<html></html>")).resolves.toEqual([
      { type: "error", message: "Missing alt", line: 3, column: 9 },
      { type: "warning", message: "Add lang", line: 1, column: undefined },
      { type: "info", message: "Informational", line: undefined, column: undefined },
    ]);
  });

  it("reports the total when Nu diagnostics exceed the returned cap", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      type: "error",
      message: `Error ${index + 1}`,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages })));

    const result = await validateHtmlDetailed("<html></html>");

    expect(result.messages).toHaveLength(200);
    expect(result.total).toBe(205);
    expect(result.truncated).toBe(true);
    expect(result.counts).toEqual({ error: 205, warning: 0, info: 0 });
  });

  it("rejects a malformed Nu messages payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages: { type: "error" } })));

    await expect(validateHtmlDetailed("<html></html>")).rejects.toThrow("invalid messages payload");
  });

  it("rejects a Nu payload that omits messages instead of reporting a clean result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));

    await expect(validateHtmlDetailed("<html></html>")).rejects.toThrow("invalid messages payload");
  });
});

describe("public URL filtering", () => {
  it.each([
    "http://localhost./",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://192.0.2.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://[::1]/",
    "http://[fe90::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://service.internal/",
  ])("rejects non-public destination %s", (url) => {
    expect(toPublicHttpUrl(url)).toBeUndefined();
  });

  it("accepts ordinary public HTTPS URLs", () => {
    expect(toPublicHttpUrl("https://example.com/path")?.toString()).toBe("https://example.com/path");
  });
});

describe("bounded audits", () => {
  it("uses evidence-correct H1 guidance without exact-one-heading penalties", () => {
    const missing = auditSeoMetadata("<html><head></head><body></body></html>");
    const missingH1 = missing.issues.find((issue) => /h1/i.test(issue.message));
    expect(missingH1).toEqual({
      severity: "warning",
      category: "SEO",
      message: "No <h1> heading found. Review whether the page has a clear main heading and a meaningful heading hierarchy.",
    });

    const multiple = auditSeoMetadata("<html><head></head><body><h1>One</h1><h1>Two</h1></body></html>");
    const multipleH1 = multiple.issues.find((issue) => /h1/i.test(issue.message));
    expect(multipleH1).toEqual({
      severity: "info",
      category: "SEO",
      message: "Found multiple (2) <h1> headings. Multiple H1s are not inherently an SEO error; ensure the heading hierarchy is meaningful and the main visual title is clear.",
    });
  });

  it("caps SEO findings while retaining the total", () => {
    const html = `<html><head><title>${"A".repeat(40)}</title><meta name="description" content="${"D".repeat(140)}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com"><meta property="og:title" content="x"><meta property="og:image" content="x"></head><body><h1>Title</h1>${"<img src=x>".repeat(150)}</body></html>`;
    const result = auditSeoMetadata(html);
    expect(result.issues).toHaveLength(100);
    expect(result.total).toBe(150);
    expect(result.truncated).toBe(true);
  });

  it("caps JSON-LD findings while retaining the total", () => {
    const html = `<html><body>${'<script type="application/ld+json">{</script>'.repeat(120)}</body></html>`;
    const result = validateSchemaMarkup(html);
    expect(result.issues).toHaveLength(100);
    expect(result.total).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.blocksChecked).toBe(120);
  });

  it("recognizes JSON-LD media-type parameters without matching unrelated script types", () => {
    const html = [
      '<script type="Application/LD+JSON; profile=https://www.w3.org/ns/json-ld#frame">{</script>',
      '<script type="application/ld+jsonish">{</script>',
    ].join("");
    const result = validateSchemaMarkup(html);
    expect(result.blocksChecked).toBe(1);
    expect(result.total).toBe(1);
    expect(result.issues).toHaveLength(1);
  });
});

describe("link checks", () => {
  it("falls back from a rejected HEAD request to a bounded GET request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkBrokenLinks('<a href="https://example.com/ok">ok</a>', undefined, 1)).resolves.toEqual([
      { url: "https://example.com/ok", status: 200, ok: true, message: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD", redirect: "manual" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      "user-agent": expect.stringContaining("DigestSEO-Web-Validator"),
    });
  });
});
