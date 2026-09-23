import assert from "node:assert/strict";
import test from "node:test";
import {
  getW3CMessageSeverity,
  validateCssContent,
  validateHtmlContent,
} from "../dist/w3c-validator.js";

test("Nu non-document-error messages retain error severity", () => {
  assert.equal(
    getW3CMessageSeverity({ type: "non-document-error" }),
    "error",
  );
});

test("missing HTML validator messages fail instead of producing a clean result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });

  try {
    await assert.rejects(
      validateHtmlContent("<!doctype html><html><title>Example</title></html>"),
      /HTML validation failed: W3C HTML validator returned an invalid response shape/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed HTML validator messages fail instead of being silently dropped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      messages: [
        { type: "error", message: "Bad element" },
        { type: "error" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    await assert.rejects(
      validateHtmlContent("<!doctype html><html><body></body></html>"),
      /HTML validation failed: W3C HTML validator returned a malformed message/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML validator normalizes upstream messages to the advertised contract", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      messages: [
        {
          type: "error",
          message: "Bad element",
          firstLine: 4,
          firstColumn: 2,
          lastLine: 4,
          lastColumn: 9,
          extract: "<badtag>",
          subType: "warning",
          url: "https://example.com/",
          hiliteStart: 1,
          hiliteLength: 8,
          offset: 0,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const messages = await validateHtmlContent("<!doctype html><html><body></body></html>");
    assert.deepEqual(messages, [
      {
        type: "error",
        message: "Bad element",
        firstLine: 4,
        firstColumn: 2,
        lastLine: 4,
        lastColumn: 9,
        extract: "<badtag>",
        subType: "warning",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML validator reports full totals when structured diagnostics are capped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    messages: Array.from({ length: 205 }, (_, index) => ({
      type: "error",
      message: `Issue ${index + 1}`,
    })),
  });

  try {
    const validatorModule = await import("../dist/w3c-validator.js");
    assert.equal(typeof validatorModule.validateHtmlContentDetailed, "function");
    const result = await validatorModule.validateHtmlContentDetailed("<!doctype html><title>Test</title>");
    assert.equal(result.messages.length, 200);
    assert.equal(result.total, 205);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.counts, { error: 205, warning: 0, info: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML validator preserves XHTML media type for Nu checker requests", async () => {
  const originalFetch = globalThis.fetch;
  let observedContentType;
  globalThis.fetch = async (_url, init) => {
    observedContentType = new Headers(init?.headers).get("content-type");
    return Response.json({ messages: [] });
  };

  try {
    const validatorModule = await import("../dist/w3c-validator.js");
    await validatorModule.validateHtmlContentDetailed(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Example</title></head><body /></html>',
      "application/xhtml+xml",
    );
    assert.equal(observedContentType, "application/xhtml+xml; charset=utf-8");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty CSS validator responses fail instead of producing a clean result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("  \n", { status: 200 });

  try {
    await assert.rejects(
      validateCssContent("body { color: black; }"),
      /CSS validation failed: W3C CSS validator returned an empty response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing CSS validator envelope fails instead of producing a clean result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });

  try {
    await assert.rejects(
      validateCssContent("body { color: black; }"),
      /CSS validation failed: W3C CSS validator returned an invalid response shape/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSS validator reports full totals when structured diagnostics are capped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    cssvalidation: {
      errors: Array.from({ length: 205 }, (_, index) => ({
        line: index + 1,
        type: "property",
        message: `Issue ${index + 1}`,
        context: ".card",
      })),
    },
  });

  try {
    const validatorModule = await import("../dist/w3c-validator.js");
    assert.equal(typeof validatorModule.validateCssContentDetailed, "function");
    const result = await validatorModule.validateCssContentDetailed("body { color: black; }");
    assert.equal(result.messages.length, 200);
    assert.equal(result.total, 205);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.counts, { error: 205, compatibilityLimitation: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CSS validator marks Jigsaw's known @container parser gap without hiding the upstream diagnostic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      cssvalidation: {
        errors: [
          {
            line: 1,
            type: "at-rule",
            message: "Unrecognized at-rule “@container”",
            context: "",
          },
          {
            line: 2,
            type: "property",
            message: "Property frobnicate doesn't exist",
            context: ".card",
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const messages = await validateCssContent("@container card (inline-size > 30em) { .card { frobnicate: 1; } }");
    assert.deepEqual(messages, [
      {
        line: 1,
        type: "error",
        message: "Unrecognized at-rule “@container”",
        context: undefined,
        compatibility: "known-validator-limitation",
      },
      {
        line: 2,
        type: "error",
        message: "Property frobnicate doesn't exist",
        context: ".card",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
