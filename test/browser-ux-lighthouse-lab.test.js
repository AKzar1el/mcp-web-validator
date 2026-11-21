import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  analyzeLighthouseLabResult, emptyLighthouseLabReview,
  MAX_LAB_HTML_BYTES, MAX_LAB_PROXY_REQUESTS,
} from "../dist/modules/browser-ux/lighthouse-lab.js";
import {
  sanitizeLighthouseLabHtml,
  startOfflineLighthouseProxy,
  inspectOfflineLighthouseLab,
  lighthouseSupportedNode,
} from "../dist/modules/browser-ux/lighthouse-lab-probe.js";

const fixture = {
  lighthouseVersion: "12.8.2",
  categories: { performance: { score: 0.83 } },
  audits: {
    "first-contentful-paint": { numericUnit: "millisecond", numericValue: 1140.123 },
    "largest-contentful-paint": { numericUnit: "millisecond", numericValue: 2920 },
    "total-blocking-time": { numericUnit: "millisecond", numericValue: 305 },
    "speed-index": { numericUnit: "millisecond", numericValue: 2110 },
    "cumulative-layout-shift": { numericUnit: "unitless", numericValue: 0.12345 },
  },
};
const codes = (r) => r.findings.map((f) => f.code);
const raw = `<!doctype html><html><head><title>Secret-Heading</title><style>h1{font-size:42px}</style></head>
<body><main><h1>PRIVATE V11 DATA</h1><img src="http://127.0.0.1:12345/hidden">
<button onclick="fetch('https://sensitive.test/private')">Click</button>
<script>globalThis.__script_should_never_run=true;fetch("https://sensitive.test/private")</script>
<iframe src="http://127.0.0.1:77/file"></iframe></main></body></html>`;

test("V11-LAB: pure Lighthouse extraction preserves real metric units and confidence", () => {
  const r = analyzeLighthouseLabResult(fixture, "mobile", 2);
  assert.equal(r.scope, "isolated_caller_supplied_html_lighthouse_lab");
  assert.equal(r.status, "complete");
  assert.equal(r.performance_score_percent, 83);
  assert.equal(r.metrics.fcp_ms, 1140.1);
  assert.equal(r.metrics.lcp_ms, 2920);
  assert.equal(r.metrics.tbt_ms, 305);
  assert.equal(r.metrics.speed_index_ms, 2110);
  assert.equal(r.metrics.cls, 0.123);
  assert.equal(r.requests_blocked, 2);
  assert(codes(r).includes("lab_score_review"));
  assert(codes(r).includes("lcp_review"));
  assert(codes(r).includes("cls_review"));
  assert(codes(r).includes("tbt_review"));
  assert.equal(r.scripts_disabled, true);
  assert.equal(r.network_isolated, true);
  assert(!JSON.stringify(r).includes("Secret"));
});

test("V11-LAB: Node version compatibility leaves older Web Validator installations intact", () => {
  assert.equal(lighthouseSupportedNode("22.12.0"), false);
  assert.equal(lighthouseSupportedNode("22.18.0"), false);
  assert.equal(lighthouseSupportedNode("22.19.0"), true);
  assert.equal(lighthouseSupportedNode("22.22.2"), true);
  assert.equal(lighthouseSupportedNode("24.0.0"), true);
  assert.equal(lighthouseSupportedNode("not-a-version"), false);
});

test("V11-LAB: missing audits remain null rather than fabricated zeros", () => {
  const r = analyzeLighthouseLabResult({ lighthouseVersion: "12.8.2", categories: { performance: { score: 0 } }, audits: {} });
  assert.equal(r.status, "partial");
  assert.equal(r.performance_score_percent, 0);
  assert.equal(r.metrics.lcp_ms, null);
  assert(codes(r).includes("metric_unavailable"));
});

test("V11-LAB: metric 0 is valid and does not produce spurious findings", () => {
  const z = {
    lighthouseVersion: "12.8.2",
    categories: { performance: { score: 1 } },
    audits: Object.fromEntries(Object.keys(fixture.audits).map((k) =>
      [k, { numericValue: 0, numericUnit: k === "cumulative-layout-shift" ? "unitless" : "millisecond" }])),
  };
  const r = analyzeLighthouseLabResult(z, "desktop");
  assert.equal(r.status, "complete");
  assert.equal(r.metrics.cls, 0);
  assert.equal(r.metrics.tbt_ms, 0);
  assert.equal(r.total_findings, 0);
});

test("V11-LAB: unreasonable metric values and unexpected units fail closed", () => {
  const bad = structuredClone(fixture);
  bad.audits["largest-contentful-paint"].numericValue = Number.NaN;
  bad.audits["first-contentful-paint"].numericUnit = "seconds";
  bad.audits["cumulative-layout-shift"].numericValue = -1;
  const r = analyzeLighthouseLabResult(bad);
  assert.equal(r.status, "partial");
  assert.equal(r.metrics.lcp_ms, null);
  assert.equal(r.metrics.fcp_ms, null);
  assert.equal(r.metrics.cls, null);
});

