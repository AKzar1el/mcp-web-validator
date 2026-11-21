# M06 - external-metrics (local)

**Owns:** V11-FIELD; optional INT-GSC and INT-GA4 adapters. Authorized CrUX field performance and property-scoped GSC/GA4 or comparable metrics.

- **Source:** `src/modules/external-metrics/<feature-slug>.ts` (exact name per `docs/architecture/seo-modules.md`).
- **Tests:** `test/external-metrics-<feature-slug>.test.js` (root `npm test` discovers flat tests after build).
- **Reuse:** V11-FIELD uses the public Google Chrome UX Report API, entirely separate from GSC/GA4.
- **Guardrail:** Live API calls require explicitly selected `live_crux` and a local `CRUX_API_KEY` environment variable. No secrets in tool arguments, persisted data or output. No OAuth, scheduling, or cloud configuration changes.

V11-FIELD adds the bounded pure analyzer `crux-field.ts` and an independent
fixed-endpoint, key-gated `crux-field-probe.ts`. The local MCP
`performance.crux_field` accepts caller-supplied daily/history CrUX JSON
offline or performs one explicitly opt-in Google API request when a key is
already configured. It validates record identity, device class and 28-day
collection windows; missing p75 data remain null. The tool returns redacted
Core Web Vitals LCP/INP/CLS and FCP/TTFB plus limited history, not a live site
fetch, a Lighthouse lab run or rankings/traffic causation. See
`docs/v11-crux-field.md`. INT-GSC and INT-GA4 remain unimplemented.
