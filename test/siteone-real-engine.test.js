import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/deep-audit-optional.mjs", import.meta.url));
const runOptIn = process.env.MCP_WEB_VALIDATOR_ENABLE_LIVE_SITEONE_TESTS === "1"
  && Boolean(process.env.MCP_WEB_VALIDATOR_SITEONE_BIN);

test("real SiteOne executable produces nonempty bounded JSON on an owned website",
  { skip: runOptIn ? false : "Real owned-site crawl explicitly opted out" },
  async () => {
    const { stdout } = await run(process.execPath, [
      script, "--engine=siteone", "--url=https://digestseo.com/",
      "--allow-host=digestseo.com", "--max-pages=1", "--execute",
    ], { timeout: 110_000, env: process.env, maxBuffer: 8_192 });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.engine, "siteone");
    assert.equal(result.urlsCrawled, 1);
    assert.ok(result.reportBytes >= 100);
    const reportPath = path.join(result.outputDirectory, "report.json");
    const data = JSON.parse(await readFile(reportPath, "utf8"));
    const metadata = await stat(reportPath);
    assert.equal(metadata.size, result.reportBytes);
    assert.equal(data.stats.totalUrls, 1);
    assert.equal(typeof data.crawler.version, "string");
    assert.ok(data.crawler.version.length > 1);
    assert.equal(data.error, undefined);
    assert.ok(Object.keys(data.stats.countByStatus).length >= 1);
  });
