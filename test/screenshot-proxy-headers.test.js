import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { pipeScreenshotUpstreamResponse, stripHopByHopHeaders } from "../dist/screenshot-proxy.js";

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

test("screenshot proxy tears down partial responses on upstream stream error or abort", () => {
  for (const event of ["error", "aborted"]) {
    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { connection: "close", "content-type": "text/plain" };
    upstream.complete = false;
    const downstream = new PassThrough();
    downstream.headersSent = false;
    downstream.writeHead = (status, headers) => {
      assert.equal(status, 200);
      assert.deepEqual(headers, { "content-type": "text/plain" });
      downstream.headersSent = true;
    };

    pipeScreenshotUpstreamResponse(upstream, downstream);
    assert.equal(downstream.headersSent, true);
    upstream.emit(event, new Error("connection interrupted"));
    assert.equal(downstream.destroyed, true, `${event} must stop truncated success`);
  }
});

test("screenshot proxy cancels an unfinished upstream when downstream closes", () => {
  const upstream = new PassThrough();
  upstream.statusCode = 200;
  upstream.headers = { "content-type": "text/plain" };
  upstream.complete = false;
  const downstream = new PassThrough();
  downstream.writeHead = () => {};
  pipeScreenshotUpstreamResponse(upstream, downstream);
  downstream.emit("close");
  assert.equal(upstream.destroyed, true);
});
