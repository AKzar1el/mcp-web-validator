# P1-05 - Citation, dataset, freshness and methodology consistency

**Status:** implemented in this feature branch, pending all tests and code review. **Owner:** M04 content-schema (local and hosted). Dependencies: P1-01 #459, P1-02 #461, P1-03 #464, P1-04 #465. Next roadmap item: P1-06, only after P1-05 passes acceptance.

## Supported input and provenance semantics

Local MCP tool: `content.provenance`. Hosted MCP tool: `verify_content_provenance`. Both process **1-8 caller-supplied static HTML pages** with `url` and `htmlContent`; both accept the same optional `evidence` manifest. Both are **offline**: a declared DOI, external source, methodology link or dataset URL is **not fetched**. There is no autonomous crawler, browser, search index, authentication, persisted history or AI interpretation.

Explicit markup inspected:

- Citation anchors in `<main>` or article/body fallback when marked `rel="cite"`, `data-citation-id`, or in a references/bibliography section, plus bounded Article/CreativeWork JSON-LD `citation` fields.
- Dataset declarations with `data-dataset-id`, optional `data-dataset-version`, `data-dataset-as-of`, `data-methodology-id`; and bounded schema.org Dataset JSON-LD `identifier`, `version`, `dateModified`.
- Methodology references `<a data-methodology-id="..." href="...">`, matched only when that ID and its URL are supplied in the manifest.
- Article dates in explicitly marked `article:published_time`, `article:modified_time`, `datePublished` and `dateModified` HTML/JSON-LD signals. Calendar-valid `YYYY-MM-DD` and timezone-qualified ISO timestamps are compared by UTC calendar date.

Example of opt-in supplied evidence (these are synthetic test identifiers, not verified external publications):

```json
{
  "pages": [
    {
      "url": "https://example.test/report",
      "htmlContent": "<html><main><a rel=\"cite\" data-citation-id=\"study_2026\" href=\"https://doi.org/10.1000/example\">Source</a><div data-dataset-id=\"sample_weekly\" data-dataset-version=\"v2\" data-dataset-as-of=\"2026-11-10\" data-methodology-id=\"weighted\"></div><a data-methodology-id=\"weighted\" href=\"https://example.test/methods\">Methods</a></main></html>"
    }
  ],
  "evidence": {
    "as_of": "2026-11-19",
    "sources": [{ "id": "study_2026", "url": "https://doi.org/10.1000/example" }],
    "datasets": [{ "id": "sample_weekly", "version": "v2", "as_of": "2026-11-10", "max_age_days": 14, "methodology_id": "weighted" }],
    "methodologies": [{ "id": "weighted", "url": "https://example.test/methods" }]
  }
}
```

## What is established vs unknown

- **Consistent with supplied evidence:** a citation ID points to its supplied safe URL, dataset version/snapshot date matches the supplied entry, methodology ID/link agrees, or dates are in order. Agreement is not proof that the source exists, is licensed, authentic, reliable or factually correct.
- **Observed inconsistency:** the same citation ID points to different URLs within the supplied sample; different page publication dates are declared; modification predates publication; an ISO date is invalid; or an explicitly supplied source/dataset/method entry disagrees with a claim. Contradictions are described as **relative to supplied evidence**, not an external truth verdict.
- **Potential freshness review:** snapshot age exceeds an explicitly supplied `max_age_days` threshold relative to the caller-selected `as_of` date. No arbitrary default threshold, no inference of a live dataset release, and no current time reading.
- **Unverified:** missing evidence ID, incomplete/unsafe URL label, unsupported prose or absent metadata. A missing manifest does not become a false negative clean bill of health.

The result returns only bounded counters and sanitized short finding codes/messages/page URLs/reference IDs. It never emits raw HTML, page text, credentialed/query-bearing URLs, cookies, tokens or the complete source manifest. Unknown evidence is tracked with `coverage_limited` and limitations. There is no site-wide claim.

## Runtime and security limits

- Maximum eight pages; **200,000 UTF-8 bytes/page** and **1,000,000 UTF-8 bytes total**.
- At most 24 supplied source entries, 16 datasets, 16 methodology records; IDs up to 64 ASCII characters and URL labels up to 512 characters with no query, fragments, credentials or nonstandard ports.
- Up to 48 structured declarations observed per page, five JSON-LD scripts (20 KB each), at most 12 returned findings, while retaining total finding count.
- No HTTP calls, SSRF possibilities, new API keys, Cloudflare storage, authentication grants, new worker route, costs or deployment. Hosted tool annotated read-only and closed-world.
- Source evidence must have unique IDs within each group to avoid an ambiguous "last entry wins" interpretation.
- Do not compare this feature with Google indexing/rankings, rephrase unknown metadata as certainty, or imply a successful remote citation check.

## Acceptance tests

- Local: `npm run build`, `npm run check`, `npm test`, manifest verification, genuine stdio `tools/list` and `content.provenance` calls, installed npm package offline smoke.
- Hosted: `npm run check`, `npm test`, `npm run deploy:dry-run`, actual Worker HTTP `tools/list` and `verify_content_provenance` calls.
- Adversarial: source/method URL mismatch, dataset version/date mismatch, invalid calendar and timezone behavior, data older than explicit threshold, no manifest, duplicate manifest IDs, hidden and script-only references, privacy/URL redaction, bounded UTF-8 and output, and unparsed JSON-LD.
- GitHub PR must have passing local stdio, Windows smoke, Ubuntu sandbox smoke and hosted Worker jobs plus security gates. Leave PR unmerged and do not deploy without separate authorization.
