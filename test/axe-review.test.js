import assert from "node:assert/strict";
import test from "node:test";
import { reduceAxeEvidence, unavailableAxeEvidence } from
  "../dist/modules/browser-ux/axe-review.js";

test("axe reducer emits only bounded IDs, impacts and counts, no raw page evidence", () => {
  const secret = "private-link-value-axexyz2026";
  const summary = reduceAxeEvidence({
    version: "4.14.1",
    violations: [{ id: "image-alt", impact: "serious",
      nodes: 2, help: secret, targets: [secret] }],
    incomplete: [{ id: "color-contrast", nodes: 1, html: secret }],
  });
  assert.equal(summary.status, "complete");
  assert.equal(summary.violations, 1);
  assert.equal(summary.incomplete, 1);
  assert.deepEqual(summary.rules, [{ rule: "image-alt", impact: "serious", nodes: 2 }]);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(summary.coverage_limited, true);
});

test("axe errors and malformed rule IDs cannot become clean confirmations", () => {
  assert.equal(unavailableAxeEvidence().status, "unavailable");
  assert.throws(() => reduceAxeEvidence({ violations: [], incomplete: undefined }),
    /missing result lists/);
  assert.throws(() => reduceAxeEvidence({
    violations: [{ id: "private<script>", nodes: 1 }], incomplete: [],
  }), /Invalid axe rule evidence/);
});
