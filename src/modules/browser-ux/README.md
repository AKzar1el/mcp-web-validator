# M03 - browser-ux (local)

**Owns:** V07-V09, V11-LAB, P1-10, P1-12. Local-only Chromium DOM comparison, resource failures, viewport parity, lab performance, media and interactive WCAG evidence.

- **Source:** `src/modules/browser-ux/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/browser-ux-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/screenshot.ts`, `src/screenshot-proxy.ts`; static accessibility checks in `src/seo-auditor.ts`.
- **Guardrail:** Browser/lab behavior stays local. Do not introduce browser automation or screenshots into the Worker. Field data is M06.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
