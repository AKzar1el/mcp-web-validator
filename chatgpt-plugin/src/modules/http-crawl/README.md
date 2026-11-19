# M01 - http-crawl (hosted Worker)

**Owns:** V01-V05, P1-11, P1-13, P1-14.

- **Source:** `chatgpt-plugin/src/modules/http-crawl/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/http-crawl/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/network.ts`, `chatgpt-plugin/src/site-audit.ts`, `chatgpt-plugin/src/audits.ts`.
- **Guardrail:** Public HTTP(S) only. Honor SSRF/redirect/robots rules and site-audit caps; no browser or local files. M05 owns historical storage.

This directory is documentation-only; do not import local Node/browser modules or register new MCP tools during initialization.
