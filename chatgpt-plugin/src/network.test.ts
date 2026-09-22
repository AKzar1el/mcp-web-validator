import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHtml, fetchPublicText, PublicHtmlFetchError } from "./network";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function htmlResponse(html = "<!doctype html><title>Example</title>", init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { ...init, headers });
}

describe("fetchPublicHtml", () => {
  it("fetches one normalized public HTML page without forwarding user credentials", async () => {
    const fetchMock = vi.fn(async (_target: RequestInfo | URL, _init?: RequestInit) => htmlResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicHtml("https://example.com:443/page?q=1#fragment")).resolves.toMatchObject({
      requestedUrl: "https://example.com/page?q=1",
      finalUrl: "https://example.com/page?q=1",
      redirectsFollowed: 0,
      status: 200,
      contentType: "text/html",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe("https://example.com/page?q=1");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    expect(init?.headers).toEqual({
      accept: "text/html",
      "user-agent": expect.stringContaining("DigestSEO-Web-Validator/0.5.0"),
    });
  });

  it("decodes HTML using the HTTP-declared character encoding", async () => {
    const body = new Uint8Array([
      60, 116, 105, 116, 108, 101, 62, 67, 97, 102, 233, 60, 47, 116, 105, 116, 108, 101, 62,
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "text/html; charset=windows-1252" },
    })));

    await expect(fetchPublicHtml("https://example.com/legacy")).resolves.toMatchObject({
      html: "<title>Café</title>",
    });
  });

  it("decodes an early HTML meta charset when HTTP omits one", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1252"><title>Caf'),
      0xe9,
      ...new TextEncoder().encode("</title>"),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "text/html" },
    })));

    await expect(fetchPublicHtml("https://example.com/meta-charset")).resolves.toMatchObject({
      html: '<meta charset="windows-1252"><title>Caf\u00e9</title>',
    });
  });

  it("keeps HTTP charset precedence over an HTML meta charset", async () => {
    const body = new TextEncoder().encode('<meta charset="windows-1252"><title>Caf\u00e9</title>');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })));

    await expect(fetchPublicHtml("https://example.com/http-charset-wins")).resolves.toMatchObject({
      html: '<meta charset="windows-1252"><title>Caf\u00e9</title>',
    });
  });

  it("falls back to an early HTML meta charset when HTTP declares an unsupported charset", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1252"><title>Caf'),
      0xe9,
      ...new TextEncoder().encode("</title>"),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "text/html; charset=definitely-not-an-encoding" },
    })));

    await expect(fetchPublicHtml("https://example.com/unsupported-charset-meta")).resolves.toMatchObject({
      html: '<meta charset="windows-1252"><title>Caf\u00e9</title>',
    });
  });

  it("falls back to UTF-8 when HTTP declares an unsupported charset and HTML has no usable meta charset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<title>Caf\u00e9</title>", {
      headers: { "content-type": "text/html; charset=definitely-not-an-encoding" },
    })));

    await expect(fetchPublicHtml("https://example.com/unsupported-charset-default")).resolves.toMatchObject({
      html: "<title>Caf\u00e9</title>",
    });
  });

  it.each([
    "ftp://example.com/file",
    "https://user:password@example.com/",
    "https://example.com:8443/",
    "http://example.com:443/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::ffff:127.0.0.1]/",
    "https://service.internal/",
    "https://service.test/",
    "https://web-validator-mcp.digestseo.com/mcp",
  ])("rejects blocked destination %s before fetching", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicHtml(url)).rejects.toBeInstanceOf(PublicHtmlFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows relative redirects and records the final URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(htmlResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicHtml("https://example.com/start")).resolves.toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/final",
      redirectsFollowed: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to a private destination before the second fetch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicHtml("https://example.com/start")).rejects.toMatchObject({
      code: "blocked_url",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTPS downgrade redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: "http://example.com/insecure" } }),
      ),
    );

    await expect(fetchPublicHtml("https://example.com/start")).rejects.toMatchObject({
      code: "redirect",
      message: expect.stringContaining("HTTPS-to-HTTP"),
    });
  });

  it("rejects a crawl redirect that leaves the locked website origin before a second fetch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://public.example.org/page" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicHtml("https://example.com/start", { allowedOrigin: "https://example.com" }))
      .rejects.toMatchObject({ code: "scope" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect loops and redirect chains longer than three hops", async () => {
    const loopFetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "/loop" } }),
    );
    vi.stubGlobal("fetch", loopFetch);
    await expect(fetchPublicHtml("https://example.com/loop")).rejects.toMatchObject({ code: "redirect" });

    const chainFetch = vi.fn(async (target: URL) => {
      const step = Number(new URL(target).pathname.slice(1) || "0");
      return new Response(null, { status: 302, headers: { location: `/${step + 1}` } });
    });
    vi.stubGlobal("fetch", chainFetch);
    await expect(fetchPublicHtml("https://example.com/0")).rejects.toMatchObject({
      code: "redirect",
      message: expect.stringContaining("3-redirect"),
    });
    expect(chainFetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["application/json", "{}"],
    ["text/plain", "plain text"],
    ["application/xhtml+xml", "<html></html>"],
  ])("rejects non-HTML content type %s", async (contentType, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": contentType } })),
    );

    await expect(fetchPublicHtml("https://example.com/page")).rejects.toMatchObject({
      code: "content_type",
    });
  });

  it("rejects HTTP failures, empty HTML, and oversized declared bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("error", { status: 404 })));
    await expect(fetchPublicHtml("https://example.com/not-found")).rejects.toMatchObject({
      code: "http_status",
    });

    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("   ")));
    await expect(fetchPublicHtml("https://example.com/empty")).rejects.toMatchObject({ code: "empty" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse("small", { headers: { "content-length": String(1024 * 1024 + 1) } })),
    );
    await expect(fetchPublicHtml("https://example.com/large")).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects streamed bodies and decoded HTML beyond their separate limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("x".repeat(1024 * 1024 + 1))));
    await expect(fetchPublicHtml("https://example.com/bytes")).rejects.toMatchObject({ code: "too_large" });

    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("x".repeat(200_001))));
    await expect(fetchPublicHtml("https://example.com/characters")).rejects.toMatchObject({
      code: "too_large",
      message: expect.stringContaining("200,000-character"),
    });
  });

  it("applies one timeout across the entire fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_target: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const pending = fetchPublicHtml("https://example.com/slow");
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });
});

describe("fetchPublicText", () => {
  const textOptions = {
    allowedOrigin: "https://example.com",
    acceptedContentTypes: ["text/plain"],
    maxBytes: 1_024,
    maxRedirects: 5,
  } as const;

  it("keeps redirects on the locked origin by default", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://robots.example.net/policy.txt" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicText("https://example.com/robots.txt", textOptions)).rejects.toMatchObject({
      code: "scope",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still requires the initial request to match the locked origin when cross-origin redirects are allowed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicText("https://robots.example.net/policy.txt", {
      ...textOptions,
      allowCrossOriginRedirects: true,
    })).rejects.toMatchObject({ code: "scope" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still blocks private redirect targets when cross-origin redirects are explicitly allowed", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicText("https://example.com/robots.txt", {
      ...textOptions,
      allowCrossOriginRedirects: true,
    })).rejects.toMatchObject({ code: "blocked_url" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
