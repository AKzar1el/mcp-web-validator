import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpUrl, readResponseText } from "../dist/network.js";
import { captureScreenshots } from "../dist/screenshot.js";
import { checkBrokenLinks } from "../dist/seo-auditor.js";
import { validateCssContent, validateHtmlContent } from "../dist/w3c-validator.js";

test("public URL policy blocks local, reserved, credentialed, and custom-port targets", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "http://192.0.2.1/",
    "http://[::1]/",
    "https://user:password@1.1.1.1/",
    "https://1.1.1.1:8443/",
  ]) {
    await assert.rejects(assertPublicHttpUrl(url), /not public|credentials|ports|address/i);
  }

  assert.equal((await assertPublicHttpUrl("https://1.1.1.1/path#fragment")).href, "https://1.1.1.1/path");
});

test("bounded response reader rejects a body beyond the configured cap", async () => {
  await assert.rejects(
    readResponseText(new Response("123456", { headers: { "content-length": "6" } }), 5),
    /exceeds the 5-byte limit/,
  );
});

test("link checker resolves relative links, deduplicates, and caps requests", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<a href="about">About</a><a href="/contact">Contact</a><a href="about#team">Duplicate</a>',
      "https://1.1.1.1/base/",
      2,
    );
    assert.deepEqual(
      links.map((link) => link.url),
      ["https://1.1.1.1/base/about", "https://1.1.1.1/contact"],
    );
    assert.deepEqual(requested, [
      { url: "https://1.1.1.1/base/about", method: "HEAD" },
      { url: "https://1.1.1.1/contact", method: "HEAD" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports redirects as reachable without following their targets", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/redirect">Redirect</a>', undefined, 1);
    assert.equal(calls, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/redirect",
        status: 302,
        ok: true,
        message: "Redirect not followed",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker classifies HTTP response classes without following redirects", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    [200, true],
    [204, true],
    [301, true],
    [302, true],
    [307, true],
    [308, true],
    [404, false],
    [410, false],
    [500, false],
  ];
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    const status = Number(new URL(String(input)).pathname.slice(1));
    return new Response(null, { status });
  };

  try {
    for (const [status, ok] of cases) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, ok);
      assert.equal(links[0].message, status >= 300 && status < 400 ? "Redirect not followed" : undefined);
    }
    assert.deepEqual(requested.map((request) => request.method), cases.map(() => "HEAD"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports blocked targets and network failures as unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network failure");
  };

  try {
    const links = await checkBrokenLinks(
      '<a href="http://127.0.0.1/">Blocked</a><a href="https://1.1.1.1/failed">Failed</a>',
      undefined,
      2,
    );
    assert.deepEqual(
      links.map(({ status, ok }) => ({ status, ok })),
      [
        { status: "blocked", ok: false },
        { status: "failed", ok: false },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker retries a 501 HEAD response with a bounded GET", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method, range: init?.headers?.Range });
    return init?.method === "HEAD"
      ? new Response(null, { status: 501 })
      : new Response(null, { status: 200 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-501-get-200">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/head-501-get-200",
        status: 200,
        ok: true,
        message: undefined,
      },
    ]);
    assert.deepEqual(requested, [
      { url: "https://1.1.1.1/head-501-get-200", method: "HEAD", range: undefined },
      { url: "https://1.1.1.1/head-501-get-200", method: "GET", range: "bytes=0-0" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports the bounded GET result after a 501 HEAD response", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return init?.method === "HEAD"
      ? new Response(null, { status: 501 })
      : new Response(null, { status: 404 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-501-get-404">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/head-501-get-404",
        status: 404,
        ok: false,
        message: undefined,
      },
    ]);
    assert.deepEqual(requested.map((request) => request.method), ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker preserves failure handling when the 501 GET fallback fails", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    if (init?.method === "HEAD") return new Response(null, { status: 501 });
    throw new Error("GET fallback failed");
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-501-get-failed">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/head-501-get-failed",
        status: "failed",
        ok: false,
        message: "GET fallback failed",
      },
    ]);
    assert.deepEqual(requested.map((request) => request.method), ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker does not retry a 500 HEAD response", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 500 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-500">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/head-500",
        status: 500,
        ok: false,
        message: undefined,
      },
    ]);
    assert.deepEqual(requested.map((request) => request.method), ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("W3C diagnostics are capped before becoming MCP output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      messages: Array.from({ length: 250 }, (_, index) => ({
        type: "error",
        message: `Issue ${index + 1}`,
      })),
    });

  try {
    const messages = await validateHtmlContent("<!doctype html><title>Test</title>");
    assert.equal(messages.length, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSS validation uses a multipart POST instead of an oversized query URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://jigsaw.w3.org/css-validator/validator");
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("text"), "body { color: red; }");
    return Response.json({ cssvalidation: { errors: [] } });
  };

  try {
    await assert.doesNotReject(validateCssContent("body { color: red; }"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshot viewport names cannot escape the output directory", async () => {
  await assert.rejects(
    captureScreenshots("missing.html", ".mcp-validator/screenshots", [
      { name: "../escape", width: 800, height: 600 },
    ]),
    /Viewport #1 name/,
  );
});
