# V02 - Availability observations and local history

**Purpose:** Compare actual sampled HTTP/transport outcomes to detect intermittent non-2xx responses and status changes without misreporting a continuous uptime measurement. Designed to detect incident signatures like 200 -> 429/503 -> 200.

## Entry points

| Runtime | MCP tool | Modes |
| --- | --- | --- |
| Local Node/stdio | \`http.availability\` | Offline: 2–48 caller-provided observations. Live: 2–3 sequential public GET samples. |
| Hosted Cloudflare Worker | \`review_availability_history\` | Same modes; stateless and rate-limited per outbound GET. |
| Local Node/stdio only | \`availability.history\` | Opt-in \`capture\` (one live GET then local save); \`list\` (offline); \`compare\` (offline with 2+ saved observations). |

### Offline input example

\`\`\`json
{
  "observations": [
    { "observed_at": "2026-11-20T09:00:00Z", "status_code": 200 },
    { "observed_at": "2026-11-20T09:05:00Z", "status_code": 429, "cf_challenge": true },
    { "observed_at": "2026-11-20T09:10:00Z", "failure": "timeout" },
    { "observed_at": "2026-11-20T09:15:00Z", "status_code": 200 }
  ]
}
\`\`\`

Each observation has an explicit-offset ISO time and **exactly one** HTTP \`status_code\` (100–599) or no-response \`failure\` (\`timeout\`, \`dns_error\`, \`network_error\`, \`fetch_error\`, \`policy_blocked\`). Optional \`cf_challenge\` only when an HTTP response actually existed; optional \`elapsed_ms\` when measured. Samples must be ordered, unique and strictly chronological. A failed request is not fabricated as HTTP 500. Inputs are capped at 48.

### Live input example

\`\`\`json
{ "url": "https://example.com/", "checks": 3 }
\`\`\`

Only a safe query-free public URL is allowed. Requests are sequential, bounded to three; no response bodies are downloaded or retained; no cron, browser execution, cookies or crawler identity claims. Each completed request is timestamped and reported independently. The hosted Worker uses the existing site-audit limiter once **per attempted GET**; the local Node server pins DNS to public addresses.

### Local opt-in history

\`\`\`json
{ "action": "capture", "url": "https://example.com/" }
\`\`\`

Repeat the capture manually when new evidence is needed; \`list\` reads the compact retained records and \`compare\` evaluates two or more existing records for the **same exact URL**. The file \`<workspace>/.mcp-validator/availability-history.json\` retains at most **10 total records across all URLs**, evicts the oldest on the eleventh capture, and is capped at 24 KB. It uses guarded realpath/lstat, rejects symlinks/corruption, serializes saves and writes atomically. No raw response bodies, headers, cookies or URL query parameters are stored. No hosted persistence, Cloudflare storage, GSC, GA4 or background scheduling was added.

### Interpretation

- **Observed success percentage** is the count of 2xx responses divided by supplied observations. It is **not** SLA availability, duration-weighted uptime, or proof that Googlebot successfully fetched a page.
- Changes refer to observed adjacent statuses or classes. A 503 between two 200 samples is evidence of intermittent behavior in the sample, not of the complete outage duration or root cause.
- Consecutive non-success streaks count samples, not elapsed minutes; long gaps are highlighted rather than interpolated.
- Redirects and 3xx are not automatically classified as 2xx successes; use V01/V04 for redirect-chain interpretation.
- Even an HTTP 200 with an explicit Cloudflare challenge signal is classified as a challenge, **not** a successful delivery of the protected page.
- A \`cf_challenge\` flag requires explicit response evidence; no Cloudflare/Google authorization inference or bot impersonation.
- Values remain bounded and sanitized, without echoing raw URL paths or secret query strings.

## Validation gates

Local pure analyzer and secure history-store tests; hosted analyzer/live-burst tests; actual local stdio and hosted Worker MCP discovery/calls; installed distributable smoke; all repository and Worker regression suites; TypeScript checks; manifest consistency; Worker Wrangler dry-run; controlled live request to an authorized public URL. A merged source change **does not** automatically deploy the hosted Worker.
