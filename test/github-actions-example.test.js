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
    timeout: 15_000,
    env: { ...process.env, WEB_VALIDATOR_SERVER_PATH: server },
  });
}

test("copy-ready offline CI example passes without SEO errors and fails for actionable errors", { timeout: 40_000 }, async () => {
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
