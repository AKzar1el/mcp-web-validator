# P1-01 — same-language duplicate main-content evidence

**Status:** implemented on the local stdio API and hosted site-audit source, not automatically released. **Owner:** M04 `content-schema`. **Next gate:** P1-02 (16-locale hreflang and canonical clusters) only after this feature passes review and end-to-end tests.

## Interfaces

- Local MCP tool `content.duplicates`: accepts 1–8 pairs of an absolute **query-free, credential-free** HTTP(S) URL and caller-supplied static HTML (maximum 250,000 UTF-8 bytes/page and 1,000,000 UTF-8 bytes/call). It makes **no HTTP requests**. The URL is just an output label, not a crawl instruction.
- Hosted MCP `audit_public_site`: adds `content_duplicates` to the existing bounded site-audit result, based **only on the existing fetched page bodies**. There are **no new external calls**, assets, cookies, storage, browser execution, JavaScript rendering or change to the 8-page/robots/redirect limits. No standalone hosted tool is added.
- Shared comparison engine: `src/modules/content-schema/same-language-duplicates.ts` (pure, network-free TypeScript); each runtime uses a small Cheerio-based HTML observation adapter. The hosted bundle imports the pure engine rather than duplicating its matching algorithm.
- The site-audit result keeps the comparison optional in input snapshots so older `compare_site_audits` calls remain compatible. The comparison tool does **not** yet claim to compare duplicate-content findings across time; history is a separate P2 work item.

## What qualifies

1. Use the first non-inert `<main>` or `[role=main]`, then `<article>`, then static `<body>` only as a **lower-confidence fallback**. Exclude script/style/template, navigation, headers/footers, asides, forms, hidden and navigation-role elements. Static CSS-only visibility and JavaScript rendering are not assessed.
2. Require an explicit valid `<html lang>`. Compare the same primary language, but keep explicit scripts separate: `en-US` can match `en-GB`; `sr-Latn` must not be compared with `sr-Cyrl`. Unknown or unsupported languages are skipped, never inferred from the URL.
3. Require at least **80 segmented words**, at most **6,000 segmented words** and **120,000 characters** of main text. Unicode normalization is NFKC; comparisons ignore case and whitespace differences.
4. **Exact:** normalized main text matches fully (no truncation). **Near:** same-language texts with a word-count ratio at least **0.82**, a **five-word shingle Jaccard similarity at least 0.82**, and at least **20 distinct shingles** on each side. Near results are **potential**, not proof of Google duplicate detection or semantic equivalence.
5. Only compare different page URLs. Order exact pairs first, then highest similarity, then deterministically by URL. Report the **full total pair count**, preview at most **8 pairs**, and mark `pairs_truncated` whenever necessary.

## Evidence and limitations

The output includes `scope: sampled_pages_only`, sampled/eligible/skipped page counts, coverage flag, limitations, pair URL labels, language, similarity percentage, normalized word counts, match kind and confidence. **Never return page text, secret-bearing URL queries, URL userinfo or raw HTML.** URLs longer than 512 characters or containing query strings/credentials are skipped rather than mislabeled.

A clean sample is **not** a site-wide clean verdict. Comparisons do not cross `page_offset` batches, use LLM embeddings, infer search intent, decide Google canonical selection or detect dynamically rendered content. No result is retained by the hosted Worker. A separate P1-03 module will investigate empty, repeated-boilerplate and low-value page families.

## Verification

- Local: `npm run check`, `npm test`, `npm run build` and actual `content.duplicates` through the stdio MCP transport.
- Hosted: `npm run check`, `npm test` and `npm run deploy:dry-run`; verify a real MCP `audit_public_site` request through Worker request handling with a mocked bounded site/validator.
- Direct source tests: `test/content-schema-same-language-duplicates.test.js`, `chatgpt-plugin/src/modules/content-schema/same-language-duplicates.test.ts`. Host compatibility tests cover page-scope limits, unique pages, unknown language, cross-locale matching, script differences, short/oversized text, collision-safe shingle keys, no text leakage, capped output, and no extra network access.

New P1 checks must not be started on the same work branch before this feature's acceptance gates pass. Do not merge or deploy implicitly.
