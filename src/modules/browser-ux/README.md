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

Browser-verified live resource loading, viewport comparison and Lighthouse
remain separate M03 work.
