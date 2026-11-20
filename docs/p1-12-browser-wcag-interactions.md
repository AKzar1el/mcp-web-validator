# P1-12 — Local browser keyboard and WCAG interaction evidence

**Owner:** M03 `browser-ux`. **Runtime:** local Node/stdio only, `browser.wcag`. **Status:** working, intentionally **partial**. The hosted Cloudflare Worker does not launch a browser.

## What the tool actually does

Accepts **caller-supplied HTML markup** and launches a fresh pinned, sandboxed Chrome Headless Shell using the existing screenshot browser runtime (`src/screenshot.ts`). Unlike `screenshot.capture`, it does not accept a URL or file path, navigate to any site, create screenshots, or write report files. It renders a single isolated HTML sample at a bounded viewport and:

- samples the rendered DOM for visible controls with missing simple accessible-name signals (text, `aria-label`, `aria-labelledby`, associated `label`, images' `alt`, or `title`), positive `tabindex`, focusable `aria-hidden` content, and custom ARIA interactive roles without an exposed keyboard Tab stop;
- sends **Tab only**, up to 24 times, to sample actual focus order and the computed outline/box-shadow and viewport intersection for focused controls;
- if a sampled native `<summary>` receives keyboard focus, uses **Enter on a native disclosure only**, observing whether its parent `<details>` toggles;
- reports only numeric control indices, booleans/counters, fixed rule codes/messages and explicit limitations; input HTML, text, styles, IDs, URLs and filenames are never echoed.

These are **review leads**, not automatic WCAG failures. A CSS border/background highlight could be a valid visible focus indicator even if no outline or box-shadow appears. Labels can be computed from sources beyond this conservative heuristic, and assistive-technology accessibility trees may differ.

## Security and privacy boundaries

- **No live website/remote URL inputs**, local file reads, request authorization, browser profile reuse, screenshots, source-code output, storage, or external validators.
- The tool sanitizes active `script`, embedded `iframe`/`frame`/`object`/`embed`/`portal`, and meta refresh markup; strips HTML `on*` handler attributes; disables browser JavaScript before injecting the HTML.
- It intercepts and aborts **every page request**, and launches via an intentionally non-listening proxy (`127.0.0.1:9`). No DNS/SSRF-capable browsing or external resource fetch path is introduced. Chromium itself may need to be **installed** using the existing pinned browser installer on first use; that is browser provisioning, not page-resource access.
- No link activation, button clicking, text entry, arbitrary Enter/Space, form submission, dynamic JS interaction or DOM data mutation outside this temporary in-memory page. Only the native summary disclosure may be toggled.
- In a failed browser launch, the tool returns a **structured error** and `browser_executed: false` rather than a fabricated pass. Never disable the Chromium sandbox to repair a launch failure.

## Input contract

```json
{
  "htmlContent": "<!doctype html><html><body><button aria-label=\"Open\">Open</button><details><summary>More</summary>Extra details</details></body></html>",
  "viewportWidth": 960,
  "viewportHeight": 720,
  "maxTabSteps": 8
}
```

Input: nonempty HTML capped at **180,000 UTF-8 bytes**; width 320–1440, height 360–1080 CSS pixels; Tab samples 1–24 (default 24). Examines at most **120 DOM controls**; returns at most **12 prioritized findings**, with true counts, truncation flags, and `coverage_limited: true`.

## Evidence, limitations and WCAG references

W3C's [WCAG 2.2](https://www.w3.org/TR/WCAG22/) covers keyboard operation (2.1.1), keyboard traps (2.1.2), [Focus Visible (2.4.7)](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible) and [Focus Not Obscured (2.4.11)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum). This tool samples some *related evidence*, not all normative conditions. In particular:

- It cannot prove a complete keyboard pathway or **absence of keyboard traps** with only a bounded Tab subset.
- Supplied scripts are never executed; therefore JS-driven menus, accordions, dialogs, keyboard shortcuts, focus management, form validation and live states remain **unverified**.
- Author-supplied external assets are never fetched, so missing external CSS, fonts and images can change focus indicators and layout. Focus intersection is not a full occlusion test.
- The heuristic does not reconstruct the entire platform accessibility tree, spoken screen-reader output, focus-indicator contrast/area, touch operation, or cross-browser parity.
- An empty findings array means **no flagged issues among sampled signals**, not WCAG AA/AAA conformance.

Use a fully styled, authorized live browser, assistive technologies, human review and standard accessibility test procedures for release decisions.

## Verification

Run `npm run check` from the root (unit, module and actual local MCP/stdio protocol checks) and `npm run check:manifests` for 21-tool manifest synchronization. The injectable `ScreenshotBrowserRuntime` test double verifies script disabling, request interception, Tab-only activation, disclosure behavior, safe cleanup, byte caps and redacted results.

Real Chromium verification is part of the existing `test/screenshot-browser-smoke.mjs` (run on **Windows and Ubuntu GitHub CI**). The distributed-package smoke `test/installed-package-smoke.mjs` also calls the real new MCP tool when the screenshot browser is available. On a machine unable to launch the pinned browser, use `MCP_SMOKE_SKIP_SCREENSHOT=1` for offline package smoke and **do not** claim local browser verification.

No hosted Worker tool, deployment, npm release or browser/Chromium security-policy override was introduced.
