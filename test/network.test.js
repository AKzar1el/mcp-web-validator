import assert from "node:assert/strict";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs/promises";
import fsPromisesDefault from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertPublicHttpUrl, fetchPublicText, readResponseText, readTextFile } from "../dist/network.js";
import { captureScreenshots } from "../dist/screenshot.js";
import { checkBrokenLinks, isUnverifiedLinkStatus } from "../dist/seo-auditor.js";
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
    "http://192.0.0.8/",
    "http://192.0.0.170/",
    "http://192.0.0.171/",
    "http://192.0.2.1/",
    "http://[::1]/",
    "http://[2001:100::1]/",
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
  for (const url of ["https://192.0.0.9/", "https://192.0.0.10/"]) {
    assert.equal((await assertPublicHttpUrl(url)).href, url);
  }
  assert.equal(
    (await assertPublicHttpUrl("https://[2606:4700:4700::1111]/")).href,
    "https://[2606:4700:4700::1111]/",
  );
  assert.equal(
    (await assertPublicHttpUrl("https://[2001:1::1]/")).href,
    "https://[2001:1::1]/",
  );
  for (const url of [
    "https://[2001:1::2]/",
    "https://[2001:1::3]/",
    "https://[2001:3::1]/",
    "https://[2001:4:112::1]/",
    "https://[2001:20::1]/",
    "https://[2001:30::1]/",
  ]) {
    assert.equal((await assertPublicHttpUrl(url)).href, url);
  }
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

