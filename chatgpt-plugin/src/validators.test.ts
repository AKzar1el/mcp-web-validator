import { afterEach, describe, expect, it, vi } from "vitest";
import { auditSeoMetadata, checkBrokenLinks, toPublicHttpUrl, validateSchemaMarkup } from "./audits";
import { validateHtml, validateHtmlDetailed } from "./validators";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateHtml", () => {
  it("preserves XHTML media type when sending XML-syntax HTML to Nu", async () => {
    const fetchMock = vi.fn(async (_target: RequestInfo | URL, _init?: RequestInit) => Response.json({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await validateHtmlDetailed(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Example</title></head><body /></html>',
      "application/xhtml+xml",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      "content-type": "application/xhtml+xml; charset=utf-8",
    });
  });
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
    "http://192.0.0.8/",
    "http://192.0.0.11/",
    "http://192.0.2.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://[::1]/",
    "http://[2001:100::1]/",
    "http://[3fff::1]/",
    "http://[fe90::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://service.internal/",
  ])("rejects non-public destination %s", (url) => {
    expect(toPublicHttpUrl(url)).toBeUndefined();
  });

  it("accepts ordinary public HTTPS URLs", () => {
    expect(toPublicHttpUrl("https://example.com/path")?.toString()).toBe("https://example.com/path");
    expect(toPublicHttpUrl("https://192.0.0.9/")?.toString()).toBe("https://192.0.0.9/");
    expect(toPublicHttpUrl("https://192.0.0.10/")?.toString()).toBe("https://192.0.0.10/");
    expect(toPublicHttpUrl("https://[2606:4700:4700::1111]/")?.toString()).toBe(
      "https://[2606:4700:4700::1111]/",
    );
    expect(toPublicHttpUrl("https://[2001:1::1]/")?.toString()).toBe("https://[2001:1::1]/");
    for (const url of [
      "https://[2001:1::2]/",
      "https://[2001:1::3]/",
      "https://[2001:3::1]/",
      "https://[2001:4:112::1]/",
      "https://[2001:20::1]/",
      "https://[2001:30::1]/",
    ]) {
      expect(toPublicHttpUrl(url)?.toString()).toBe(url);
    }
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

  it("requires usable values for all Open Graph basic properties", () => {
    const complete = auditSeoMetadata([
      "<html><head>",
      '<meta property="og:title" content="Example">',
      '<meta property="og:type" content="website">',
      '<meta property="og:image" content="https://example.com/image.png">',
      '<meta property="og:image" content="https://example.com/image-2.png">',
      '<meta property="og:url" content="https://example.com/">',
      "</head><body></body></html>",
    ].join(""));
    expect(complete.issues.find((issue) => issue.code === "seo.open_graph.missing")).toBeUndefined();

    for (const html of [
      '<meta property="og:title" content="Example"><meta property="og:image" content="https://example.com/image.png">',
      '<meta property="og:title" content="Example"><meta property="og:type" content="website"><meta property="og:image" content="   "><meta property="og:url" content="https://example.com/">',
    ]) {
      expect(auditSeoMetadata(html).issues).toContainEqual({
        code: "seo.open_graph.missing",
        severity: "info",
        category: "SEO",
        message: "Open Graph basic metadata is incomplete or empty. Provide non-empty og:title, og:type, og:image, and og:url values.",
      });
    }
  });

  it("requires page language only for explicitly authored HTML documents", () => {
    for (const html of [
      "<html><head><title>Example</title></head><body></body></html>",
      '<html lang=""><head><title>Example</title></head><body></body></html>',
      '<html lang="   "><head><title>Example</title></head><body></body></html>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.page_language.missing_or_empty"))
        .toEqual({
          code: "accessibility.page_language.missing_or_empty",
          severity: "error",
          category: "Accessibility",
          message: "The document <html> element needs a non-empty lang attribute so assistive technologies can determine the page language.",
        });
    }

    for (const html of [
      '<html lang="en"><head><title>Example</title></head><body></body></html>',
      "<title>HTML fragment</title><p>Fragment content</p>",
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.page_language.missing_or_empty"))
        .toBeUndefined();
    }
  });

  it("requires an explicitly authored page language to have a known primary subtag", () => {
    for (const [lang, primary] of [
      ["em-US", "em"],
      ["#1", "#1"],
      ["eng", "eng"],
      ["i-lux", "i"],
    ]) {
      expect(auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`).issues
        .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"))
        .toEqual({
          code: "accessibility.page_language.invalid_primary_subtag",
          severity: "error",
          category: "Accessibility",
          message: `The document <html> lang attribute uses unknown primary language subtag "${primary}". Use a primary language subtag registered by IANA.`,
        });
    }

    for (const lang of ["FR", "en-US-GB", "de-hello", "osd", "qaa"]) {
      expect(auditSeoMetadata(`<html lang="${lang}"><head><title>Example</title></head><body></body></html>`).issues
        .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"))
        .toBeUndefined();
    }

    expect(auditSeoMetadata("<title>HTML fragment</title><p>Fragment content</p>").issues
      .find((issue) => issue.code === "accessibility.page_language.invalid_primary_subtag"))
      .toBeUndefined();
  });

  it("image submit buttons require a non-empty accessible name", () => {
    for (const html of [
      '<input type="image" src="search.png">',
      '<input type="IMAGE" src="search.png" alt="">',
      '<input type="image" src="search.png" alt="   ">',
      '<input type="image" src="search.png" aria-label="   ">',
      '<span id="blank-label">   </span><input type="image" src="search.png" aria-labelledby="blank-label">',
      '<template><span id="template-label">Search</span></template><input type="image" src="search.png" aria-labelledby="template-label">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"))
        .toEqual({
          code: "accessibility.input_image_alt.missing_or_empty",
          severity: "error",
          category: "Accessibility",
          message: "Image submit buttons need a non-empty accessible name. Provide alt text or another supported label such as aria-label, aria-labelledby, or title.",
        });
    }

    for (const html of [
      '<input type="image" src="search.png" alt="Search">',
      '<input type="image" src="search.png" aria-label="Search">',
      '<input type="image" src="search.png" alt="" title="Search">',
      '<span id="search-label">Search</span><input type="image" src="search.png" aria-labelledby="search-label">',
      '<input type="text" alt="">',
      '<template><input type="image" src="search.png"></template>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"))
        .toBeUndefined();
    }
  });

  it("accepts an explicit empty alt on ordinary decorative images", () => {
    expect(auditSeoMetadata('<img src="divider.png" alt="">').issues
      .find((issue) => issue.code === "accessibility.image_alt.empty"))
      .toBeUndefined();

    expect(auditSeoMetadata('<img src="missing.png">').issues
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
      .toBe("error");
    expect(auditSeoMetadata('<img src="blank.png" alt="   ">').issues
      .find((issue) => issue.code === "accessibility.image_alt.empty")?.severity)
      .toBe("info");
  });

  it("requires a non-empty accessible name when an empty-alt image keeps an explicit semantic image role", () => {
    for (const html of [
      '<img src="logo.png" alt="" role="img">',
      '<img src="logo.png" alt="" role="image">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
        .toBe("error");
    }

    for (const html of [
      '<img src="divider.png" alt="">',
      '<img src="divider.png" alt="" role="none">',
      '<img src="divider.png" alt="" role="presentation">',
      '<img src="logo.png" alt="" role="img" aria-label="Company logo">',
      '<span id="logo-label">Company logo</span><img src="logo.png" alt="" role="image" aria-labelledby="logo-label">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }
  });

  it("accepts alternate accessible-name sources on ordinary images", () => {
    for (const html of [
      '<img src="chart.png" aria-label="Quarterly revenue chart">',
      '<span id="chart-label">Quarterly revenue chart</span><img src="chart.png" aria-labelledby="chart-label">',
      '<img src="chart.png" title="Quarterly revenue chart">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }

    expect(auditSeoMetadata('<img src="unnamed.png">').issues
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
      .toBe("error");
  });

  it("requires accessible names on generic elements with semantic image roles", () => {
    for (const html of [
      '<div role="img"></div>',
      '<span role="image"></span>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
        .toBe("error");
    }

    for (const html of [
      '<div role="img" aria-label="Company logo"></div>',
      '<span id="chart-label">Revenue chart</span><div role="image" aria-labelledby="chart-label"></div>',
      '<span role="img" title="Status icon"></span>',
      '<div role="img" aria-hidden="true"></div>',
      '<div aria-hidden="true"><span role="image"></span></div>',
      '<template><div role="img"></div></template>',
      '<div></div>',
      '<span role="button"></span>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }
  });

  it("uses the first valid non-abstract ARIA role token for image applicability", () => {
    for (const html of [
      '<div role="not-a-role img"></div>',
      '<span role="command image"></span>',
      '<svg role="bogus graphics-document"></svg>',
      '<img src="logo.png" alt="" role="range img">',
      '<img src="focusable.png" role="bogus presentation" tabindex="0">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
        .toBe("error");
    }

    for (const html of [
      '<div role="button img"></div>',
      '<div role="sectionheader img"></div>',
      '<div role="doc-cover img"></div>',
      '<svg role="graphics-object graphics-symbol"></svg>',
      '<img src="divider.png" role="bogus presentation">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }
  });
  it("requires accessible names on explicit SVG image roles", () => {
    for (const html of [
      '<svg role="img"></svg>',
      '<svg role="graphics-document"><title>   </title></svg>',
      '<svg><circle role="graphics-symbol"></circle></svg>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
        .toBe("error");
    }

    for (const html of [
      '<svg role="img"><title>Quarterly chart</title></svg>',
      '<svg role="graphics-document" aria-label="Process diagram"></svg>',
      '<span id="chart-label">Revenue chart</span><svg role="img" aria-labelledby="chart-label"></svg>',
      '<svg role="img" aria-hidden="true"></svg>',
      '<div aria-hidden="true"><svg role="graphics-document"></svg></div>',
      '<template><svg role="img"></svg></template>',
      '<svg><circle role="graphics-symbol" aria-label="Data point"></circle></svg>',
      '<svg></svg>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }
  });
  it("treats unambiguous presentational images as outside accessible-name applicability", () => {
    for (const html of [
      '<img src="spacer.png" role="none">',
      '<img src="divider.png" role="presentation">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }

    for (const html of [
      '<img src="focusable.png" role="none" tabindex="0">',
      '<span id="details">Details</span><img src="described.png" role="presentation" aria-describedby="details">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
        .toBe("error");
    }
  });

  it("excludes aria-hidden images and image submit buttons from accessible-name checks", () => {
    for (const html of [
      '<img src="decorative.png" aria-hidden="true">',
      '<div aria-hidden="true"><img src="nested.png"></div>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.image_alt.missing"))
        .toBeUndefined();
    }

    for (const html of [
      '<input type="image" src="search.png" aria-hidden="true">',
      '<div aria-hidden="true"><input type="image" src="nested-search.png"></div>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"))
        .toBeUndefined();
    }

    expect(auditSeoMetadata('<img src="visible.png" aria-hidden="false">').issues
      .find((issue) => issue.code === "accessibility.image_alt.missing")?.severity)
      .toBe("error");
    expect(auditSeoMetadata('<input type="image" src="visible-search.png" aria-hidden="false">').issues
      .find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty")?.severity)
      .toBe("error");
  });
  it("image-map links require usable alt text", () => {
    for (const html of [
      '<map name="nav"><area href="/docs"></map>',
      '<map name="nav"><area href="/docs" alt=""></map>',
      '<map name="nav"><area href="/docs" alt="   "></map>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.area_alt.missing_or_empty"))
        .toEqual({
          code: "accessibility.area_alt.missing_or_empty",
          severity: "error",
          category: "Accessibility",
          message: "Image-map links need alt text unless another area with the same href provides the label.",
        });
    }

    for (const html of [
      '<map name="nav"><area href="/docs" alt="Documentation"></map>',
      '<map name="nav"><area shape="default"></map>',
      '<map name="nav"><area href="/docs" alt=""><area href="/docs" alt="Documentation"></map>',
      '<template><map name="nav"><area href="/docs"></map></template>',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.area_alt.missing_or_empty"))
        .toBeUndefined();
    }
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

  it("reports non-empty canonical href values that cannot be parsed as URLs", () => {
    for (const href of ["https://", "http://[::1"]) {
      const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`).issues;
      expect(issues.find((issue) => issue.code === "seo.canonical.invalid_url")).toEqual({
        code: "seo.canonical.invalid_url",
        severity: "warning",
        category: "SEO",
        message: "Canonical link href cannot be parsed as a URL. Provide a valid canonical target or remove the declaration.",
      });
      expect(issues.find((issue) => issue.code === "seo.canonical.unusable")).toBeUndefined();
      expect(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended")).toBeUndefined();
    }

    for (const href of ["https://example.com/page", "/page", "../page", "//example.com/page"]) {
      expect(auditSeoMetadata(`<link rel="canonical" href="${href}">`).issues
        .find((issue) => issue.code === "seo.canonical.invalid_url"))
        .toBeUndefined();
    }
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

  it("warns when the canonical href contains a URL fragment", () => {
    for (const href of ["#section", "https://example.com/page#section", "/page#section"]) {
      const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`).issues;
      expect(issues.find((issue) => issue.code === "seo.canonical.fragment_unsupported")).toEqual({
        code: "seo.canonical.fragment_unsupported",
        severity: "warning",
        category: "SEO",
        message: "Canonical URL contains a fragment. Google generally does not support URL fragments for canonicalization; remove the #fragment from the canonical href.",
      });
    }

    const relative = auditSeoMetadata('<link rel="canonical" href="/page">').issues;
    expect(relative.find((issue) => issue.code === "seo.canonical.fragment_unsupported")).toBeUndefined();
  });

  it("recommends absolute canonical href values while preserving relative canonical support", () => {
    for (const href of ["/page", "page", "../page", "//example.com/page"]) {
      const issues = auditSeoMetadata(`<link rel="canonical" href="${href}">`).issues;
      expect(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended")).toEqual({
        code: "seo.canonical.relative_not_recommended",
        severity: "info",
        category: "SEO",
        message: "Canonical href is relative. Google supports relative canonical URLs but recommends absolute URLs to avoid long-term canonicalization mistakes.",
      });
    }

    for (const html of [
      '<link rel="canonical" href="https://example.com/page">',
      '<link rel="canonical" href="/page#section">',
      '<link rel="canonical" href="/page" media="print">',
    ]) {
      const issues = auditSeoMetadata(html).issues;
      expect(issues.find((issue) => issue.code === "seo.canonical.relative_not_recommended")).toBeUndefined();
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

    for (const xRobotsTag of ["NOINDEX, follow", "none", "googlebot: noindex, follow"]) {
      expect(auditSeoMetadata("<title>Page</title>", { xRobotsTag }).issues
        .find((issue) => issue.code === "seo.robots.noindex"))
        .toEqual(expect.objectContaining({ code: "seo.robots.noindex", severity: "warning" }));
    }

    for (const xRobotsTag of ["max-image-preview:none, follow", "otherbot: noindex, nofollow"]) {
      expect(auditSeoMetadata("<title>Page</title>", { xRobotsTag }).issues
        .find((issue) => issue.code === "seo.robots.noindex"))
        .toBeUndefined();
    }
  });

  it("ignores inert template contents in SEO and JSON-LD audits", () => {
    const html = [
      "<html><head></head><body>",
      "<template>",
      '<meta name="robots" content="noindex">',
      "<h1>Template heading</h1>",
      '<img src="template.png">',
      '<script type="application/ld+json">{</script>',
      "</template>",
      "<h1>Visible heading</h1>",
      '<img src="visible.png" alt="Visible">',
      "</body></html>",
    ].join("");

    const seo = auditSeoMetadata(html);
    expect(seo.issues.find((issue) => issue.code === "seo.robots.noindex")).toBeUndefined();
    expect(seo.issues.find((issue) => issue.code === "seo.h1.multiple")).toBeUndefined();
    expect(seo.issues.find((issue) => issue.code === "accessibility.image_alt.missing")).toBeUndefined();

    const schema = validateSchemaMarkup(html);
    expect(schema.total).toBe(0);
    expect(schema.blocksChecked).toBe(0);
    expect(schema.issues).toEqual([]);
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

  it("reports ambiguous duplicate primary metadata without merging values", () => {
    const title = "T".repeat(40);
    const description = "D".repeat(140);
    const result = auditSeoMetadata([
      "<html><head>",
      `<title>${title}</title>`,
      `<title>${"U".repeat(40)}</title>`,
      `<meta name="description" content="${description}">`,
      `<meta name="description" content="${"E".repeat(140)}">`,
      "</head><body></body></html>",
    ].join(""));

    expect(result.issues).toContainEqual({
      code: "seo.title.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple <title> elements are declared in the document head. Keep one unambiguous page title.",
    });
    expect(result.issues).toContainEqual({
      code: "seo.meta_description.multiple",
      severity: "warning",
      category: "SEO",
      message: "Multiple meta descriptions are declared in the document head. Keep one unambiguous page description.",
    });
    expect(result.issues.find((issue) => issue.code === "seo.title.length")).toBeUndefined();
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

  it.each([
    '<meta name="viewport" content="width=device-width, user-scalable=no">',
    '<meta name="viewport" content="width=device-width, maximum-scale=1.5">',
    '<meta name="viewport" content="width=device-width, maximum-scale=yes">',
  ])("reports viewport metadata that restricts 200% zoom: %s", (html) => {
    const result = auditSeoMetadata(html);

    expect(result.issues).toContainEqual({
      code: "accessibility.viewport.zoom_restricted",
      severity: "warning",
      category: "Accessibility",
      message: "Viewport metadata restricts user zoom below 200%. Avoid user-scalable=no and maximum-scale values below 2.",
    });
  });

  it.each([
    '<meta name="viewport" content="width=device-width, user-scalable=yes">',
    '<meta name="viewport" content="width=device-width, maximum-scale=2">',
    '<meta name="viewport" content="width=device-width, maximum-scale=-1">',
    '<meta name="viewport" content="width=device-width">',
  ])("does not flag non-restricting viewport metadata: %s", (html) => {
    const result = auditSeoMetadata(html);

    expect(result.issues.find((issue) => issue.code === "accessibility.viewport.zoom_restricted")).toBeUndefined();
  });

  it.each([
    '<meta http-equiv="refresh" content="30">',
    '<meta http-equiv="REFRESH" content="30; URL=https://example.com/next">',
    '<meta http-equiv="refresh" content="72000">',
  ])("reports delayed meta refresh directives: %s", (html) => {
    const result = auditSeoMetadata(html);

    expect(result.issues).toContainEqual({
      code: "accessibility.meta_refresh.delayed",
      severity: "warning",
      category: "Accessibility",
      message: "Meta refresh uses a delay between 1 second and 20 hours. Prefer an immediate redirect or user-controlled navigation.",
    });
  });

  it("follows first valid meta refresh semantics and preserves safe controls", () => {
    const delayedAfterInvalid = auditSeoMetadata([
      '<meta http-equiv="refresh" content="0: https://example.com/invalid">',
      '<meta http-equiv="refresh" content="5; https://example.com/next">',
    ].join(""));
    expect(delayedAfterInvalid.issues.find((issue) => issue.code === "accessibility.meta_refresh.delayed")?.severity)
      .toBe("warning");

    for (const html of [
      '<meta http-equiv="refresh" content="0; URL=https://example.com/next"><meta http-equiv="refresh" content="5">',
      '<meta http-equiv="refresh" content="72001">',
      '<meta http-equiv="refresh" content="+5; https://example.com/invalid">',
      '<template><meta http-equiv="refresh" content="5"></template><meta http-equiv="refresh" content="0">',
    ]) {
      expect(auditSeoMetadata(html).issues.find((issue) => issue.code === "accessibility.meta_refresh.delayed"))
        .toBeUndefined();
    }
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
    const html = `<html lang="en"><head><title>${"A".repeat(40)}</title><meta name="description" content="${"D".repeat(140)}"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://example.com"><meta property="og:title" content="x"><meta property="og:type" content="website"><meta property="og:image" content="x"><meta property="og:url" content="https://example.com"></head><body><h1>Title</h1>${"<img src=x>".repeat(150)}</body></html>`;
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

  it("falls back to base_url when the document base is malformed or base-disallowed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const baseHref of ["http://[", "javascript:alert(1)", "data:text/plain,ignored"]) {
      await expect(checkBrokenLinks(
        `<base href="${baseHref}"><a href="guide">Guide</a>`,
        "https://example.com/docs/page.html",
        1,
      )).resolves.toEqual([
        { url: "https://example.com/docs/guide", status: 204, ok: true, message: undefined },
      ]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toEqual(new URL("https://example.com/docs/guide"));
      expect(call[1]).toMatchObject({ method: "HEAD", redirect: "manual" });
    }
  });

  it("ignores base and anchor elements inside inert template contents", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkBrokenLinks(
      '<template><base href="https://8.8.8.8/inert/"><a href="ghost">Ghost</a><map name="inert"><area href="ghost-area" alt="Ghost area"></map></template><base href="https://1.1.1.1/live/"><a href="page">Page</a>',
      "https://1.1.1.1/fallback/",
      5,
    )).resolves.toEqual([
      { url: "https://1.1.1.1/live/page", status: 204, ok: true, message: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://1.1.1.1/live/page"),
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
  });

  it("checks active image-map area hyperlinks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkBrokenLinks(
      '<map name="nav"><area href="https://1.1.1.1/map-target" alt="Map target"></map>',
      undefined,
      5,
    )).resolves.toEqual([
      { url: "https://1.1.1.1/map-target", status: 204, ok: true, message: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://1.1.1.1/map-target"),
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
