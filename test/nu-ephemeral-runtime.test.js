import assert from "node:assert/strict";
import test from "node:test";
import { validateHtmlContentDetailed } from "../dist/w3c-validator.js";

const java = process.env.MCP_WEB_VALIDATOR_NU_JAVA_PATH;
const realRuntime = { skip: java ? false : "No opt-in standalone Nu Java runtime supplied" };
const invalidHtml = '<!doctype html><html lang="en"><head><title>Test</title></head>' +
  '<body><img src="/alt-missing.png"></body></html>';
const validXhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" ' +
  'lang="en"><head><title>XML fixture</title></head><body><p>Valid</p></body></html>';

test("real Nu on-demand detects HTML defects offline and leaves no listener", realRuntime, async () => {
  const prior = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  const originalFetch = globalThis.fetch;
  let remoteCalls = 0;
  let checkerUrl = "";
  try {
    delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    globalThis.fetch = (url, options) => {
      const target = String(url);
      if (target.startsWith("https://")) {
        remoteCalls++;
        throw new Error("No public W3C calls permitted in this test");
      }
      if (target.startsWith("http://127.0.0.1:")) checkerUrl = target;
      return originalFetch(url, options);
    };
    const result = await validateHtmlContentDetailed(invalidHtml, "text/html", "local");
    assert.equal(result.checker, "nu_local");
    assert.ok(result.counts.error >= 1, "Nu should find missing img alt");
    assert.ok(result.messages.some((item) => /alt.*attribute/i.test(item.message)));
    assert.equal(remoteCalls, 0);
    assert.match(checkerUrl, /^http:\/\/127\.0\.0\.1:\d+/);
    await assert.rejects(originalFetch(checkerUrl, {
      signal: AbortSignal.timeout(1500),
    }), /fetch failed|abort|connect/i, "Nu listener must be gone after request");
  } finally {
    globalThis.fetch = originalFetch;
    if (prior === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = prior;
  }
});

test("real local Nu parses XHTML as XML, without HTML parser false positives", realRuntime, async () => {
  const prior = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  try {
    delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    const result = await validateHtmlContentDetailed(
      validXhtml, "application/xhtml+xml", "local");
    assert.equal(result.checker, "nu_local");
    assert.equal(result.counts.error, 0);
    assert.ok(result.total < 12);
  } finally {
    if (prior === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = prior;
  }
});

test("auto mode falls back to real Nu after a simulated W3C service outage", realRuntime, async () => {
  const previous = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  const originalFetch = globalThis.fetch;
  let remoteCalls = 0;
  try {
    delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    globalThis.fetch = (url, opts) => {
      if (String(url).startsWith("https://validator.w3.org/")) {
        remoteCalls++;
        return Promise.resolve(new Response("temporary failure", { status: 503 }));
      }
      return originalFetch(url, opts);
    };
    const outcome = await validateHtmlContentDetailed(invalidHtml, "text/html", "auto");
    assert.equal(outcome.checker, "nu_local");
    assert.ok(outcome.counts.error >= 1);
    assert.equal(remoteCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = previous;
  }
});

test("local Nu serializes simultaneous requests to bound temporary Java memory", realRuntime, async () => {
  const previous = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  try {
    delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    const first = validateHtmlContentDetailed(invalidHtml, "text/html", "local");
    await assert.rejects(
      validateHtmlContentDetailed(invalidHtml, "text/html", "local"),
      /already running/,
    );
    const result = await first;
    assert.equal(result.checker, "nu_local");
    assert.ok(result.counts.error >= 1);
  } finally {
    if (previous === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = previous;
  }
});

test("a missing local Nu Java path never produces a clean verdict", async () => {
  const previousJava = process.env.MCP_WEB_VALIDATOR_NU_JAVA_PATH;
  const previousUrl = process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
  try {
    delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    process.env.MCP_WEB_VALIDATOR_NU_JAVA_PATH = "/definitely/not/a/java.exe";
    await assert.rejects(
      validateHtmlContentDetailed(invalidHtml, "text/html", "local"),
      /HTML validation failed/,
    );
  } finally {
    if (previousJava === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_JAVA_PATH;
    else process.env.MCP_WEB_VALIDATOR_NU_JAVA_PATH = previousJava;
    if (previousUrl === undefined) delete process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL;
    else process.env.MCP_WEB_VALIDATOR_NU_LOCAL_URL = previousUrl;
  }
});