test("manual redirects keep same-origin headers but strip credentials after a cross-origin hop", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    new Response(null, { status: 302, headers: { location: "/same" } }),
    new Response(null, { status: 302, headers: { location: "https://8.8.8.8/cross" } }),
    new Response(null, { status: 302, headers: { location: "https://1.1.1.1/return" } }),
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
  ];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    return responses[requests.length - 1];
  };

  try {
    const result = await fetchPublicText("https://1.1.1.1/start", {
      headers: {
        Authorization: "fixture-auth",
        Cookie: "fixture-cookie",
        "Proxy-Authorization": "fixture-proxy",
        Cookie2: "fixture-cookie2",
        "X-API-Key": "fixture-api-key",
        "Api-Key": "fixture-alternate-key",
        "X-Access-Key": "fixture-access-key",
        "X-Client-Key": "fixture-client-key",
        "Ocp-Apim-Subscription-Key": "fixture-azure-subscription-key",
        "X-Functions-Key": "fixture-azure-functions-key",
        XPrivateKey: "fixture-private-key",
        "X-Auth-Token": "fixture-auth-token",
        "X-Access-Token": "fixture-access-token",
        "X-Amz-Security-Token": "fixture-aws-token",
        "X-Client-Secret": "fixture-client-secret",
        "X-Session-ID": "fixture-session",
        XApiKey: "fixture-compact-api-key",
        XAuthToken: "fixture-compact-auth-token",
        XClientSecret: "fixture-compact-client-secret",
        XSessionId: "fixture-compact-session-id",
        "X-Authentication": "fixture-custom-authentication",
        XAuthentication: "fixture-compact-authentication",
        "X-JWT": "fixture-jwt",
        XJwt: "fixture-compact-jwt",
        "X-CSRF": "fixture-csrf",
        XCsrf: "fixture-compact-csrf",
        "Signature": "fixture-http-message-signature",
        "Signature-Input": "fixture-signature-metadata",
        "X-Hub-Signature-256": "fixture-webhook-hmac",
        XWebhookSignature: "fixture-compact-webhook-signature",
        Referer: "https://1.1.1.1/private?access_token=fixture-referer-token",
        hOsT: "private.internal",
        "X-Trace": "safe",
      },
      acceptedContentTypes: ["text/plain"],
      maxRedirects: 3,
    });
    assert.equal(result.text, "ok");
    assert.equal(result.url, "https://1.1.1.1/return");
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://1.1.1.1/start",
      "https://1.1.1.1/same",
      "https://8.8.8.8/cross",
      "https://1.1.1.1/return",
    ]);
    for (const request of requests) {
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("X-Trace"), "safe");
      assert.equal(request.headers.get("Host"), null, "caller must not override validated URL authority");
    }
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.headers.get("Authorization"), "fixture-auth");
      assert.equal(request.headers.get("Cookie"), "fixture-cookie");
      assert.equal(request.headers.get("X-API-Key"), "fixture-api-key");
      assert.equal(request.headers.get("X-Access-Key"), "fixture-access-key");
      assert.equal(request.headers.get("X-Client-Key"), "fixture-client-key");
      assert.equal(request.headers.get("Ocp-Apim-Subscription-Key"), "fixture-azure-subscription-key");
      assert.equal(request.headers.get("X-Functions-Key"), "fixture-azure-functions-key");
      assert.equal(request.headers.get("XPrivateKey"), "fixture-private-key");
      assert.equal(request.headers.get("X-Amz-Security-Token"), "fixture-aws-token");
      assert.equal(request.headers.get("XApiKey"), "fixture-compact-api-key");
      assert.equal(request.headers.get("XAuthToken"), "fixture-compact-auth-token");
      assert.equal(request.headers.get("XClientSecret"), "fixture-compact-client-secret");
      assert.equal(request.headers.get("XSessionId"), "fixture-compact-session-id");
      assert.equal(request.headers.get("X-Authentication"), "fixture-custom-authentication");
      assert.equal(request.headers.get("XAuthentication"), "fixture-compact-authentication");
      assert.equal(request.headers.get("X-JWT"), "fixture-jwt");
      assert.equal(request.headers.get("XJwt"), "fixture-compact-jwt");
      assert.equal(request.headers.get("X-CSRF"), "fixture-csrf");
      assert.equal(request.headers.get("XCsrf"), "fixture-compact-csrf");
      assert.equal(request.headers.get("Signature"), "fixture-http-message-signature");
      assert.equal(request.headers.get("XWebhookSignature"), "fixture-compact-webhook-signature");
      assert.equal(request.headers.get("Referer"), "https://1.1.1.1/private?access_token=fixture-referer-token");
    }
    for (const request of requests.slice(2)) {
      for (const name of [
        "Authorization", "Cookie", "Proxy-Authorization", "Cookie2",
        "X-API-Key", "Api-Key", "X-Access-Key", "X-Client-Key", "X-Auth-Token", "X-Access-Token",
        "Ocp-Apim-Subscription-Key", "X-Functions-Key", "XPrivateKey",
        "X-Amz-Security-Token", "X-Client-Secret", "X-Session-ID",
        "XApiKey", "XAuthToken", "XClientSecret", "XSessionId",
        "X-Authentication", "XAuthentication", "X-JWT", "XJwt", "X-CSRF", "XCsrf",
        "Signature", "Signature-Input", "X-Hub-Signature-256", "XWebhookSignature",
        "Referer",
      ]) {
        assert.equal(request.headers.get(name), null, name);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redirect hops share one request timeout instead of resetting the budget", async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  let calls = 0;

  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const signal = init?.signal;
    signals.push(signal);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 240);
      function onAbort() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/next" } })
      : new Response("ok", { status: 200 });
  };

  try {
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/start", { timeoutMs: 350 }),
      /timeout|timed out/i,
    );
    assert.equal(signals.length, 2, "the second hop should consume only the remaining budget");
    assert.strictEqual(signals[0], signals[1], "all hops must share the same deadline signal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public fetch deadline includes initial DNS validation", async () => {
  const originalLookup = dns.promises.lookup;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  dns.promises.lookup = async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return [{ address: "1.1.1.1", family: 4 }];
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("ok", { status: 200 });
  };

  try {
    const started = Date.now();
    await assert.rejects(
      fetchPublicText("https://slow-dns.example.org/", { timeoutMs: 60 }),
      { name: "TimeoutError" },
    );
    assert.ok(Date.now() - started < 450, "DNS resolution must not exceed the request deadline");
    assert.equal(fetchCalls, 0, "a timed-out DNS result must not start HTTP transport");
  } finally {
    globalThis.fetch = originalFetch;
    dns.promises.lookup = originalLookup;
    syncBuiltinESMExports();
  }
});

