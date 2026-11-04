import test from "node:test";
import assert from "node:assert/strict";
import { stripHopByHopHeaders } from "../dist/screenshot-proxy.js";

test("screenshot proxy removes Connection-nominated request fields and standard hop-by-hop headers", () => {
  const incoming = {
    host: "example.com",
    connection: "keep-alive, x-internal, x-extra",
    "x-internal": "private",
    "x-extra": "private-too",
    "proxy-authorization": "Basic should-not-forward",
    "proxy-authenticate": "Basic realm=proxy",
    "proxy-connection": "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    te: "trailers",
    trailer: "x-checksum",
    upgrade: "websocket",
    "content-type": "application/json",
    "x-end-to-end": "preserved",
  };

  assert.deepEqual(stripHopByHopHeaders(incoming), {
    host: "example.com",
    "content-type": "application/json",
    "x-end-to-end": "preserved",
  });
  assert.equal(incoming["x-internal"], "private", "original headers must not be mutated");
});

test("screenshot proxy removes case-insensitive response Connection tokens without stripping end-to-end fields", () => {
  const upstream = {
    Connection: ["close, X-Temporary", "X-Second"],
    "X-Temporary": "hop-only",
    "x-second": "also-hop-only",
    "Content-Length": "4",
    ETag: '"v1"',
    "X-End-To-End": "kept",
  };

  assert.deepEqual(stripHopByHopHeaders(upstream), {
    "Content-Length": "4",
    ETag: '"v1"',
    "X-End-To-End": "kept",
  });
});

test("screenshot proxy retains ordinary response metadata when Connection is absent", () => {
  assert.deepEqual(stripHopByHopHeaders({
    "content-type": "image/png",
    "cache-control": "max-age=60",
    "content-length": "10",
  }), {
    "content-type": "image/png",
    "cache-control": "max-age=60",
    "content-length": "10",
  });
});
