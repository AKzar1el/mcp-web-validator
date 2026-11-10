import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(root, "examples", "github-actions", "check-metadata.mjs");
const server = path.join(root, "dist", "index.js");

function run(input) {
  return spawnSync(process.execPath, [script, input], {
    cwd: root,
    encoding: "utf8",
    timeout: 35_000,
    // Parallel Windows tests can delay stdio MCP startup beyond the example's 20s default.
    // Use a bounded test-only allowance; the documented consumer default is unchanged.
    env: {
      ...process.env,
      WEB_VALIDATOR_SERVER_PATH: server,
      WEB_VALIDATOR_CI_REQUEST_TIMEOUT_MS: "30000",
    },
  });
}

test("copy-ready offline CI example passes without SEO errors and fails for actionable errors", { timeout: 110_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webvalidator-ci-"));
  try {
    const htmlPath = path.join(dir, "index.html");
    await writeFile(htmlPath, `<!doctype html><html lang="en"><head>
      <title>Example Metadata Validation Website for Local Integration Testing</title>
      <meta name="description" content="This is an example website used to verify the documented continuous integration metadata workflow without a remote provider or network audit.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="canonical" href="https://example.com/">
      <meta property="og:title" content="Example Metadata Validation">
      <meta property="og:image" content="https://example.com/preview.png">
    </head><body><h1>Example Metadata Validation</h1></body></html>`);
    const passing = run(htmlPath);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /Web Validator metadata: 0 errors,/);

    await writeFile(htmlPath, "<!doctype html><html><body><img src='photo.png'></body></html>");
    const failing = run(htmlPath);
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stderr, /Metadata gate failed/);
    assert.match(failing.stderr, /accessibility\.image_alt\.missing/);
    assert.match(failing.stdout, /Web Validator metadata: [1-9]\d* errors,/);

    const missing = run(path.join(dir, "missing.html"));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Metadata gate could not finish/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline CI example reports a stalled MCP handshake instead of hanging indefinitely", { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webvalidator-stalled-ci-"));
  try {
    const htmlPath = path.join(dir, "index.html");
    const stalledServer = path.join(dir, "stalled-server.mjs");
    await writeFile(htmlPath, "<!doctype html><html lang='en'><head><title>Offline Gate</title></head><body></body></html>");
    // Keep stdio open without sending an MCP initialize response; exit eventually if the parent is killed.
    await writeFile(stalledServer, "process.stdin.resume(); setTimeout(() => process.exit(0), 7000);\n");
    const result = spawnSync(process.execPath, [script, htmlPath], {
      cwd: root,
      encoding: "utf8",
      // Windows CI can take several seconds just to start another Node process under parallel tests.
      timeout: 25_000,
      env: {
        ...process.env,
        WEB_VALIDATOR_SERVER_PATH: stalledServer,
        WEB_VALIDATOR_CI_REQUEST_TIMEOUT_MS: "750",
      },
    });
    assert.equal(result.status, 2, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /Metadata gate could not finish:/);
    assert.match(result.stderr, /timed out/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