test("V11-LAB: runtime failures and absent reports never claim score", () => {
  for(const input of [null, undefined, { ...fixture, runtimeError: { message: "secret" } }]) {
    const r = analyzeLighthouseLabResult(input);
    assert.equal(r.status,"failed");
    assert.equal(r.performance_score_percent,null);
    assert(codes(r).includes("runtime_failed"));
    assert(!JSON.stringify(r).includes("secret"));
  }
});

test("V11-LAB: arbitrary report URLs, titles, trace paths and labels remain redacted", () => {
  const report = { ...fixture, finalDisplayedUrl:"https://private.example/?token=xyz",
    fetchTime:"2026-11-21T09:00:00Z", audits:{...fixture.audits, "html-has-lang": {details: "top secret"} } };
  const r = analyzeLighthouseLabResult(report);
  assert(!JSON.stringify(r).includes("private.example"));
  assert(!JSON.stringify(r).includes("token=xyz"));
  assert(!JSON.stringify(r).includes("2026-11-21"));
});

test("V11-LAB: bounded findings, unsupported form factors and counts fail closed", () => {
  assert.throws(() => analyzeLighthouseLabResult(fixture,"television"));
  assert.throws(() => analyzeLighthouseLabResult(fixture,"mobile", -1));
  assert.equal(analyzeLighthouseLabResult(fixture,"mobile", 1000).requests_blocked, MAX_LAB_PROXY_REQUESTS);
  assert.equal(emptyLighthouseLabReview("mobile").status, "failed");
});

test("V11-LAB: sanitizer strips executable tags and event handlers without removing inline CSS", () => {
  const html = sanitizeLighthouseLabHtml(raw);
  assert(!html.includes("<script"));
  assert(!html.includes("<iframe"));
  assert(!html.includes("onclick"));
  assert(!html.includes("globalThis"));
  assert(html.includes("<style>"));
  assert(html.includes("PRIVATE V11 DATA"));
  assert(!html.includes("srcdoc"));
});

test("V11-LAB: sanitizer rejects oversize UTF-8 or empty HTML", () => {
  for (const html of ["", "  ", "ž".repeat(Math.ceil(MAX_LAB_HTML_BYTES/2)+10)]) {
    assert.throws(() => sanitizeLighthouseLabHtml(html));
  }
});

async function getThroughProxy(proxy, target, method = "GET") {
  return new Promise((resolve, reject) => {
    const address = new URL(proxy.url);
    const request = http.request({
      hostname: address.hostname, port: Number(address.port),
      method, path: target,
      headers: { host: "v11-lighthouse.invalid" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode, text: Buffer.concat(chunks).toString("utf8"),
        csp: response.headers["content-security-policy"],
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
test("V11-LAB: network proxy serves only the single synthetic static page", async () => {
  const proxy = await startOfflineLighthouseProxy("<html>synthetic marker</html>");
  try {
    const ok = await getThroughProxy(proxy, "http://v11-lighthouse.invalid/");
    assert.equal(ok.status, 200);
    assert.match(ok.text, /synthetic marker/);
    assert.match(ok.csp, /script-src 'none'/);
    for (const forbidden of [
      "http://127.0.0.1:4444/admin", "https://other.example/",
      "http://v11-lighthouse.invalid/private", "http://v11-lighthouse.invalid/?auth=x",
    ]) {
      const r = await getThroughProxy(proxy, forbidden);
      assert.equal(r.status, 403);
      assert.equal(r.text, "");
    }
    assert.equal((await getThroughProxy(proxy, "http://v11-lighthouse.invalid/", "POST")).status, 403);
    assert.equal(proxy.deniedRequests(), 5);
    assert.equal(proxy.servedRequests(), 1);
  } finally { await proxy.close(); }
});

test("V11-LAB: fake browser runner verifies endpoint, proxy URL, isolation and cleanup", async () => {
  let browserClosed = false;
  let currentProxyUrl;
  const fixtureHtml = '<html><head><title>Fixture</title></head><body><main>Content</main></body></html>';
  const runtime = {
    browser: {
      async launch(proxyUrl) {
        currentProxyUrl = proxyUrl;
        assert(proxyUrl.startsWith("http://127.0.0.1:"));
        return {
          wsEndpoint: () => "ws://127.0.0.1:34021/devtools/browser/synthetic",
          async close() { browserClosed = true; },
        };
      },
    },
    async lighthouse(url, flags) {
      assert.equal(url, "http://v11-lighthouse.invalid/");
      assert.equal(flags.port, 34021);
      assert.equal(flags.onlyCategories[0], "performance");
      assert.equal(flags.formFactor, "desktop");
      assert.equal((await getThroughProxy({ url: currentProxyUrl }, url)).status, 200);
      assert.equal((await getThroughProxy({url: currentProxyUrl}, "http://127.0.0.1:2222/private")).status, 403);
      return { lhr: fixture };
    },
  };
  const report = await inspectOfflineLighthouseLab(fixtureHtml, "desktop", runtime);
  assert.equal(report.status, "complete");
  assert.equal(report.requests_blocked, 1);
  assert.equal(report.performance_score_percent, 83);
  assert.equal(browserClosed, true);
});

test("V11-LAB: no actual browser launch for invalid HTML or factor", async () => {
  await assert.rejects(inspectOfflineLighthouseLab("", "mobile"));
  await assert.rejects(inspectOfflineLighthouseLab("<h1>x</h1>", "tablet"));
});
