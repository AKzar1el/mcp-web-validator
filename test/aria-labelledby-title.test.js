import assert from "node:assert/strict";
import test from "node:test";
import { auditSeoMetadata } from "../dist/seo-auditor.js";

test("aria-labelledby uses referenced title fallback", () => {
  const issues = auditSeoMetadata('<span id="label" title="Search"></span><input type="image" src="search.png" aria-labelledby="label">');
  assert.equal(issues.find((issue) => issue.code === "accessibility.input_image_alt.missing_or_empty"), undefined);
});
