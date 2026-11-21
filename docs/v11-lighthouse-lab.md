# V11-LAB — guarded Lighthouse performance measurements

**Owner:** M03 `browser-ux`. **Runtime:** local Node/stdio `browser.lighthouse_lab` only. Hosted Cloudflare Worker cannot run Chromium/Lighthouse. **Scope:** real Google Lighthouse engine applied to one bounded **inert caller-supplied HTML fixture**, not a live site. V11-FIELD (CrUX real-user field data) remains separate.

## Why this scope

Lighthouse ordinarily audits a loaded webpage in Chrome. This initial Web Validator mode uses the actual Lighthouse performance engine while keeping the network and page scripts fully isolated. It is helpful for controlled HTML/CSS performance experiments and for validating that the lab engine works, but **not a substitute for testing the full production application with external assets, JavaScript, third-party resources or true customer network conditions**. A missing asset caused by the validator must never be labeled a website defect.

## One MCP call

```json
{
  "html": "<!doctype html><html><head><title>Static fixture</title><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{font-family:sans-serif}</style></head><body><main><h1>Fixture</h1><p>Measured in an isolated Lighthouse run.</p></main></body></html>",
  "form_factor": "mobile"
}
```

- `form_factor`: `mobile` or `desktop`; default `mobile`.
- `html`: at most **180,000 UTF-8 bytes**, including any inline CSS or data URI.
- Lighthouse runs **once** using the pinned sandboxed Chrome headless shell, CPU/network simulation and performance-only audit. The browser/proxy are closed at the end and there is a **75-second** browser deadline.
- A temporary Node HTTP proxy binds **only 127.0.0.1** on an ephemeral port, answering exactly one synthetic URL (`http://v11-lighthouse.invalid/`). Any other URL/method/path/query/CONNECT is rejected, with a maximum of 80 attempts recorded. Nothing is forwarded to the internet, LAN, filesystem, real localhost apps or external services.
- Supplied executable scripts, event handlers, frames, embeds, redirect metadata, base elements and linked stylesheet/preload tags are removed. The synthetic response additionally applies a strict no-script/no-network CSP. Inline CSS is preserved. This means source JavaScript and hydrated app behavior are not measured. No browser sandbox bypass flags are used.

## Report contract

Outputs are fixed, redacted, bounded metrics and findings:

- Actual Lighthouse performance score (`0–100`) when available.
- FCP, LCP, Speed Index and Total Blocking Time in milliseconds; Cumulative Layout Shift as a unitless number.
- Status `complete` only if the performance score and all five metrics exist; otherwise `partial` or `failed`, with unavailable metrics set to **null**, never invented zeros.
- Controlled review leads: lab score below 90, LCP above 2.5s, CLS above 0.1, TBT above 200ms. These are **lab checks of the isolated fixture**.
- Blocked resource attempt count is a **validator policy observation**, never a claimed production HTTP error.
- Fixed finding codes and messages, no raw page content, URLs, titles, audit trace/network URLs, cookies, resource paths, hidden payloads or timestamps.

A single Lighthouse run can vary due to machine load and emulated network/CPU conditions. No CrUX field percentile, INP, Google Core Web Vitals ranking status, SERP visibility, live performance SLO, Googlebot rendering behavior or regression causation can be inferred.

## Implementation and validation

- Pure result parser: `src/modules/browser-ux/lighthouse-lab.ts`.
- Protected temporary proxy and engine runner: `src/modules/browser-ux/lighthouse-lab-probe.ts`.
- MCP registration/response: `src/index.ts` and `src/presentation.ts`.
- Tests: `test/browser-ux-lighthouse-lab.test.js`, `test/mcp.integration.test.js`, `test/screenshot-browser-smoke.mjs` and `test/installed-package-smoke.mjs`.

The local package includes **Lighthouse 13.6.0 as an optional dependency**. V11-LAB requires **Node >=22.19** to run; the rest of the MCP tools and core package retain the existing Node >=22.12 support. The Linux stdio CI job remains on 22.12 to guard that baseline, while the real Lighthouse browser jobs use Node 22.22.2. This avoids shipping Lighthouse 12's transitive vulnerabilities or forcing a major Node requirement on every existing user. The hosted Worker does not import or execute Lighthouse. No npm publication, Cloudflare deploy, installed Codexify MCP activation or paid provider call is part of this development milestone.

Official references: <https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md> and <https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md>.
