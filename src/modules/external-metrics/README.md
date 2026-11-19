# M06 - external-metrics (local)

**Owns:** V11-FIELD; optional INT-GSC and INT-GA4 adapters. Authorized CrUX field performance and property-scoped GSC/GA4 or comparable metrics.

- **Source:** `src/modules/external-metrics/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/external-metrics-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** No CrUX/GSC/GA4 integration in this repository.
- **Guardrail:** No secrets, OAuth flow, API traffic or connector creation from scaffolding. Verify authorization and limits before implementation.

This directory is documentation-only; do not count it as a working SEO check or add MCP wiring without a separate request.
