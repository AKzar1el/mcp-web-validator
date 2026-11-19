# M06 - external-metrics (hosted Worker)

**Owns:** V11-FIELD; optional INT-GSC and INT-GA4 adapters.

- **Source:** `chatgpt-plugin/src/modules/external-metrics/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/external-metrics/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** No live CrUX, GSC or GA4 integrations in this repository.
- **Guardrail:** Explicit opt-in external API permissions, property scoping and cost limits are required; no credentials or Cloudflare bindings in this branch.

This directory is documentation-only; do not import local Node/browser modules or register new MCP tools during initialization.
