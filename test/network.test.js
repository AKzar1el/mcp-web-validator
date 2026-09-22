import assert from "node:assert/strict";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertPublicHttpUrl, fetchPublicText, readResponseText } from "../dist/network.js";
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
  const browserRuntime = {
    launch: async () => browser,
  };
  return run(state, browserRuntime);
}

async function openProxyTunnel(proxyUrl, authority) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: proxy.hostname,
      port: Number(proxy.port),
    });
    let response = "";
    let settled = false;
    const finish = (error, statusLine) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(statusLine);
    };
    socket.setTimeout(2_000, () => finish(new Error("proxy tunnel timed out")));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        finish(undefined, response.slice(0, response.indexOf("\r\n")));
      }
    });
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
      );
    });
  });
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
    "http://[3fff::1]/",
    "https://user:password@1.1.1.1/",
    "https://1.1.1.1:8443/",
    "http://1.1.1.1:443/",
    "https://1.1.1.1:80/",
  ]) {
    await assert.rejects(assertPublicHttpUrl(url), /not public|credentials|ports|address/i);
  }

  assert.equal((await assertPublicHttpUrl("http://1.1.1.1:80/")).href, "http://1.1.1.1/");
  assert.equal((await assertPublicHttpUrl("https://1.1.1.1:443/")).href, "https://1.1.1.1/");
  assert.equal((await assertPublicHttpUrl("https://1.1.1.1/path#fragment")).href, "https://1.1.1.1/path");
  assert.equal(
    (await assertPublicHttpUrl("https://[2606:4700:4700::1111]/")).href,
    "https://[2606:4700:4700::1111]/",
  );
});

test("public fetch pins validated hostname resolution before transport", async () => {
  const originalLookup = dns.promises.lookup;
  const originalFetch = globalThis.fetch;
  let lookupCalls = 0;
  let dispatcherSeen = false;
  let dispatcherCloseStarted = false;

  dns.promises.lookup = async (_hostname, options) => {
    lookupCalls += 1;
    const address = lookupCalls === 1 ? "1.1.1.1" : "127.0.0.1";
    const record = { address, family: 4 };
    return options?.all ? [record] : record;
  };
  syncBuiltinESMExports();

  globalThis.fetch = async (input, init) => {
    dispatcherSeen = Boolean(init?.dispatcher);
    if (init?.dispatcher?.close) {
      init.dispatcher.close = async () => {
        dispatcherCloseStarted = true;
      };
    }
    if (!dispatcherSeen) {
      await dns.promises.lookup(new URL(String(input)).hostname, { all: true, verbatim: true });
    }
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };

  try {
    const result = await fetchPublicText("https://rebind.example.org/", {
      acceptedContentTypes: ["text/plain"],
    });
    assert.equal(result.text, "ok");
    assert.equal(dispatcherSeen, true, "validated DNS answers must be pinned into the HTTP transport");
    assert.equal(lookupCalls, 1, "transport must not perform an independent hostname lookup after validation");
    assert.equal(dispatcherCloseStarted, true, "request-scoped dispatcher close must begin after the terminal response");
  } finally {
    globalThis.fetch = originalFetch;
    dns.promises.lookup = originalLookup;
    syncBuiltinESMExports();
  }
});

test("bounded response reader rejects a body beyond the configured cap", async () => {
  await assert.rejects(
    readResponseText(new Response("123456", { headers: { "content-length": "6" } }), 5),
    /exceeds the 5-byte limit/,
  );
});

