# M02 - site-architecture (hosted Worker)

**Owns:** V06, P1-02, P1-08.

- **Source:** `chatgpt-plugin/src/modules/site-architecture/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `chatgpt-plugin/src/modules/site-architecture/<feature-slug>.test.ts` (discovered by Vitest).
- **Reuse:** `chatgpt-plugin/src/indexability-graph.ts`, `chatgpt-plugin/src/site-audit.ts`.
- **Guardrail:** Keep graph findings sample-scoped. Never assert full link depth, orphan status, or indexing from absent pages.

V06 `review_internal_link_graph` uses the shared pure analyzer in
`internal-link-graph.ts` plus `internal-link-graph-probe.ts` for bounded
public robots-gated fetches with the existing per-attempt site-audit limiter.
The main Worker alone registers the tool. No Node-only browser imports,
historical storage, complete-crawl or indexing-verdict claims.
