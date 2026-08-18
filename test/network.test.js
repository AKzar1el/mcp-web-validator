import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import { assertPublicHttpUrl, readResponseText } from "../dist/network.js";
import { captureScreenshots } from "../dist/screenshot.js";
import { checkBrokenLinks } from "../dist/seo-auditor.js";
import { validateCssContent, validateHtmlContent } from "../dist/w3c-validator.js";

const screenshotViewport = [{ name: "test", width: 800, height: 600 }];

function createMockRequest(url) {
  let handled = false;
  const resolution = { continued: 0, aborted: 0 };
  return {
    url: () => url,
    isInterceptResolutionHandled: () => handled,
    continue: async () => {
      resolution.continued += 1;
      handled = true;
    },
    abort: async () => {
      resolution.aborted += 1;
      handled = true;
    },
    resolution,
  };
}

async function waitForRequestResolution(request) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (request.resolution.continued + request.resolution.aborted > 0) return;
    // Local file policy validation awaits realpath(), so give asynchronous I/O a
    // short opportunity to settle instead of only advancing the immediate queue.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Intercepted request was not resolved: ${request.url()}`);
}

async function withMockedScreenshotBrowser(extraRequestUrls, gotoError, run) {
  const originalLaunch = puppeteer.launch;
  const state = { requests: [], interceptionEnabled: false };
  let requestHandler;
  const page = {
    setDefaultNavigationTimeout: () => {},
    setRequestInterception: async (enabled) => {
      state.interceptionEnabled = enabled;
    },
    on: (event, listener) => {
      if (event === "request") requestHandler = listener;
    },
    setViewport: async () => {},
    goto: async (targetUrl) => {
      state.requests = [
        createMockRequest(targetUrl),
        ...extraRequestUrls.map((url) => createMockRequest(url)),
      ];
      for (const request of state.requests) {
        requestHandler(request);
        await waitForRequestResolution(request);
      }
      if (gotoError) throw gotoError;
    },
    screenshot: async () => {},
  };
  const browser = {
    newPage: async () => page,
    close: async () => {},
  };
  puppeteer.launch = async () => browser;

  try {
    return await run(state);
  } finally {
    puppeteer.launch = originalLaunch;
  }
}

async function createScreenshotFixture(t) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-screenshot-policy-"));
  const localDirectory = path.join(temporaryDirectory, "page");
  const nestedDirectory = path.join(localDirectory, "assets");
  const selectedFile = path.join(localDirectory, "index.html");
  const siblingCss = path.join(localDirectory, "style.css");
  const nestedImage = path.join(nestedDirectory, "image.png");
  const outsideFile = path.join(temporaryDirectory, "outside.txt");
  await fs.mkdir(nestedDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(selectedFile, "<!doctype html><title>Screenshot fixture</title>"),
    fs.writeFile(siblingCss, "body { color: black; }"),
    fs.writeFile(nestedImage, "image"),
    fs.writeFile(outsideFile, "outside"),
  ]);
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  return {
    temporaryDirectory,
    localDirectory,
    selectedFile,
    siblingCss,
    nestedImage,
    outsideFile,
    outputDirectory: path.join(temporaryDirectory, "screenshots"),
  };
}

function assertResolvedOnce(request) {
  assert.equal(
    request.resolution.continued + request.resolution.aborted,
    1,
    `request resolved more than once: ${request.url()}`,
  );
}

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

