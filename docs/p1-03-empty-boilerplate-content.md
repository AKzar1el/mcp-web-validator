# P1-03 — empty, short and repetitive main-content families

**Owner:** M04 content-schema. **Stacked dependency:** P1-02 PR #461 (which is based on P1-01 PR #459). **Status:** implementation and tests in progress; do not merge or deploy automatically. Start P1-04 only after this PR's required checks and real MCP calls are green.

## Surfaces and boundaries

- Local offline MCP **content.quality** accepts 1–8 supplied HTML pages with absolute query-free HTTP(S) URL labels, at most 250,000 UTF-8 bytes/page and 1,000,000 bytes total. It never fetches websites, opens browsers, contacts an LLM, reads local paths, or stores data.
- Hosted **audit_public_site** includes a new `content_quality` result computed from existing ephemeral `mainContent` observations; no additional crawl requests, recipients, permissions, storage, routes, or tools. The existing robots/redirect/origin limits and 8-page maximum are unchanged.
- One shared deterministic engine in `src/modules/content-schema/empty-boilerplate-content.ts`. The Worker module re-exports it; the already-existing local and Worker main-content extractors strip navigation, headers, footers, forms, scripts, templates and hidden elements. No duplicated crawler or matching algorithm.
- Existing P1-01 exact/near-duplicate findings and P1-02 cluster findings remain independent; historical snapshot comparison accepts old results without the new optional `content_quality` field.

## Detection rules

1. **Empty static main text:** no more than two segmented words in an observed main/article/missing content region. It is an *observed static text condition*, not proof that JS-rendered content, charts or visual media are absent.
2. **Short main text:** 3–39 words in a main/article region. Always `confidence=potential`. Short product, contact, utility and navigation pages can still be very useful; do not score them automatically as bad.
3. **Empty families:** at least two nearly empty pages in an approximate non-root URL family. **Thin families:** at least three pages in an approximate family with at least 75% under 40 words. Root-level `/privacy` and `/contact` are unrelated; shared website origin alone does not create a family (regression #463). Sampling does not prove all pages in a family are affected.
4. **Repeated substantive boilerplate:** compare within the same explicit HTML language and approximate URL family, excluding repeated header/footer/navigation chrome. At least 60 words from repeated static text sentences or substantive paragraph blocks, comprising at least 65% of one nonidentical page's main text. Shared segments must be at least 12 words each; paragraph boundaries are preserved so unpunctuated 115-word repeated blocks are still detected (regression #463).
5. **Possible low standalone value:** at least 80% of the main text comprises those repeated substantive sentences, with fewer than 30 other words. Always `confidence=potential`; it is **not** a semantic or Google quality verdict.
6. Exact main-text duplicates are excluded from boilerplate reporting because P1-01 already identifies them. Unknown languages are not cross-compared and lead to reduced coverage.

## Evidence and limits

Output includes sampled/eligible/skipped page counts, approximate families compared, observed empty/short counts, repeated-boilerplate/low-unique-text candidate counts, capped findings with sanitized example URLs (at most 2 each), complete finding count, explicit limitations, and `scope: sampled_pages_only`. Never return raw main text, HTML snippets, userinfo, query strings or stored content.

Text size is bounded by 120k characters and 6,000 segmented words per page; at most 240 source paragraphs and 240 long sentence/block segments are processed for cross-page comparison. Truncation limits coverage. Unicode normalization and explicit script-sensitive language grouping are shared with P1-01. Sentence, paragraph-without-punctuation and conservative punctuation fallback behavior are covered by tests. A clean sample is not evidence of site-wide uniqueness, indexing, rankings or useful content.

## Acceptance

- Local: `npm run check`, `npm test`, `npm run build`, `npm run check:manifests`, actual stdio `content.quality` call and installed npm package smoke.
- Hosted: `npm run check`, `npm test`, `npm run deploy:dry-run`, real hosted Worker MCP request with bounded mocked sitemap and validator, and no extra target requests.
- Adversarial: genuine empty elements, script-only main, very short yet legitimate content, high-quality unique long pages, common chrome, unrelated empty root pages, sibling empty families, punctuation-free repeated paragraphs, language isolation, exact duplicates, URL secrets, oversized input, deterministic bounded outputs.
- PR: isolated branch targeting P1-02, full four-job GitHub CI and security checks. Never merge or publish implicitly.
