# V01 - HTTP delivery and edge response diagnostics

**Status:** implementation and validation milestone. Shared analyzer: \`src/modules/http-crawl/http-delivery.ts\`. Local live adapter: \`src/modules/http-crawl/http-delivery-probe.ts\`. Hosted live adapter: \`chatgpt-plugin/src/network.ts\`.

## Purpose

Detect immediate delivery problems that an HTML-only SEO audit cannot see, especially 403, 429, 5xx, redirects and explicit anti-bot challenge headers. This is useful as a **point-in-time observation**, not proof of a crawler-specific block, historical outage or a Google indexing verdict.

## MCP entry points

| Runtime | Tool | Input |
| --- | --- | --- |
| Node / stdio | \`http.delivery\` | \`{ "url": "https://example.com/" }\` or \`{ "observations": [...] }\` |
| Cloudflare Worker / hosted | \`diagnose_http_delivery\` | Same exclusive input modes |

- Live mode: one public, query-free HTTP(S) GET, up to three same-origin redirects (four total observations) with a 12-second overall timeout; no response body is read, and all body streams are cancelled. The hosted Worker uses the existing site-audit rate limiter. The local implementation uses DNS-resolved, address-pinned public fetching.
- Supplied mode: one to four previously observed HTTP response records. This mode does **not** fetch, and the URLs act as labels rather than permission to connect. A record may have \`url\`, \`status_code\`, optional \`method\`, and optional \`headers\`.
- Recorded headers are allowlisted: Age, Cache-Control, CF-Cache-Status, CF-Mitigated, CF-Ray, Content-Type, Location, Retry-After, Server and X-Cache. Raw values (including CF-Ray and Location) are **not** returned.
- Output includes individual hop HTTP status class, redirect target class/matching evidence, Cache-Control flags and numeric max-age, edge cache-state header, numeric Age, Retry-After presence and numeric delta when given, explicit \`cf-mitigated: challenge\` signal, challenge count and actionable stable finding codes.
- The output is intentionally capped (4 hops, 12 findings, 512 bytes/header value, 8 KiB combined headers). URLs with parameters or credentials and redirect targets outside the starting origin are not fetched. Actual response headers are not forwarded to another origin.

## Verification

Focused tests:
- \`node --test test/http-crawl-http-delivery.test.js\`
- \`cd chatgpt-plugin && npx vitest run src/modules/http-crawl/http-delivery.test.ts src/worker.test.ts\`

Release gates: local \`npm test\` + \`npm run check:manifests\`; hosted \`npm run check\` + \`npm test\`; actual MCP list/call canaries and an authorized public HTTP example; hosted Worker dry run. No live deployment is implied by a local build or a GitHub commit.

## Deliberate limitations

A generic GET does not identify Googlebot or prove what Googlebot saw. A Cloudflare \`cf-mitigated\` response header is evidence of a Cloudflare challenge in that specific response; absence does not establish absence of bot protection. Cache headers are declarations/hints and do not independently prove origin behavior or CDN configuration. One observation cannot establish availability trends (V02) or historical crawler-log correlation (V12). HTML/CSS/JS bodies are never interpreted here; those are separate existing SEO and future V07/V08 checks.
