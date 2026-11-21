# V11-FIELD — Chrome UX Report real-user Core Web Vitals

**Owner:** M06 `external-metrics`. **Runtime:** local Node/stdio `performance.crux_field`. **Scope:** one explicitly requested CrUX **daily** (rolling 28-day) or **history** (up to 40 overlapping weekly 28-day periods) record. The hosted Worker does not fetch CrUX or receive an API key.

The implementation offers two modes:

1. **`supplied_record` (offline):** analyze caller-supplied JSON from the official CrUX API, up to **300,000 UTF-8 bytes**. It makes **zero network requests** and marks the result `caller_supplied`, not independently verified.
2. **`live_crux` (opt-in):** query a **fixed** Google Chrome UX Report API hostname once via POST, for an explicit public HTTPS origin or exact page. The tool reads `CRUX_API_KEY` **only** from the local environment; no key can be included as a tool argument. It does not fetch or crawl the target website. There is no automatic fallback, retry, storage, scheduler, paid provider or GSC/GA4 integration.

Google's CrUX API requires a Google Cloud API key. Google documents a free 150-query-per-minute quota, with no paid quota upgrade. Only enable a key for Chrome UX Report API usage with appropriate Google Cloud restrictions. The tool never displays the key, returned raw API response, URL, page content, query strings, original headers, or error body.

## Sample calls

Offline daily:

```json
{
  "source_mode": "supplied_record",
  "mode": "daily",
  "granularity": "origin",
  "target": "https://example.com",
  "form_factor": "PHONE",
  "record_json": "{\"record\":{\"key\":{\"origin\":\"https://example.com\",\"formFactor\":\"PHONE\"},\"metrics\":{\"largest_contentful_paint\":{\"percentiles\":{\"p75\":2200}},\"interaction_to_next_paint\":{\"percentiles\":{\"p75\":175}},\"cumulative_layout_shift\":{\"percentiles\":{\"p75\":\"0.08\"}}},\"collectionPeriod\":{\"firstDate\":{\"year\":2026,\"month\":9,\"day\":1},\"lastDate\":{\"year\":2026,\"month\":9,\"day\":28}}}}"
}
```

Live daily, only after configuring the key in the local process environment:

```json
{
  "source_mode": "live_crux",
  "mode": "daily",
  "granularity": "origin",
  "target": "https://digestseo.com",
  "form_factor": "PHONE"
}
```

Use `"mode":"history"` to request up to 40 weekly periods; the tool returns up to **eight latest p75 periods** plus earliest-to-latest numeric deltas with no interpolation. The daily API is updated approximately once per day; the history API is updated weekly. Every history point represents a **rolling 28-day** period; adjacent points overlap significantly.

## Output and interpretation

- `source` is `caller_supplied` or `verified_crux_api`, never inferred from the contents alone.
- `granularity` indicates **origin** (many pages aggregated) or **url** (one eligible page). `form_factor` indicates ALL, PHONE, DESKTOP or TABLET.
- Actual p75 **LCP**, **INP**, **CLS**, **FCP** and experimental **TTFB** (CLS unitless, others ms). Chrome UX Report publishes CLS p75 as a numeric string, which is parsed conservatively.
- Thresholds used for review: LCP good <=2500 ms, poor >4000 ms; INP good <=200 ms, poor >500 ms; CLS good <=0.1, poor >0.25. A Core Web Vitals verdict requires **all three** p75 values; missing eligibility returns `insufficient_data`, not passed/failed or zero. FCP and TTFB are additional performance context, not substitutes for INP/LCP/CLS.
- `period_end` is the last date in the official 28-day aggregation period. Historical observations with null or `"NaN"` are missing rather than zero. `history_points` has at most 8 recent periods, while `periods_available` preserves the true source count, max 40.
- Findings are fixed, privacy-safe code/message pairs, max 12. The tool never outputs URL, API keys, source JSON, request paths or Google error details.

## Privacy, limits and failure behavior

- Only query-free public HTTPS origin/page labels are accepted. Credentials, fragments, custom ports, localhost/private IPs and known internal/test names are rejected. The caller-provided target is a **Google API identifier, not a crawler target**.
- One Google API POST, **12-second** deadline, fixed endpoint, no redirects, no forwarded browser cookies/credentials, no automatic retries and no other domains.
- 404/no eligible CrUX record produces `unavailable` with null metrics. Access-denied, rate-limited, invalid/mismatched records and failed network responses return generic fixed errors without leaking returned body or the key.
- Record identity (`origin` versus `url` and form factor) must exactly match the request before numeric data can be trusted. Both daily and historical period structures are validated and capped.

**Limitations:** CrUX represents eligible real-user Chrome experiences, not all site visitors or current live PageSpeed. The aggregated p75 distributions cannot prove when or why a Google Search visibility drop occurred, and device/origin/page groups must not be conflated. V11-LAB is a separate sandboxed Lighthouse **lab** test. No CrUX key is configured or provisioned by this feature; real live-query validation must use an authorized key. There is no change to production Cloudflare or running Codexify agents.

**References:** <https://developer.chrome.com/docs/crux/api> and <https://developer.chrome.com/docs/crux/history-api>.

## Test/release gate

Root TypeScript build, pure CrUX fixtures (daily/history, missing eligibility, threshold boundaries, privacy, request mocking), actual local MCP stdio integration, manifest sync, full root regression, hosted Worker unaffected, installed npm-package smoke and independent GitHub CI are required before merge. No npm publication, deployment, notifications or API-key setup is included.
