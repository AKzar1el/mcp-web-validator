import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const widgetSource = readFileSync(new URL("../chatgpt-plugin/src/widget.ts", import.meta.url), "utf8");
const start = widgetSource.indexOf("function asObject(value)");
const end = widgetSource.indexOf("function statusPresentation(", start);
assert.ok(start >= 0 && end > start, "Widget overview helpers must be present in the actual embedded resource");

// Exercise the exact JavaScript shipped inside WIDGET_HTML rather than a copy of its logic.
const sandbox = vm.createContext({});
vm.runInContext(`
  const currentLocale = "en-US";
  const countLabels = {};
  const kindLabels = { site: "Site audit", validation: "Validation" };
  ${widgetSource.slice(start, end)}
  globalThis.normalize = normalizeOverview;
`, sandbox);
const normalize = sandbox.normalize;

test("legacy site result without issue_groups remains a site audit", () => {
  const overview = normalize({ pages_selected: 1, pages_audited: 1 });
  assert.equal(overview.kind, "site");
  assert.equal(overview.status, "clean");
});

test("legacy all-failed site audit never claims a passing result or an invented score", () => {
  const overview = normalize({ pages_selected: 1, pages_audited: 0, pages_failed: 1, issue_groups: [] });
  assert.equal(overview.status, "failed");
  assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
});

test("legacy mixed completed and failed pages are marked partial", () => {
  const overview = normalize({ pages_selected: 2, pages_audited: 1, pages_failed: 1, issue_groups: [] });
  assert.equal(overview.status, "partial");
  assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
});

test("legacy partial validation without completed pages does not claim success", () => {
  const overview = normalize({ pages_selected: 1, pages_audited: 0, pages_partial: 1, issue_groups: [] });
  assert.equal(overview.status, "partial");
  assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
});

test("legacy unexplained incomplete coverage remains partial", () => {
  const overview = normalize({ pages_selected: 2, pages_audited: 1, issue_groups: [] });
  assert.equal(overview.status, "partial");
});

test("legacy completed audit preserves a real score of zero", () => {
  const overview = normalize({ pages_selected: 1, pages_audited: 1, issue_groups: [], audit_health_score: 0 });
  assert.equal(overview.status, "clean");
  assert.equal(overview.counts.audit_health_score, 0);
});

test("legacy score is absent when it is invalid, not silently replaced by zero", () => {
  for (const audit_health_score of [-1, Infinity, "0"]) {
    const overview = normalize({ pages_selected: 1, pages_audited: 1, issue_groups: [], audit_health_score });
    assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
  }
});

test("explicit hosted overview status and counts remain authoritative", () => {
  const overview = normalize({
    pages_selected: 2, pages_audited: 1, pages_failed: 1, issue_groups: [],
    overview: { kind: "site", status: "issues", counts: { pages_failed: 1 } },
  });
  assert.equal(overview.status, "issues");
  assert.equal(overview.counts.pages_failed, 1);
  assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
});

test("partial hosted overview inherits only real legacy scores", () => {
  const overview = normalize({
    pages_selected: 2, pages_audited: 1, pages_failed: 1, issue_groups: [],
    overview: { kind: "site", status: "partial" },
  });
  assert.equal(overview.status, "partial");
  assert.equal(Object.hasOwn(overview.counts, "audit_health_score"), false);
});

test("non-site validation fallback remains unchanged", () => {
  const overview = normalize({ errors: [] });
  assert.equal(overview.kind, "validation");
  assert.equal(overview.status, "clean");
});