test("local screenshot rendering permits only contained files and public network requests", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const escapedPath = path.join(fixture.localDirectory, "..", "outside.txt");
  const requestUrls = [
    pathToFileURL(fixture.siblingCss).href,
    pathToFileURL(fixture.nestedImage).href,
    pathToFileURL(escapedPath).href,
    pathToFileURL(fixture.outsideFile).href,
    "http://1.1.1.1/asset.css",
    "http://127.0.0.1/private.js",
    "http://10.0.0.1/private.js",
    "http://[fc00::1]/private.js",
    "data:text/css,body%7Bcolor%3Ablack%7D",
    "blob:null/screenshot-fixture",
    "ftp://example.com/unsupported",
  ];

  const { result, state } = await withMockedScreenshotBrowser(requestUrls, undefined, async (browserState) => ({
    result: await captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport),
    state: browserState,
  }));

  assert.equal(result.length, 1);
  assert.equal(state.interceptionEnabled, true);
  for (const request of state.requests) {
    assertResolvedOnce(request);
  }
  assert.equal(state.requests[0].resolution.continued, 1, "selected local HTML file is allowed");
  assert.equal(state.requests[1].resolution.continued, 1, "sibling CSS is allowed");
  assert.equal(state.requests[2].resolution.continued, 1, "descendant asset is allowed");
  assert.equal(state.requests[3].resolution.aborted, 1, "parent-directory escape is blocked");
  assert.equal(state.requests[4].resolution.aborted, 1, "absolute file outside the boundary is blocked");
  assert.equal(state.requests[5].resolution.continued, 1, "public HTTP subrequest is allowed");
  assert.equal(state.requests[6].resolution.aborted, 1, "loopback HTTP subrequest is blocked");
  assert.equal(state.requests[7].resolution.aborted, 1, "private IPv4 subrequest is blocked");
  assert.equal(state.requests[8].resolution.aborted, 1, "private IPv6 subrequest is blocked");
  assert.equal(state.requests[9].resolution.continued, 1, "data URL is allowed");
  assert.equal(state.requests[10].resolution.continued, 1, "blob URL is allowed");
  assert.equal(state.requests[11].resolution.aborted, 1, "unsupported scheme is blocked");
});

test("local screenshot rendering blocks symlinked files outside the selected directory", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const escapedSymlink = path.join(fixture.localDirectory, "escaped.txt");
  try {
    await fs.symlink(fixture.outsideFile, escapedSymlink, "file");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      t.skip("Creating file symlinks is not permitted in this environment");
      return;
    }
    throw error;
  }

  const { state } = await withMockedScreenshotBrowser([pathToFileURL(escapedSymlink).href], undefined, async (browserState) => {
    await captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport);
    return { state: browserState };
  });

  assert.equal(state.requests[1].resolution.aborted, 1);
  assertResolvedOnce(state.requests[1]);
});

test("screenshot rendering preserves remote public targets and reports blocked navigation", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const remote = await withMockedScreenshotBrowser(["data:text/plain,ok", "blob:null/remote-fixture", "ftp://example.com/unsupported"], undefined, async (state) => ({
    result: await captureScreenshots("https://1.1.1.1/page", fixture.outputDirectory, screenshotViewport),
    state,
  }));
  assert.equal(remote.result.length, 1);
  for (const request of remote.state.requests.slice(0, 3)) {
    assert.equal(request.resolution.continued, 1);
    assertResolvedOnce(request);
  }
  assert.equal(remote.state.requests[3].resolution.aborted, 1, "remote unsupported scheme is blocked");
  assertResolvedOnce(remote.state.requests[3]);

  for (const privateUrl of [
    "https://10.0.0.1/",
    "https://127.0.0.1/",
    "https://[fc00::1]/",
  ]) {
    await assert.rejects(
      captureScreenshots(privateUrl, fixture.outputDirectory, screenshotViewport),
      /not public|non-public/i,
    );
  }

  await assert.rejects(
    withMockedScreenshotBrowser(["http://127.0.0.1/blocked"], new Error("net::ERR_FAILED"), async () =>
      captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport),
    ),
    /Screenshot navigation blocked: .*(not public|non-public)/i,
  );
});

test("screenshot viewport names cannot escape the output directory", async () => {
  await assert.rejects(
    captureScreenshots("missing.html", ".mcp-validator/screenshots", [
      { name: "../escape", width: 800, height: 600 },
    ]),
    /Viewport #1 name/,
  );
});
