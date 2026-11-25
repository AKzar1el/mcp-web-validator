import assert from "node:assert/strict";
import test from "node:test";
import { buildDeepAuditPlan } from "../scripts/deep-audit-optional.mjs";

test("SiteOne integration is capped, single-threaded and free of LLM keys", () => {
  const result = buildDeepAuditPlan({
    engine: "siteone", url: "https://digestseo.com/",
    allowHost: "digestseo.com", maxPages: "4",
  });
  assert.equal(result.maxPages, 4);
  assert.ok(result.args.includes("--workers=1"));
  assert.ok(result.args.includes("--max-reqs-per-sec=1"));
  assert.ok(result.args.includes("--memory-limit=384M"));
  assert.ok(result.args.includes("--max-visited-urls=4"));
  assert.equal(result.args.some((arg) => arg.startsWith("--config-file=")), false);
  assert.equal(result.args.some((item) => /api-key|token|--ignore-robots/.test(item)), false);
});

test("unverified Unlighthouse is removed instead of pretending to run", () => {
  assert.throws(() => buildDeepAuditPlan({
    engine: "unlighthouse", url: "https://digestseo.com/",
    allowHost: "digestseo.com", maxPages: "2", paths: "/,/guide",
  }), /removed/);
});

test("deep audit rejects private origin, credentials, mixed hosts and unsafe paths", () => {
  const defaults = { engine: "siteone", allowHost: "digestseo.com", maxPages: 4 };
  for (const url of [
    "http://digestseo.com/", "https://127.0.0.1/", "https://example.local/",
    "https://digestseo.com/admin", "https://user:secret@digestseo.com/",
    "https://digestseo.com/?secret=1",
  ]) {
    assert.throws(() => buildDeepAuditPlan({ ...defaults, url }));
  }
  assert.throws(() => buildDeepAuditPlan({ ...defaults,
    url: "https://digestseo.com/", allowHost: "other.example" }), /allow-host/);
  assert.throws(() => buildDeepAuditPlan({ ...defaults,
    url: "https://digestseo.com/", maxPages: 100 }), /1..4/);
  for (const paths of ["/,/../../secret", "//evil.com", "/%2e%2e/", "/,/guide?token=1"]) {
    assert.throws(() => buildDeepAuditPlan({
      engine: "siteone", url: "https://digestseo.com/",
      allowHost: "digestseo.com", maxPages: 4, paths,
    }), /does not accept explicit paths/);
  }
});