test("bounded public text fetch rejects disallowed response content types", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  try {
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/data", {
        acceptedContentTypes: ["text/html", "application/xhtml+xml"],
      }),
      /unsupported content type application\/json/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch accepts configured HTML media types with parameters", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("<!doctype html><title>HTML</title>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    new Response("<html xmlns=\"http://www.w3.org/1999/xhtml\"></html>", {
      status: 200,
      headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
    }),
  ];
  globalThis.fetch = async () => responses.shift();

  try {
    const options = { acceptedContentTypes: ["text/html", "application/xhtml+xml"] };
    assert.equal((await fetchPublicText("https://1.1.1.1/html", options)).contentType, "text/html; charset=utf-8");
    assert.equal(
      (await fetchPublicText("https://1.1.1.1/xhtml", options)).contentType,
      "application/xhtml+xml; charset=utf-8",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch honors a UTF-16 BOM for XHTML without an HTTP charset", async () => {
  const originalFetch = globalThis.fetch;
  const xml = '<?xml version="1.0" encoding="utf-16"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Caf\u00e9</title></head></html>';
  const body = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(xml, "utf16le"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/xhtml+xml" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/xhtml-utf16", {
      acceptedContentTypes: ["application/xhtml+xml"],
    });
    assert.equal(result.text, xml);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("XML BOM takes precedence over a conflicting HTTP charset", async () => {
  const originalFetch = globalThis.fetch;
  const xml = '<?xml version="1.0" encoding="utf-16"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Caf\u00e9</title></head></html>';
  const body = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(xml, "utf16le"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/xhtml-conflicting-http-charset", {
      acceptedContentTypes: ["application/xhtml+xml"],
    });
    assert.equal(result.text, xml);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP charset keeps precedence over an XML declaration when no BOM is present", async () => {
  const originalFetch = globalThis.fetch;
  const xml = '<?xml version="1.0" encoding="windows-1252"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Caf\u00e9</title></head></html>';
  globalThis.fetch = async () => new Response(Buffer.from(xml, "utf8"), {
    status: 200,
    headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/xhtml-http-charset", {
      acceptedContentTypes: ["application/xhtml+xml"],
    });
    assert.equal(result.text, xml);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch honors an XML encoding declaration for XHTML without an HTTP charset", async () => {
  const originalFetch = globalThis.fetch;
  const prefix = '<?xml version="1.0" encoding="windows-1252"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Caf';
  const suffix = "</title></head></html>";
  const body = Buffer.concat([
    Buffer.from(prefix, "ascii"),
    Buffer.from([0xe9]),
    Buffer.from(suffix, "ascii"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/xhtml+xml" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/xhtml-declared-encoding", {
      acceptedContentTypes: ["application/xhtml+xml"],
    });
    assert.match(result.text, /<title>Caf\u00e9<\/title>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch decodes the HTTP-declared character encoding", async () => {
  const originalFetch = globalThis.fetch;
  const body = new Uint8Array([
    60, 116, 105, 116, 108, 101, 62, 67, 97, 102, 233, 60, 47, 116, 105, 116, 108, 101, 62,
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=windows-1252" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/legacy", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, "<title>Café</title>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch decodes an early HTML meta charset when HTTP omits one", async () => {
  const originalFetch = globalThis.fetch;
  const body = Buffer.concat([
    Buffer.from('<meta charset="windows-1252"><title>Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</title>", "ascii"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/meta-charset", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, '<meta charset="windows-1252"><title>Caf\u00e9</title>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP charset keeps precedence over an HTML meta charset", async () => {
  const originalFetch = globalThis.fetch;
  const body = Buffer.from('<meta charset="windows-1252"><title>Caf\u00e9</title>', "utf8");
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/http-charset-wins", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, '<meta charset="windows-1252"><title>Caf\u00e9</title>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsupported HTTP charset falls back to an early HTML meta charset", async () => {
  const originalFetch = globalThis.fetch;
  const body = Buffer.concat([
    Buffer.from('<meta charset="windows-1252"><title>Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</title>", "ascii"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=definitely-not-an-encoding" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/unsupported-charset-meta", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, '<meta charset="windows-1252"><title>Caf\u00e9</title>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsupported HTTP charset falls back to UTF-8 when HTML has no usable meta charset", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<title>Caf\u00e9</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=definitely-not-an-encoding" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/unsupported-charset-default", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, "<title>Caf\u00e9</title>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsupported charset remains an error for non-HTML text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("plain text", {
    status: 200,
    headers: { "content-type": "text/plain; charset=definitely-not-an-encoding" },
  });

  try {
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/unsupported-text-charset", {
        acceptedContentTypes: ["text/plain"],
      }),
      /unsupported response character encoding "definitely-not-an-encoding"/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("link checker resolves relative links from the first public base element", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<base href="https://1.1.1.1/docs/"><a href="guide">Guide</a>',
      undefined,
      1,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/docs/guide"]);
    assert.deepEqual(requested, [{ url: "https://1.1.1.1/docs/guide", method: "HEAD" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document base element overrides the fetched page URL for relative links", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<base href="https://8.8.8.8/ignored/"><a href="guide">Guide</a>',
      "https://1.1.1.1/explicit/",
      1,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://8.8.8.8/ignored/guide"]);
    assert.deepEqual(requested, [{ url: "https://8.8.8.8/ignored/guide", method: "HEAD" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relative document base elements resolve against the fetched page URL", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<base href="../assets/"><a href="guide">Guide</a>',
      "https://1.1.1.1/docs/page.html",
      1,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/assets/guide"]);
    assert.deepEqual(requested, [{ url: "https://1.1.1.1/assets/guide", method: "HEAD" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsafe document base elements do not redirect relative link checks", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<base href="http://127.0.0.1/private/"><a href="secret">Secret</a><a href="https://1.1.1.1/public">Public</a>',
      "https://8.8.8.8/page",
      2,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/public"]);
    assert.deepEqual(requested, [{ url: "https://1.1.1.1/public", method: "HEAD" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsafe document base elements are ignored for relative link checks", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<base href="http://127.0.0.1/private/"><a href="secret">Secret</a>',
      undefined,
      1,
    );
    assert.deepEqual(links, []);
    assert.equal(calls, 0);
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

test("link checker retries without Range when the bounded GET returns 416", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method, range: init?.headers?.Range });
    if (init?.method === "HEAD") return new Response(null, { status: 405 });
    if (init?.headers?.Range) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": "bytes */0" },
      });
    }
    return new Response(null, { status: 200 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/empty-resource">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/empty-resource",
        status: 200,
        ok: true,
        message: undefined,
      },
    ]);
    assert.deepEqual(requested, [
      { url: "https://1.1.1.1/empty-resource", method: "HEAD", range: undefined },
      { url: "https://1.1.1.1/empty-resource", method: "GET", range: "bytes=0-0" },
      { url: "https://1.1.1.1/empty-resource", method: "GET", range: undefined },
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

  const { result, state } = await withMockedScreenshotBrowser(requestUrls, undefined, async (browserState, browserRuntime) => ({
    result: await captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport, browserRuntime),
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

  const { state } = await withMockedScreenshotBrowser([pathToFileURL(escapedSymlink).href], undefined, async (browserState, browserRuntime) => {
    await captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport, browserRuntime);
    return { state: browserState };
  });

  assert.equal(state.requests[1].resolution.aborted, 1);
  assertResolvedOnce(state.requests[1]);
});

test("screenshot rendering preserves remote public targets and reports blocked navigation", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const remote = await withMockedScreenshotBrowser(["data:text/plain,ok", "blob:null/remote-fixture", "ftp://example.com/unsupported"], undefined, async (state, browserRuntime) => ({
    result: await captureScreenshots("https://1.1.1.1/page", fixture.outputDirectory, screenshotViewport, browserRuntime),
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
    withMockedScreenshotBrowser(["http://127.0.0.1/blocked"], new Error("net::ERR_FAILED"), async (_state, browserRuntime) =>
      captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport, browserRuntime),
    ),
    /Screenshot navigation blocked: .*(not public|non-public)/i,
  );
});

test("screenshot rendering pins Chromium transport against DNS rebinding", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const originalLookup = dns.promises.lookup;
  let lookupCalls = 0;
  let transportProxySeen = false;

  dns.promises.lookup = async (_hostname, options) => {
    lookupCalls += 1;
    const address = lookupCalls <= 2 ? "1.1.1.1" : "127.0.0.1";
    const record = { address, family: 4 };
    return options?.all ? [record] : record;
  };
  syncBuiltinESMExports();

  let requestHandler;
  const page = {
    setDefaultNavigationTimeout: () => {},
    setRequestInterception: async () => {},
    on: (event, listener) => {
      if (event === "request") requestHandler = listener;
    },
    setViewport: async () => {},
    goto: async (targetUrl) => {
      const request = createMockRequest(targetUrl);
      requestHandler(request);
      await waitForRequestResolution(request);
      const statusLine = await openProxyTunnel(page.transportProxyUrl, "rebind.example.org:443");
      if (!statusLine.includes(" 200 ")) {
        throw new Error(`net::ERR_TUNNEL_CONNECTION_FAILED (${statusLine})`);
      }
    },
    screenshot: async () => {},
    transportProxyUrl: undefined,
  };
  const browser = {
    newPage: async () => page,
    close: async () => {},
  };
  const browserRuntime = {
    launch: async (proxyUrl) => {
      assert.match(
        proxyUrl ?? "",
        /^http:\/\/127\.0\.0\.1:\d+$/,
        "screenshot Chromium must use the request-scoped loopback transport proxy",
      );
      transportProxySeen = true;
      page.transportProxyUrl = proxyUrl;
      return browser;
    },
  };

  try {
    await assert.rejects(
      captureScreenshots(
        "https://rebind.example.org/",
        fixture.outputDirectory,
        screenshotViewport,
        browserRuntime,
      ),
      /Screenshot navigation blocked: .*non-public/i,
    );
    assert.equal(transportProxySeen, true);
    assert.equal(
      lookupCalls,
      3,
      "the proxy must revalidate the hostname at connection time and reject the private rebound",
    );
  } finally {
    dns.promises.lookup = originalLookup;
    syncBuiltinESMExports();
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
