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
Browser-verified resource loading, viewport comparison, Lighthouse and
interactive WCAG checks are separate, still incomplete work.
