# V10 — offline production HTML change comparison

**Owner:** M05 `change-regression`. **Runtimes:** local Node/stdio `audit.production_change` and hosted Worker `compare_production_snapshots`. Both use the **same** analyzer in `src/modules/change-regression/production-change-comparison.ts`, with a hosted reexport adapter.

## Purpose and use

Compare two explicitly captured versions of **one identical page URL**, ordered oldest to newest. The user supplies both raw HTML bodies, offset-aware ISO capture timestamps and optional HTTP response statuses. No tool fetches a URL, creates a baseline, reads deploy history or saves HTML. A comparison of two current samples cannot reconstruct the HTML before an incident; the caller must have earlier captured evidence.

Example (use with either tool; sample values are illustrative):

```json
{
  "page_url": "https://example.com/article",
  "baseline": {
    "observed_at": "2026-11-20T09:00:00Z",
    "http_status": 200,
    "html": "<html><head><title>Before</title></head><body><main><h1>Before</h1><p>Original content</p></main></body></html>"
  },
  "current": {
    "observed_at": "2026-11-21T09:00:00Z",
    "http_status": 200,
    "html": "<html><head><title>After</title></head><body><main><h1>After</h1><p>Updated content</p></main></body></html>"
  }
}
```

## Evidence and safety

- SHA-256 fingerprints of **exact supplied HTML bytes** and normalized sampled main text (Unicode NFKC, folded whitespace/case). A byte-only change is separated from sampled main-content, title, description, first H1, canonical, robots/noindex, JSON-LD block-count and bounded same-origin link changes. Comparing hashes does not reveal which deployment caused the change.
- V07's existing source-HTML structural parser supplies link/word/canonical/noindex comparisons. The V10 adapter does not pretend the later version was browser-rendered. No JavaScript or CSS executes.
- HTTP 403, 429 and 5xx evidence is treated as **unavailable delivery**, not a successful HTML sample: the analyzer returns `not_comparable` and leaves content/metadata deltas `null`, never a false SEO repair. HTTP status omitted or identical claimed timestamps downgrade otherwise comparable HTML to `partial`. Status/time input is supplied, **not independently observed**.
- Static URL is query-free, fragment-free, credential-free and cannot carry a custom port. Each HTML payload is capped at **180,000 UTF-8 bytes**, total 360,000; main text extraction 100,000 characters and links use V07's capped sample. One page per invocation, at most **14 findings**.
- Structured evidence returns only fixed field names and counts, SHA-256 digests, controlled findings and generic messages. **No raw page text, title, URL, query, canonical target or captured timestamp is echoed.** There is no storage, scheduler, subscription, browser, external metrics, Cloudflare deployment or paid service.
- This does **not** verify server logs, real Googlebot access, rendering/hydration, canonical selection, Search Console/GA4 signals, search rankings, cause of a visibility decline, or site-wide change. The historic audit summary tools `audit.trends` / `compare_historical_audits` remain the separate path for saved **compact audit** comparisons.

## Verification gate

1. Root build/full tests, real local stdio MCP tool call (valid, invalid, redacted output) and manifest synchronization.
2. Hosted Worker typecheck, Vitest, Worker dry-run, production dependency audits.
3. Fresh installed-package smoke, independent GitHub CI on exact feature head (Linux stdio, Windows, Ubuntu sandbox, Hosted Worker and security checks), then merge **without publishing/deploying**.

When a captured timestamp is equal, a failure response is supplied, or a sample is truncated, report the scope/coverage caveat clearly and avoid interpreting a missing item as resolved.
