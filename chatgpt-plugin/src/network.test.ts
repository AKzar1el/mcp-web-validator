import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHtml, PublicHtmlFetchError } from "./network";

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
      "user-agent": expect.stringContaining("DigestSEO-Web-Validator/0.4.0"),
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
