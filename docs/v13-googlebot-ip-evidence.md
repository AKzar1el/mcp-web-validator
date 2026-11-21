# V13 — optional official Google common-crawler source-IP evidence

**Status:** post-V12 opt-in extension to the existing local `crawler.logs` tool. No new tool, hosted Worker changes, API key, storage, live site crawl, Cloudflare access or service restart.

V12 used User-Agent text only; any visitor can claim to be Googlebot. V13 can strengthen that evidence by matching the **actual client source IP** in each caller-supplied log line to Google's currently published **common crawler** CIDR ranges. Matches are numerical evidence, not reverse/forward DNS verification and not proof of Google's historical IP allocation or indexing.

## How to use

The default `verify_googlebot_ip_ranges: false` preserves the fully offline V12 workflow. To opt in, set `verify_googlebot_ip_ranges: true` on an ordinary `crawler.logs` call. Supply the same 1–16 important URLs, an explicit cutover, and 1–500 log entries.

- Structured observations may include `client_ip` (IP literal, at most 64 characters). Other fields are unchanged.
- Apache/Nginx combined access logs already contain a first-field IP; V13 parses it only for local classification.
- **Behind Cloudflare, a CDN, or a reverse proxy:** confirm the IP recorded by your **trusted** log pipeline is the end visitor IP, not the proxy's IP or an untrusted request header. A proxied address produces misleading mismatches. Never trust an arbitrary `X-Forwarded-For` value without your proxy's established configuration.
- When explicitly requested, the local tool performs **one bounded HTTPS GET** to the **fixed** official URL <https://developers.google.com/static/crawling/ipranges/common-crawlers.json>, with an 8-second deadline, no redirects, a 512 KB stream cap, and maximum 1,000 parsed CIDRs. The URL is not controllable by log content. It sends **no** target URL, log text, visitor IP, user-agent, credential, or query to Google.
- If the request fails, analysis returns the original offline status counts plus `googlebot_ip_evidence.status = "unavailable"`. It never invents matches or silently substitutes a stale/unverified IP list.

## Evidence returned

`googlebot_ip_evidence` includes:

| Field | Meaning |
| --- | --- |
| `status` | `not_requested`, `checked_current_official_ranges`, or `unavailable` |
| `claimed_requests` | Important-page GET/HEAD observations whose User-Agent claims Googlebot |
| `matched_current_ranges` | Claims whose supplied source IP belongs to a **current official common-crawler range** |
| `outside_current_ranges` | Claimed Googlebot source IPs outside those ranges |
| `missing_or_invalid_ip` | Claimed requests with missing/malformed IP evidence |
| `matched_before` / `matched_after` | Matching requests on each side of the user-supplied cutover |
| `matched_after_problem_responses` | Post-cutover 4xx/5xx among matched-source requests |

Existing HTTP response groupings and numbered URL summaries are unchanged. The legacy `crawler_identities_verified` value remains **false**: matching a published IP range is a meaningful check, but this tool does not do DNS verification or know whether an IP belonged to that range at an older point in time.

**Privacy:** IP addresses, source log lines, URLs, query strings, User-Agent values, and timestamps remain absent from all outputs. No source log file is read. Values are used only in memory for the current invocation.

**Coverage:** The IP check applies only to **claimed Googlebot**, and the official **common-crawlers** list—not AdsBot, other Google fetchers, Bingbot, GPTBot, or a generic Google Cloud address. A matching range does not establish successful indexing or explain a search-impression drop; a mismatch might reflect proxy logging or a different historical allocation. A zero-match result is not proof of absence without valid client-IP coverage.

## Verification gate

- Module tests: `test/change-regression-google-common-crawler-ip.test.js` plus existing V12 suite
- End-to-end MCP schema, redaction and normal offline call: `test/mcp.integration.test.js`
- Full local test/build, hosted unaffected suite, manifest checks, npm pack smoke, security audit, CI
- **No** npm publish, production Worker deploy, Codexify restart, unsolicited network verification, or mutation of other worker branches.

Official reference: <https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests>. Google moved the JSON under `/crawling/ipranges/` in 2026.
