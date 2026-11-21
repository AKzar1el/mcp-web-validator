# M03 - browser-ux (local)

**Owns:** V07-V09, V11-LAB, P1-10, P1-12. Local-only Chromium DOM comparison, resource failures, viewport parity, lab performance, media and interactive WCAG evidence.

- **Source:** `src/modules/browser-ux/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/browser-ux-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/screenshot.ts`, `src/screenshot-proxy.ts`; static accessibility checks in `src/seo-auditor.ts`.
- **Guardrail:** Browser/lab behavior stays local. Do not introduce browser automation or screenshots into the Worker. Field data is M06.

P1-10 now provides a real **local-only static** media analyzer at
`media-diagnostics.ts`, exposed through the local `media.diagnostics` MCP
tool. It inspects supplied markup without launching Chromium or fetching
media; see `docs/p1-10-media-diagnostics.md` for exact evidence and bounds.
P1-12 now provides a real local-only `browser.wcag` tool powered by fresh
sandboxed Chromium with scripts disabled and all document requests blocked.
It samples rendered control names, focus styling and keyboard Tab targets
and safely toggles one native `<details><summary>` disclosure. No arbitrary
buttons or links are activated and no forms are submitted. Full dynamic
JavaScript behavior, assistive-technology coverage and WCAG certification
remain outside the tool; see `docs/p1-12-browser-wcag-interactions.md`.

V11-LAB now adds local-only `browser.lighthouse_lab` using the genuine
Lighthouse engine against one caller-supplied static HTML document in the
existing pinned sandboxed Chromium. A single-response loopback-only proxy
blocks all external requests; executable scripts, frames and network loads
are removed. The numeric performance score and FCP/LCP/TBT/CLS/Speed Index
are strictly isolated **lab** evidence, not a real production or CrUX result.
See `docs/v11-lighthouse-lab.md` for limits and sample use.

V07 adds local `browser.dom_diff`: compare caller-supplied raw versus rendered
HTML snapshots, or obtain a bounded DOM snapshot with only inline scripts in
fresh network-denied Chromium. A separate robots-gated public HTML sample is
available but external JavaScript/CSS/API resources are not loaded; it is not
Google WRS or a full-resource browser render. See
`docs/v07-raw-rendered-dom.md`.

V08 adds local `browser.resource_failures` with bounded redacted browser
network events, reusing the pinned Chromium and public HTTP proxy. It separates
real site HTTP 4xx/5xx, transport failures, explicit validator-policy blocks
and pending requests. Live mode checks robots.txt and caps observed requests;
third-party fetch is explicitly opt-in. No storage, full HAR, Googlebot
impersonation or causal SEO/indexing verdict. See
`docs/v08-browser-resource-failures.md`.

V09 adds local `browser.viewport_parity`: compare one caller-supplied or
robots-gated public HTML page in two fresh sandboxed mobile/desktop Chromium
viewport pages, with scripts disabled and all network resources denied.
Reports CSS visibility versus DOM presence, responsive navigation and
overflow, metadata differences, capped keyboard steps and one safe native
disclosure tap/Enter. It does not emulate fully hydrated sites, Google WRS,
live accessibility behavior, whole-site coverage or indexing decisions.
See `docs/v09-mobile-desktop-parity.md`.