test("public fetch deadline includes redirect-target DNS validation", async () => {
  const originalLookup = dns.promises.lookup;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  dns.promises.lookup = async (hostname) => {
    if (hostname === "slow-redirect.example.org") {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return [{ address: "1.1.1.1", family: 4 }];
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 302, headers: { location: "https://slow-redirect.example.org/" } });
  };

  try {
    const started = Date.now();
    await assert.rejects(
      fetchPublicText("https://fast-dns.example.org/", { timeoutMs: 60 }),
      { name: "TimeoutError" },
    );
    assert.ok(Date.now() - started < 450, "redirect DNS resolution must share the request deadline");
    assert.equal(fetchCalls, 1, "a timed-out redirect target must not start a second HTTP request");
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

test("bounded response reader caps decoded compressed bodies without trusting wire length", async () => {
  for (const encoding of ["gzip", "br"]) {
    const headers = { "content-encoding": encoding, "content-length": "9999" };
    assert.equal(await readResponseText(new Response("hello", { headers }), 5), "hello");
    await assert.rejects(
      readResponseText(new Response("123456", { headers }), 5),
      /exceeds the 5-byte limit/,
    );
  }
});

test("bounded response reader rejects mismatched exact identity lengths", async () => {
  for (const [body, declaredLength] of [["ok", "10"], ["too long", "2"]]) {
    await assert.rejects(
      readResponseText(new Response(body, { headers: { "content-length": declaredLength } }), 1024),
      /does not match Content-Length/i,
    );
  }
  assert.equal(await readResponseText(new Response("ok", { headers: { "content-length": "2" } }), 1024), "ok");
  await assert.rejects(
    readResponseText(new Response(null, { headers: { "content-length": "2" } }), 1024),
    /does not match Content-Length/i,
  );
});

test("bounded response reader does not compare compressed or chunked lengths", async () => {
  assert.equal(
    await readResponseText(new Response("decoded", {
      headers: { "content-length": "55", "content-encoding": "gzip" },
    }), 1024),
    "decoded",
  );
  assert.equal(
    await readResponseText(new Response("chunked", {
      headers: { "content-length": "9999", "transfer-encoding": "chunked" },
    }), 7),
    "chunked",
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

test("bounded public text fetch rejects HTTP 206 partial HTML and sitemap responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const isSitemap = String(input).includes("sitemap.xml");
    return new Response(isSitemap ? "<urlset>" : "<!doctype html><title>Partial", {
      status: 206,
      headers: {
        "content-type": isSitemap ? "application/xml" : "text/html",
        "content-range": "bytes 0-15/100",
      },
    });
  };

  try {
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/page", { acceptedContentTypes: ["text/html"] }),
      /HTTP status 206/,
    );
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/sitemap.xml", { acceptedContentTypes: ["application/xml"] }),
      /HTTP status 206/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch rejects HTTP 204/205 responses without a document", async () => {
  const originalFetch = globalThis.fetch;
  let status = 204;
  globalThis.fetch = async () => new Response(null, {
    status,
    headers: { "content-type": "text/html" },
  });

  try {
    for (status of [204, 205]) {
      await assert.rejects(
        fetchPublicText("https://1.1.1.1/page", { acceptedContentTypes: ["text/html"] }),
        new RegExp(`HTTP status ${status}`),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded public text fetch rejects blank HTML instead of reporting a valid page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(" \n\t ", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  try {
    await assert.rejects(
      fetchPublicText("https://1.1.1.1/page", { acceptedContentTypes: ["text/html"] }),
      /empty HTML document/i,
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

test("HTML BOM takes precedence over a conflicting HTTP charset", async () => {
  const originalFetch = globalThis.fetch;
  const body = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("<title>Caf\u00e9</title>", "utf8"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=windows-1252" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/html-bom-conflict", {
      acceptedContentTypes: ["text/html"],
    });
    assert.equal(result.text, "<title>Caf\u00e9</title>");
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

test("local file reads use a bounded reader instead of an unbounded whole-file read", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-bounded-read-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "sample.txt");
  await fs.writeFile(filePath, "bounded text");

  const originalReadFile = fsPromisesDefault.readFile;
  fsPromisesDefault.readFile = async () => {
    throw new Error("Unbounded fs.readFile must not be used for local inputs");
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await readTextFile(filePath, 20), "bounded text");
    await assert.rejects(readTextFile(filePath, 5), /File exceeds the 5-byte limit/);
  } finally {
    fsPromisesDefault.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
});

test("local HTML file decoding honors an early meta charset", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-html-encoding-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "legacy.html");
  const body = Buffer.concat([
    Buffer.from('<meta charset="windows-1252"><title>Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</title>", "ascii"),
  ]);
  await fs.writeFile(filePath, body);

  assert.equal(
    await readTextFile(filePath, 10_000, "text/html"),
    '<meta charset="windows-1252"><title>Café</title>',
  );
});

test("local XHTML file decoding honors its XML encoding declaration", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-xhtml-encoding-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "legacy.xhtml");
  const body = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="windows-1252"?><html><head><title>Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("</title></head></html>", "ascii"),
  ]);
  await fs.writeFile(filePath, body);

  assert.equal(
    await readTextFile(filePath, 10_000, "application/xhtml+xml"),
    '<?xml version="1.0" encoding="windows-1252"?><html><head><title>Café</title></head></html>',
  );
});

test("public CSS without an HTTP charset honors its leading @charset declaration", async () => {
  const originalFetch = globalThis.fetch;
  const body = Buffer.concat([
    Buffer.from('@charset "windows-1252"; .label::before { content: "Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from('"; }', "ascii"),
  ]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/css" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/legacy.css", {
      acceptedContentTypes: ["text/css"],
    });
    assert.equal(result.text, '@charset "windows-1252"; .label::before { content: "Caf\u00e9"; }');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public CSS HTTP charset overrides conflicting @charset without a BOM", async () => {
  const originalFetch = globalThis.fetch;
  const css = '@charset "windows-1252"; .label::before { content: "Caf\u00e9"; }';
  globalThis.fetch = async () => new Response(Buffer.from(css, "utf8"), {
    status: 200,
    headers: { "content-type": "text/css; charset=utf-8" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/http-charset.css", {
      acceptedContentTypes: ["text/css"],
    });
    assert.equal(result.text, css);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public CSS BOM overrides a conflicting HTTP charset", async () => {
  const originalFetch = globalThis.fetch;
  const css = '.label::before { content: "Caf\u00e9"; }';
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(css, "utf16le")]);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/css; charset=windows-1252" },
  });

  try {
    const result = await fetchPublicText("https://1.1.1.1/bom.css", {
      acceptedContentTypes: ["text/css"],
    });
    assert.equal(result.text, css);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local CSS file decoding honors an exact leading @charset declaration", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-css-encoding-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "legacy.css");
  const body = Buffer.concat([
    Buffer.from('@charset "windows-1252"; .label::before { content: "Caf', "ascii"),
    Buffer.from([0xe9]),
    Buffer.from('"; }', "ascii"),
  ]);
  await fs.writeFile(filePath, body);

  assert.equal(
    await readTextFile(filePath, 10_000, "text/css"),
    '@charset "windows-1252"; .label::before { content: "Caf\u00e9"; }',
  );
});

test("local CSS file decoding gives a BOM precedence over @charset", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-css-bom-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "utf16.css");
  const body = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('@charset "windows-1252"; .label::before { content: "Caf\u00e9"; }', "utf16le"),
  ]);
  await fs.writeFile(filePath, body);

  assert.equal(
    await readTextFile(filePath, 10_000, "text/css"),
    '@charset "windows-1252"; .label::before { content: "Caf\u00e9"; }',
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

test("link checker visits fragment-only anchors when the public document base is a different page", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 404 });
  };

  try {
    const remote = await checkBrokenLinks(
      '<base href="https://8.8.8.8/docs/"><a href="#missing">Missing on base page</a>',
      "https://1.1.1.1/docs/page",
      1,
    );
    assert.deepEqual(remote.map((link) => [link.url, link.ok]), [["https://8.8.8.8/docs/", false]]);
    assert.deepEqual(await checkBrokenLinks('<a href="#local">Same page</a>', "https://1.1.1.1/docs/page", 1), []);
    assert.deepEqual(await checkBrokenLinks('<base href="/docs/page"><a href="#local">Same page</a>', "https://1.1.1.1/docs/page", 1), []);
    assert.deepEqual(await checkBrokenLinks('<base href="http://127.0.0.1/private"><a href="#local">Unsafe base</a>', "https://1.1.1.1/docs/page", 1), []);
    assert.deepEqual(requested, [
      { url: "https://8.8.8.8/docs/", method: "HEAD" },
      { url: "https://8.8.8.8/docs/", method: "GET" },
    ]);
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

test("malformed or base-disallowed document bases fall back to the fetched page URL", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    for (const baseHref of ["http://[", "javascript:alert(1)", "data:text/plain,ignored"]) {
      const links = await checkBrokenLinks(
        `<base href="${baseHref}"><a href="guide">Guide</a>`,
        "https://1.1.1.1/docs/page.html",
        1,
      );
      assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/docs/guide"]);
    }
    assert.deepEqual(requested, [
      { url: "https://1.1.1.1/docs/guide", method: "HEAD" },
      { url: "https://1.1.1.1/docs/guide", method: "HEAD" },
      { url: "https://1.1.1.1/docs/guide", method: "HEAD" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker ignores base and anchor elements inside inert template contents", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<template><base href="https://8.8.8.8/inert/"><a href="ghost">Ghost</a><map name="inert"><area href="ghost-area" alt="Ghost area"></map></template><base href="https://1.1.1.1/live/"><a href="page">Page</a>',
      "https://1.1.1.1/fallback/",
      5,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/live/page"]);
    assert.deepEqual(requested, [{ url: "https://1.1.1.1/live/page", method: "HEAD" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker checks active image-map area hyperlinks", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  };

  try {
    const links = await checkBrokenLinks(
      '<map name="nav"><area href="https://1.1.1.1/map-target" alt="Map target"></map>',
      undefined,
      5,
    );
    assert.deepEqual(links.map((link) => link.url), ["https://1.1.1.1/map-target"]);
    assert.deepEqual(requested, [{ url: "https://1.1.1.1/map-target", method: "HEAD" }]);
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
    [401, false],
    [403, false],
    [429, false],
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
      assert.equal(links[0].message, status === 401 || status === 403
        ? "Access restricted; destination availability not verified"
        : status === 429
          ? "Rate limited; destination availability not verified"
          : status >= 300 && status < 400 ? "Redirect not followed" : undefined);
    }
    assert.deepEqual(requested.map((request) => request.method), cases.flatMap(([status]) =>
      [401, 403, 404, 410, 500].includes(status) ? ["HEAD", "GET"] : ["HEAD"]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker does not claim HTTP 300 Multiple Choices is a verified destination", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 300 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/choices">Link</a>', undefined, 1);
    assert.equal(links.length, 1);
    assert.equal(links[0].status, 300);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats HTTP 408 as unverified after a bounded GET confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 408 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/slow">Link</a>', undefined, 1);
    assert.equal(links[0].status, 408);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats HTTP 425 Too Early as unverified without replaying the request", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 425 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/too-early">Link</a>', undefined, 1);
    assert.equal(links[0].status, 425);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker does not mark temporary HTTP 502/503/504 outages as broken or retry HEAD", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const status of [502, 503, 504]) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.match(links[0].message, /availability not verified/i);
    }
    assert.deepEqual(methods, ["HEAD", "HEAD", "HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker leaves other server-side 5xx failures unverified without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const status of [507, 508, 509, 510, 530]) {
      methods.length = 0;
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.equal(isUnverifiedLinkStatus(links[0].status), true);
      assert.match(links[0].message, /availability not verified/i);
      assert.deepEqual(methods, ["HEAD"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker leaves HTTP 407 proxy challenges and 421 misdirected requests unverified without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const status of [407, 421]) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.match(links[0].message, /availability not verified/i);
    }
    assert.deepEqual(methods, ["HEAD", "HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker leaves HTTP 511 network authentication challenges unverified without retry or credentials", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 511 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/network-login">Link</a>', undefined, 1);
    assert.equal(links[0].status, 511);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /Network authentication required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats a HEAD HTTP 428 precondition challenge as unverified without retry", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 428 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/conditional">Link</a>', undefined, 1);
    assert.equal(links[0].status, 428);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Precondition required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker preserves GET HTTP 428 after a misleading HEAD 404", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : 428 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/conditional">Link</a>', undefined, 1);
    assert.equal(links[0].status, 428);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Precondition required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats HTTP 431 header rejection as unverified without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 431 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/large-headers">Link</a>', undefined, 1);
    assert.equal(links[0].status, 431);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Request headers too large; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports GET HTTP 431 after HEAD 404 without a false broken result", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : 431 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/large-headers">Link</a>', undefined, 1);
    assert.equal(links[0].status, 431);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Request headers too large; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats HTTP 451 legal restrictions as unverified without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 451 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/legal">Link</a>', undefined, 1);
    assert.equal(links[0].status, 451);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Unavailable for legal reasons; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker preserves GET HTTP 451 following a misleading HEAD 404", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : 451 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/legal">Link</a>', undefined, 1);
    assert.equal(links[0].status, 451);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Unavailable for legal reasons; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker treats HTTP 426 upgrade requirements as unverified without negotiating protocols", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 426, headers: { Upgrade: "HTTP/3.0" } });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/protocol">Link</a>', undefined, 1);
    assert.equal(links[0].status, 426);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Protocol upgrade required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker retains an HTTP 426 GET upgrade requirement after a HEAD 404", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : 426 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/protocol">Link</a>', undefined, 1);
    assert.equal(links[0].status, 426);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
    assert.match(links[0].message, /Protocol upgrade required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [status, diagnostic] of [
  [406, /Not acceptable.*availability not verified/i],
  [412, /Precondition failed.*availability not verified/i],
  [423, /Resource locked.*availability not verified/i],
]) {
  test(`link checker does not mark HTTP ${status} as a confirmed broken destination`, async () => {
    const originalFetch = globalThis.fetch;
    const methods = [];
    globalThis.fetch = async (_input, init) => {
      methods.push(init?.method);
      return new Response(null, { status });
    };
    try {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/status-${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.equal(isUnverifiedLinkStatus(links[0].status), true);
      assert.match(links[0].message, diagnostic);
      assert.deepEqual(methods, status === 423 ? ["HEAD"] : ["HEAD", "GET"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test(`link checker retains GET HTTP ${status} after an inconclusive HEAD 404`, async () => {
    const originalFetch = globalThis.fetch;
    const methods = [];
    globalThis.fetch = async (_input, init) => {
      methods.push(init?.method);
      return new Response(null, { status: init?.method === "HEAD" ? 404 : status });
    };
    try {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/status-${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.equal(isUnverifiedLinkStatus(links[0].status), true);
      assert.match(links[0].message, diagnostic);
      assert.deepEqual(methods, ["HEAD", "GET"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("link checker treats Cloudflare 520-524 edge and origin failures as unverified without retry", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const status of [520, 521, 522, 523, 524]) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.match(links[0].message, /availability not verified/i);
    }
    assert.deepEqual(methods, Array(5).fill("HEAD"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker leaves a GET HTTP 511 challenge unverified after a HEAD 404", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : 511 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/network-login">Link</a>', undefined, 1);
    assert.equal(links[0].status, 511);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /Network authentication required; destination availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker explains Cloudflare 525/526 origin TLS failures without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const [status, explanation] of [[525, /Cloudflare.*TLS handshake.*origin/i], [526, /Cloudflare.*origin.*certificate/i]]) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.match(links[0].message, explanation);
    }
    assert.deepEqual(methods, ["HEAD", "HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker preserves Cloudflare TLS error provenance after a misleading HEAD 404", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 404 : Number(new URL(String(input)).pathname.slice(1)) });
  };
  try {
    for (const [status, explanation] of [[525, /Cloudflare.*TLS handshake.*origin/i], [526, /Cloudflare.*origin.*certificate/i]]) {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/${status}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, status);
      assert.equal(links[0].ok, false);
      assert.match(links[0].message, explanation);
    }
    assert.deepEqual(methods, ["HEAD", "GET", "HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker verifies a successful GET after a transient HEAD HTTP 408", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 408 : 200 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/recovered">Link</a>', undefined, 1);
    assert.equal(links[0].status, 200);
    assert.equal(links[0].ok, true);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker retries a transport-rejected HEAD with a bounded GET", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    requests.push({ method: init?.method, range: init?.headers?.Range });
    if (init?.method === "HEAD") throw new TypeError("HEAD rejected by origin");
    return new Response(null, { status: 200 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-transport-rejected">Link</a>', undefined, 1);
    assert.equal(links[0].status, 200);
    assert.equal(links[0].ok, true);
    assert.deepEqual(requests, [
      { method: "HEAD", range: undefined },
      { method: "GET", range: "bytes=0-0" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker does not retry a non-transport HEAD failure", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init?.method);
    throw new Error("Explicit HEAD failure");
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-error">Link</a>', undefined, 1);
    assert.equal(links[0].status, "failed");
    assert.match(links[0].message, /Explicit HEAD failure/);
    assert.deepEqual(requests, ["HEAD"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker cannot verify an unconditional 304 and retries HEAD with a bounded GET", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: 304 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/uncertain">Link</a>', undefined, 1);
    assert.equal(links[0].status, 304);
    assert.equal(links[0].ok, false);
    assert.match(links[0].message, /availability not verified/i);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker accepts a successful GET after an inconclusive HEAD 304", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 304 : 200 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/recovered">Link</a>', undefined, 1);
    assert.equal(links[0].status, 200);
    assert.equal(links[0].ok, true);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker confirms a HEAD 401 with a bounded GET before reporting availability", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method);
    return new Response(null, { status: init?.method === "HEAD" ? 401 : 200 });
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/restricted">Link</a>', undefined, 1);
    assert.equal(links[0].status, 200);
    assert.equal(links[0].ok, true);
    assert.deepEqual(methods, ["HEAD", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker confirms a HEAD 400 with GET before marking a live target broken", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, range: init?.headers?.Range });
    if (init?.method === "HEAD") return new Response(null, { status: 400 });
    return new Response(null, { status: url.endsWith("/live") ? 200 : 400 });
  };
  try {
    const links = await checkBrokenLinks(
      '<a href="https://1.1.1.1/live">Live</a><a href="https://1.1.1.1/broken">Broken</a>',
      undefined,
      2,
    );
    assert.deepEqual(links.map(({ status, ok }) => ({ status, ok })), [
      { status: 200, ok: true },
      { status: 400, ok: false },
    ]);
    for (const path of ["live", "broken"]) {
      const url = `https://1.1.1.1/${path}`;
      assert.deepEqual(requests.filter((request) => request.url === url), [
        { url, method: "HEAD", range: undefined },
        { url, method: "GET", range: "bytes=0-0" },
        ...(path === "broken" ? [{ url, method: "GET", range: undefined }] : []),
      ]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker retries a plain GET when a server rejects the Range header with 400", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const range = init?.headers?.Range;
    requests.push({ method: init?.method, range });
    return new Response(null, { status: init?.method === "HEAD" ? 405 : range ? 400 : 200 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/range-rejected">Link</a>', undefined, 1);
    assert.equal(links[0].status, 200);
    assert.equal(links[0].ok, true);
    assert.deepEqual(requests, [
      { method: "HEAD", range: undefined },
      { method: "GET", range: "bytes=0-0" },
      { method: "GET", range: undefined },
    ]);
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

test("link checker confirms negative HEAD responses before marking links broken", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method;
    const path = new URL(String(input)).pathname;
    requested.push({ path, method, range: init?.headers?.Range });
    if (method === "HEAD") return new Response(null, { status: path === "/gone" ? 410 : 404 });
    return new Response(null, { status: path === "/gone" ? 410 : 200 });
  };

  try {
    const links = await checkBrokenLinks(
      '<a href="https://1.1.1.1/available">Available</a><a href="https://1.1.1.1/gone">Gone</a>',
      undefined,
      2,
    );
    assert.deepEqual(links.map(({ status, ok }) => ({ status, ok })), [
      { status: 200, ok: true },
      { status: 410, ok: false },
    ]);
    for (const path of ["/available", "/gone"]) {
      assert.deepEqual(requested.filter((r) => r.path === path), [
        { path, method: "HEAD", range: undefined },
        { path, method: "GET", range: "bytes=0-0" },
      ]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports unverified instead of broken when negative HEAD fallback fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    throw new Error("GET confirmation unavailable");
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-only-404">Link</a>', undefined, 1);
    assert.deepEqual(links, [{
      url: "https://1.1.1.1/head-only-404",
      status: "failed",
      ok: false,
      message: "GET confirmation unavailable",
    }]);
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

for (const scenario of [
  { name: "GET succeeds", rangedStatus: 200, expectedStatus: 200, expectedOk: true, methods: ["HEAD", "GET"] },
  { name: "GET confirms missing", rangedStatus: 404, expectedStatus: 404, expectedOk: false, methods: ["HEAD", "GET"] },
  { name: "full GET recovers after rejected range", rangedStatus: 416, fullStatus: 200, expectedStatus: 200, expectedOk: true, methods: ["HEAD", "GET", "GET"] },
  { name: "both GET attempts reject range", rangedStatus: 416, expectedStatus: 416, expectedOk: false, methods: ["HEAD", "GET", "GET"] },
  { name: "GET fails", throwGet: true, expectedStatus: "failed", expectedOk: false, methods: ["HEAD", "GET"] },
]) {
  test(`link checker confirms a 416 HEAD response with bounded GET: ${scenario.name}`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_input, init) => {
      requests.push({ method: init?.method, range: init?.headers?.Range });
      if (init?.method === "HEAD") return new Response(null, { status: 416 });
      if (scenario.throwGet) throw new Error("GET confirmation failed");
      if (!init?.headers?.Range && scenario.fullStatus !== undefined) {
        return new Response(null, { status: scenario.fullStatus });
      }
      return new Response(null, { status: scenario.rangedStatus });
    };

    try {
      const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-416">Link</a>', undefined, 1);
      assert.equal(links[0].status, scenario.expectedStatus);
      assert.equal(links[0].ok, scenario.expectedOk);
      assert.deepEqual(requests.map((request) => request.method), scenario.methods);
      assert.equal(requests[0].range, undefined);
      assert.equal(requests[1].range, "bytes=0-0");
      if (scenario.rangedStatus === 416) {
        assert.equal(requests[2].range, undefined);
        if (scenario.expectedStatus === 416) {
          assert.match(links[0].message, /availability not verified/i);
          assert.equal(isUnverifiedLinkStatus(links[0].status), true);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const headStatus of [406, 409, 411, 412, 415, 417, 422, 424]) {
  test(`link checker confirms HEAD ${headStatus} request refusal with bounded GET`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_input, init) => {
      requests.push({ method: init?.method, range: init?.headers?.Range });
      return new Response(null, { status: init?.method === "HEAD" ? headStatus : 200 });
    };
    try {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/refusal-${headStatus}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, 200);
      assert.equal(links[0].ok, true);
      assert.deepEqual(requests, [
        { method: "HEAD", range: undefined },
        { method: "GET", range: "bytes=0-0" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test(`link checker leaves HTTP ${headStatus} unverified when GET also refuses`, async () => {
    const originalFetch = globalThis.fetch;
    const methods = [];
    globalThis.fetch = async (_input, init) => {
      methods.push(init?.method);
      return new Response(null, { status: headStatus });
    };
    try {
      const links = await checkBrokenLinks(`<a href="https://1.1.1.1/refusal-${headStatus}">Link</a>`, undefined, 1);
      assert.equal(links[0].status, headStatus);
      assert.equal(links[0].ok, false);
      assert.equal(isUnverifiedLinkStatus(links[0].status), true);
      assert.match(links[0].message, /destination availability not verified/i);
      assert.deepEqual(methods, ["HEAD", "GET"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("link checker honors a definitive GET 404 after HEAD 409 conflict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Response(null, { status: init?.method === "HEAD" ? 409 : 404 });
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/conflict">Link</a>', undefined, 1);
    assert.equal(links[0].status, 404);
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("link checker reports failed confirmation after HEAD 422 without claiming a broken URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 422 });
    throw new Error("GET confirmation failed");
  };
  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/unprocessable">Link</a>', undefined, 1);
    assert.equal(links[0].status, "failed");
    assert.equal(links[0].ok, false);
    assert.equal(isUnverifiedLinkStatus(links[0].status), true);
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

test("link checker confirms a HEAD 500 with bounded GET before declaring the link broken", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), method: init?.method, range: init?.headers?.Range });
    return new Response(null, { status: init?.method === "HEAD" ? 500 : 200 });
  };

  try {
    const links = await checkBrokenLinks('<a href="https://1.1.1.1/head-500">Link</a>', undefined, 1);
    assert.deepEqual(links, [
      {
        url: "https://1.1.1.1/head-500",
        status: 200,
        ok: true,
        message: undefined,
      },
    ]);
    assert.deepEqual(requested.map(({ method, range }) => ({ method, range })), [
      { method: "HEAD", range: undefined },
      { method: "GET", range: "bytes=0-0" },
    ]);
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
    return Response.json({ cssvalidation: { validity: true, errors: [] } });
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

test("local screenshot rendering permits contained paths starting with two dots", async (t) => {
  const fixture = await createScreenshotFixture(t);
  const assetDirectory = path.join(fixture.localDirectory, "..assets");
  const containedAsset = path.join(assetDirectory, "icon.png");
  await fs.mkdir(assetDirectory);
  await fs.writeFile(containedAsset, "image");

  const { state } = await withMockedScreenshotBrowser(
    [pathToFileURL(containedAsset).href],
    undefined,
    async (browserState, browserRuntime) => {
      await captureScreenshots(fixture.selectedFile, fixture.outputDirectory, screenshotViewport, browserRuntime);
      return { state: browserState };
    },
  );

  assert.equal(state.requests[1].resolution.continued, 1);
  assertResolvedOnce(state.requests[1]);
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
