import assert from "node:assert/strict";
import test from "node:test";
import { validateCssContent } from "../dist/w3c-validator.js";

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
