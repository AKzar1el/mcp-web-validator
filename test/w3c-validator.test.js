import assert from "node:assert/strict";
import test from "node:test";
import { validateCssContent, validateHtmlContent } from "../dist/w3c-validator.js";

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
          subtype: "warning",
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
      },
    ]);
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
