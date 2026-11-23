import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { validateHtmlContentDetailed } from "../dist/w3c-validator.js";

async function withLocalNu(handler, action) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  const previousFetch = globalThis.fetch;
  try {
    process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL =
      "http://127.0.0.1:" + server.address().port + "/?out=json";
    return await action(previousFetch);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = previous;
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("local Nu mode sends XHTML only to configured loopback and retains counts", async () => {
  let received = "";
  let contentType = "";
  await withLocalNu(async (req, res) => {
    contentType = req.headers["content-type"];
    for await (const chunk of req) received += chunk.toString("utf8");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: [
      { type: "error", message: "A document error" },
      { type: "info", subType: "warning", message: "Review warning" },
    ] }));
  }, async () => {
    const original = globalThis.fetch;
    let remoteCalls = 0;
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith("https://")) {
        remoteCalls++;
        throw new Error("Remote W3C must not receive local-only markup");
      }
      return original(url, init);
    };
    const html = "<html xmlns=\"http://www.w3.org/1999/xhtml\"/>";
    const result = await validateHtmlContentDetailed(html, "application/xhtml+xml", "local");
    assert.equal(received, html);
    assert.match(contentType, /application\/xhtml\+xml/);
    assert.equal(remoteCalls, 0);
    assert.equal(result.checker, "nu_local");
    assert.deepEqual(result.counts, { error: 1, warning: 1, info: 0 });
    assert.equal(result.total, 2);
  });
});

test("auto mode uses local Nu on transient W3C 503", async () => {
  let localCalls = 0;
  await withLocalNu((req, res) => {
    localCalls++;
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ messages: [] }));
  }, async (original) => {
    let remoteCalls = 0;
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith("https://")) {
        remoteCalls++;
        return Promise.resolve(new Response("outage", { status: 503 }));
      }
      return original(url, init);
    };
    const result = await validateHtmlContentDetailed("<!doctype html><title>x</title>");
    assert.equal(result.checker, "nu_local");
    assert.deepEqual(result.counts, { error: 0, warning: 0, info: 0 });
    assert.equal(remoteCalls, 1);
    assert.equal(localCalls, 1);
  });
});

test("auto mode refuses fallback on malformed remote diagnostics", async () => {
  let localCalls = 0;
  await withLocalNu((req, res) => { localCalls++; req.resume(); res.end("{}"); }, async () => {
    globalThis.fetch = (url) => {
      if (String(url).startsWith("https://")) return Promise.resolve(Response.json({}));
      throw new Error("Unexpected local attempt");
    };
    await assert.rejects(
      validateHtmlContentDetailed("<!doctype html><title>x</title>"),
      /invalid response shape/,
    );
    assert.equal(localCalls, 0);
  });
});

test("local Nu configuration rejects non-loopback, credentials and path tricks", async () => {
  const saved = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  const bad = [
    "https://127.0.0.1:8888/",
    "http://localhost:8888/",
    "http://169.254.169.254:8888/",
    "http://user:pass@127.0.0.1:8888/",
    "http://127.0.0.1:8888/redirect",
    "http://127.0.0.1:8888/?follow=1",
  ];
  try {
    for (const setting of bad) {
      process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = setting;
      await assert.rejects(
        validateHtmlContentDetailed("<!doctype html><title>x</title>", "text/html", "local"),
        /loopback-only/,
        setting,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = saved;
  }
});

test("local Nu redirects and incomplete responses cannot produce clean verdicts", async () => {
  await withLocalNu((req, res) => {
    req.resume();
    res.writeHead(302, { Location: "https://example.com/" });
    res.end();
  }, async () => {
    await assert.rejects(
      validateHtmlContentDetailed("<!doctype html><title>x</title>", "text/html", "local"),
      /Local Nu HTML checker returned HTTP status 302|fetch failed/,
    );
  });
  await withLocalNu((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  }, async () => {
    await assert.rejects(
      validateHtmlContentDetailed("<!doctype html><title>x</title>", "text/html", "local"),
      /invalid response shape/,
    );
  });
});
