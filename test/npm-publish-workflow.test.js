import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("npm release gate provisions the same pinned browser sandbox as local CI before publishing", () => {
  const source = readFileSync(path.join(root, ".github", "workflows", "publish-npm.yml"), "utf8");
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

  const stages = [
    "run: npm ci",
    "name: Build screenshot runtime",
    "name: Install pinned screenshot browser",
    "name: Allow only the pinned browser binary to create sandbox user namespaces",
    "name: Run package qualification",
    "name: Publish with npm trusted publishing",
  ];
  let previousIndex = -1;
  for (const stage of stages) {
    const index = source.indexOf(stage);
    assert(index > previousIndex, `Release step missing or out of order: ${stage}`);
    previousIndex = index;
  }

  assert.match(source, /runs-on:\s*ubuntu-24\.04/);
  assert.match(source, /resolveScreenshotBrowserExecutable/);
  assert.match(source, /chrome-headless-shell-linux64\/chrome-headless-shell/);
  assert.match(source, /sysctl -n kernel\.apparmor_restrict_unprivileged_userns/);
  assert.match(source, /app[a]?rmor_parser -r/);
  assert.match(source, /run: npm run check/);
  assert.match(source, /npm publish --provenance --access public/);

  assert.match(ci, /name: Install pinned screenshot browser/);
  assert.match(ci, /name: Allow only the pinned browser binary to create sandbox user namespaces/);
});
