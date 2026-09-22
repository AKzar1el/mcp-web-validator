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
      code: "seo.h1.missing",
      severity: "warning",
      category: "SEO",
      message: "No <h1> heading found. Review whether the page has a clear main heading and a meaningful heading hierarchy.",
    });

    const multiple = auditSeoMetadata("<html><head></head><body><h1>One</h1><h1>Two</h1></body></html>");
    const multipleH1 = multiple.issues.find((issue) => /h1/i.test(issue.message));
    expect(multipleH1).toEqual({
      code: "seo.h1.multiple",
      severity: "info",
      category: "SEO",
      message: "Found multiple (2) <h1> headings. Multiple H1s are not inherently an SEO error; ensure the heading hierarchy is meaningful and the main visual title is clear.",
    });
  });

  it("recognizes canonical rel tokens case-insensitively and rejects empty href values", () => {
    const valid = auditSeoMetadata('<link rel="alternate CANONICAL" href="https://example.com/page">');
    expect(valid.issues.find((issue) => issue.code === "seo.canonical.missing")).toBeUndefined();

    const absent = auditSeoMetadata("<html><head></head><body><h1>Page</h1></body></html>");
    expect(absent.issues.find((issue) => issue.code === "seo.canonical.missing")?.severity).toBe("info");

    const empty = auditSeoMetadata('<link rel="canonical" href="   ">');
    expect(empty.issues.find((issue) => issue.code === "seo.canonical.missing")).toEqual({
      code: "seo.canonical.missing",
      severity: "warning",
      category: "SEO",
      message: "Canonical link is present but its href is empty. Provide a usable canonical target or remove the declaration.",
    });
  });

  it("reports ambiguous and Google-ignored canonical declarations", () => {
    const multiple = auditSeoMetadata([
      "<html><head>",
      '<link rel="canonical" href="https://example.com/a">',
      '<link rel="canonical" href="https://example.com/b">',
      "</head><body></body></html>",
    ].join(""));
    expect(multiple.issues.find((issue) => issue.code === "seo.canonical.multiple")).toEqual({
      code: "seo.canonical.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple usable canonical link relations are declared. Keep one unambiguous canonical target.",
    });

    for (const attribute of ['hreflang="en"', 'lang="en"', 'media="print"', 'type="text/html"']) {
      const ignored = auditSeoMetadata(`<link rel="canonical" href="https://example.com/page" ${attribute}>`);
      expect(ignored.issues.find((issue) => issue.code === "seo.canonical.unusable")).toEqual({
        code: "seo.canonical.unusable",
        severity: "warning",
        category: "SEO",
        message: "Canonical link is present but uses attributes Google ignores for canonicalization. Use a plain rel=\"canonical\" link in <head>.",
      });
    }
  });

  it("reports noindex-equivalent robots directives that affect Google Search", () => {
    for (const html of [
      '<meta name="robots" content="NOINDEX, follow">',
      '<body><meta name="GoogleBot" content="none"></body>',
      '<meta name="robots" content="index, follow"><meta name="googlebot" content="noindex">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "seo.robots.noindex")).toEqual({
        code: "seo.robots.noindex",
        severity: "warning",
        category: "SEO",
        message: "A robots directive prevents Google from indexing this page. Confirm that noindex is intentional.",
      });
    }

    const allowed = auditSeoMetadata('<meta name="robots" content="index, follow, max-image-preview:none">');
    expect(allowed.issues.find((issue) => issue.code === "seo.robots.noindex")).toBeUndefined();
  });

  it("keeps title and meta-description length heuristics as informational guidance", () => {
    const result = auditSeoMetadata([
      "<html><head>",
      `<title>${"T".repeat(61)}</title>`,
      `<meta name="description" content="${"D".repeat(161)}">`,
      '<meta name="viewport" content="width=device-width">',
      '<link rel="canonical" href="https://example.com/page">',
      '<meta property="og:title" content="Page">',
      '<meta property="og:image" content="https://example.com/image.png">',
      "</head><body><h1>Page</h1></body></html>",
    ].join(""));

    expect(result.issues.find((issue) => issue.code === "seo.title.length")?.severity).toBe("info");
    expect(result.issues.find((issue) => issue.code === "seo.meta_description.length")?.severity).toBe("info");
    expect(result.counts.warning).toBe(0);
  });

  it("matches the standard meta description name ASCII case-insensitively", () => {
    const description = "D".repeat(140);
    const result = auditSeoMetadata(`<meta name="Description" content="${description}">`);

    expect(result.issues.find((issue) => issue.code === "seo.meta_description.missing_or_empty")).toBeUndefined();
    expect(result.issues.find((issue) => issue.code === "seo.meta_description.length")).toBeUndefined();
  });

  it("matches the viewport meta name ASCII case-insensitively", () => {
    const result = auditSeoMetadata('<meta name="ViewPort" content="width=device-width">');

    expect(result.issues.find((issue) => issue.code === "seo.viewport.missing")).toBeUndefined();
  });

  it.each([
    '<meta name="viewport">',
    '<meta name="viewport" content="   ">',
  ])("reports a viewport meta tag without usable content: %s", (html) => {
    const result = auditSeoMetadata(html);

    expect(result.issues).toContainEqual({
      code: "seo.viewport.unusable",
      severity: "error",
      category: "SEO",
      message: "Viewport meta tag is present but its content is empty. Provide viewport settings such as width=device-width.",
    });
  });

  it("ignores body and SVG metadata lookalikes outside the document head", () => {
    const description = "D".repeat(140);
    const result = auditSeoMetadata([
      "<html><head></head><body>",
      '<svg><title>Decorative icon title that is not the page title</title></svg>',
      `<meta name="description" content="${description}">`,
      '<meta name="viewport" content="width=device-width">',
      '<link rel="canonical" href="https://example.com/body-only">',
      '<meta property="og:title" content="Body-only title">',
      '<meta property="og:image" content="https://example.com/body-only.png">',
      "<h1>Page heading</h1>",
      "</body></html>",
    ].join(""));

    expect(result.issues.find((issue) => issue.code === "seo.title.missing_or_empty")?.severity).toBe("error");
    expect(result.issues.find((issue) => issue.code === "seo.meta_description.missing_or_empty")?.severity).toBe("error");
    expect(result.issues.find((issue) => issue.code === "seo.viewport.missing")?.severity).toBe("error");
    expect(result.issues.find((issue) => issue.code === "seo.canonical.missing")?.severity).toBe("info");
    expect(result.issues.find((issue) => issue.code === "seo.open_graph.missing")?.severity).toBe("info");
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
    expect(result.issues[0]?.code).toBe("schema.jsonld.invalid_json");
  });
  it("rejects non-document top-level JSON-LD shapes", () => {
    const invalid = validateSchemaMarkup([
      '<script type="application/ld+json">42</script>',
      '<script type="application/ld+json">[42]</script>',
    ].join(""));
    expect(invalid.total).toBe(2);
    expect(invalid.issues.map((issue) => issue.code)).toEqual([
      "schema.jsonld.invalid_document",
      "schema.jsonld.invalid_document",
    ]);

    const valid = validateSchemaMarkup([
      '<script type="application/ld+json">{}</script>',
      '<script type="application/ld+json">[{}]</script>',
    ].join(""));
    expect(valid.total).toBe(0);
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

  it("resolves relative links from the first document base instead of base_url", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkBrokenLinks(
      '<base href="https://assets.example.org/docs/"><a href="guide">Guide</a>',
      "https://example.com/page",
      1,
    )).resolves.toEqual([
      { url: "https://assets.example.org/docs/guide", status: 204, ok: true, message: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://assets.example.org/docs/guide"),
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });

  it("does not resolve relative links through the fallback when the document base is unsafe", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkBrokenLinks(
      '<base href="http://127.0.0.1/private/"><a href="secret">Secret</a><a href="https://example.org/public">Public</a>',
      "https://example.com/page",
      2,
    )).resolves.toEqual([
      { url: "https://example.org/public", status: 204, ok: true, message: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://example.org/public"),
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });
});
