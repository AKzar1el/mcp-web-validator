# M02 - site-architecture (local)

**Owns:** V06, P1-02, P1-08. Internal-link graph, crawl depth, orphan hypotheses, multilingual canonical/hreflang clusters and link quality.

- **Source:** `src/modules/site-architecture/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/site-architecture-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** `src/seo-auditor.ts` link checks; hosted graph is `chatgpt-plugin/src/indexability-graph.ts`.
- **Guardrail:** Use M01 crawl observations; never classify unsampled/unreachable pages as confirmed orphans or indexing failures.

V06 `site.link_graph` and hosted `review_internal_link_graph` share one pure
bounded graph analyzer with ordinary navigation and contextual anchor edges,
sampled shortest-path depth, incoming-link coverage and possible orphan leads.
Optional guarded live mode checks robots.txt then up to three public pages.
Neither mode claims a full crawl, verified orphan or Google's indexing verdict.
See `docs/v06-internal-link-graph.md`.
