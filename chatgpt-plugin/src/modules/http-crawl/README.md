# M01 - http-crawl (hosted Worker)

**Owns:** V01-V05, P1-11, P1-13, P1-14.

- **Source:** `chatgpt-plugin/src/modules/http-crawl/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/http-crawl/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/network.ts`, `chatgpt-plugin/src/site-audit.ts`, `chatgpt-plugin/src/audits.ts`.
- **Guardrail:** Public HTTP(S) only. Honor SSRF/redirect/robots rules and site-audit caps; no browser or local files. M05 owns historical storage.

P1-11's Worker-safe `non-html-directives.ts` adapter reuses the pure analysis
contract from the local M01 module; hosted MCP `review_http_directives` runs
**offline** on supplied response metadata. No Node APIs, browser, external
binary fetch, additional storage or permission is introduced. See
`docs/p1-11-non-html-http-directives.md`. Live non-HTML HTTP probing remains
future M01 work.
