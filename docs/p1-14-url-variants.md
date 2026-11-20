# P1-14 — Bounded URL variant, redirect and canonical evidence

**Owner:** M01 `http-crawl`. **Runtimes:** local stdio `http.variants`; hosted Worker `review_url_variants`. **Status:** working but intentionally **partial**, requiring caller-supplied response evidence. No website fetching, SSRF-capable URL probe, Google indexing or canonical selection claims.

## Purpose and evidence

Compares one explicitly chosen **query-free reference URL** with **1–12 actual caller-observed response records** in its tightly bounded URL family. The exact reference must itself be present among those observations. The family accepts **only** the same candidate path after removing one optional trailing slash and ASCII case-folding *for the purpose of choosing comparison candidates*. Only the exact hostname or its single `www.` / apex counterpart is allowed. HTTP and HTTPS are both accepted. Any query values are treated as opaque and potentially meaningful.

This allows bounded comparisons for the five P1-14 dimensions: **scheme**, **apex/www hostname**, **trailing slash**, **case-sensitive URL path**, and **query**. A candidate can differ in multiple dimensions. **The presence of a dimension does not establish that the page is equivalent, duplicated, broken, or canonical.** In particular, Google documents that path case can be significant; query parameters can change content.

For each already-observed response, provide `url`, `status_code`, optional `method` (`GET`/`HEAD`), optional one-step `Location`, up to three individually observed canonical URL declarations (`canonicals`), and optional **caller-computed SHA-256 of the exact body from HTTP 200**. The analyzer reports:

- whether the supplied URL is a reference or which of the five candidate dimensions it differs in;
- one-step redirects for **301/302/303/307/308**: declared destination is reference, another sampled candidate, an unsampled in-family URL, external, or unresolved. **304 is not treated as a redirect**. It never follows a Location, tests destination availability or reports final chains;
- canonical declarations (absent, self, explicitly referencing the reference, another observed candidate, unobserved family target, external, invalid/unresolved, or multiple conflicting distinct targets). These are **declarations only**, never Google's selected canonical;
- whether two **HTTP 200 response bodies** have the same *supplied* 64-character SHA-256 digest. This is conservative **byte identity only**, not semantic equivalence, quality or indexing behavior. Without two comparable digests it reports **unknown**, never guesses;
- declared canonical divergence among matching caller-hash-identical HTTP 200 bodies, as a review lead with no automatic search-indexing verdict.

## Sample MCP input

```json
{
  "reference_url": "https://example.com/Products/Widget",
  "observations": [
    {
      "url": "https://example.com/Products/Widget",
      "status_code": 200,
      "method": "GET",
      "canonicals": ["https://example.com/Products/Widget"],
      "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "url": "http://example.com/Products/Widget",
      "status_code": 301,
      "location": "https://example.com/Products/Widget"
    },
    {
      "url": "https://www.example.com/products/widget/?utm_source=example",
      "status_code": 200,
      "method": "GET",
      "canonicals": ["https://example.com/Products/Widget"],
      "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

All supplied URLs are **labels and opaque data only**, not browsing instructions. Query values, original paths, Location targets, canonical references and hashes are **never returned**. Output comprises fixed rule codes/messages, booleans, bounded counters, 1-based observation numbers, declared dimensions and explicit limitations. Error results are generic.

## Security and bounds

- Strict absolute HTTP(S) reference **without query**, fragments, credentials or custom ports. Rejects ambiguous dot-segment/encoded-slash/encoded-dot/backslash path labels. Each candidate has the same narrowly defined path family and only apex/`www.` hostname, excluding unrelated subdomains or sibling sites. The exact reference response must be supplied.
- **1–12** unique observations. Each URL, one-step Location and canonical value at most **1,024 UTF-8 bytes**, **3** canonical declarations per record, and **28,000 UTF-8 bytes combined** for supplied URL/header/digest evidence. Rejects CR/LF/NUL/terminal and direction-control characters and unsafe credential-embedded URL labels. Relative Location and canonical targets (such as `../Widget`) are resolved against the observed URL only for classification.
- SHA-256 (64 hex characters) is permitted only when the response was **exact HTTP 200** and the method is **not HEAD**. The tool does not compute or store a digest, receive HTML, fetch response bodies or certify the caller hash is accurate.
- At most **12 prioritized findings** are returned, even if more were observed; full counts, `findings_truncated` and `coverage_limited: true` retain honest boundaries.
- Read-only MCP annotations; **no** network connections, local files, browser, shell, external validator, new dependency or persistent history. Pure Worker-safe shared analyzer, one thin hosted re-export and separately registered local/hosted tool contracts.

## Interpretation caveats

An observed **HTTP 200** candidate is not automatically a duplication defect. If its supplied body digest matches the supplied reference, investigate whether duplicate URL consolidation is intentional. If the digests differ, investigate whether the URL differences represent meaningful content. Either way, the analyzer cannot infer SEO penalties, canonical clustering, crawler outcomes or ranking impact.

A **redirect** or `rel="canonical"` declaration is a signal of preference, not proof that Google follows it or selects that target. One-step Location is not a verified redirect chain. **Unobserved** scheme, hostname, path or parameter permutations remain unknown, and an untested reference response is rejected rather than silently assumed available.

Google references:

- [How to specify a canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [What is canonicalization?](https://developers.google.com/search/docs/crawling-indexing/canonicalization)
- [URL structure best practices](https://developers.google.com/search/docs/crawling-indexing/url-structure)

## Verification

Run root `npm run check` after `npm run build` to validate the flat local unit tests, schema, real MCP stdio protocol and synchronized **23-tool** manifests. Hosted Worker `npm run check && npm test` uses the same analyzer through `chatgpt-plugin/src/modules/http-crawl/url-variants.ts` and its own genuine MCP worker tests. Installed npm tarball smoke invokes the local tool, including opaque query and SHA-256 input, and checks redaction. GitHub Windows and Ubuntu smoke plus both security checks must succeed before merge.

Future live URL-variant probing would need separately authorized, public-IP-pinned, robots-aware, concurrency/byte/time-budgeted and redirect-safe network checks. It is **not** implemented by this PR.
