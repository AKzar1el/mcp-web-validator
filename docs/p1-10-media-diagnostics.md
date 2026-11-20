# P1-10 - Local static media diagnostics

**Owner:** M03 browser-ux. **Runtime:** local Node/stdio only. This implementation adds the read-only `media.diagnostics` MCP tool; the hosted Cloudflare Worker remains unchanged.

## Input and purpose

The caller supplies `{ "htmlContent": "<!doctype html>..." }` with a nonempty static HTML document (at most **180,000 UTF-8 bytes**). No URL is fetched or resolved, no HTML file is read, and no Chromium instance, external validator, GSC or storage is used.

The analyzer inspects up to **160 visible/inert-filtered media elements** (`img`, `picture`, `video`) in source order and returns up to **12 prioritized findings** with count-preserving truncation. It records the total observed image, picture, video, direct media `source` and `track` element counts.

Evidence includes:
- Missing or whitespace-only image `alt`/name fallbacks; intentionally empty decorative `alt=""` is counted, not automatically called wrong. Image-only links with no observed static name are flagged for review.
- Missing nonempty `src`/`srcset` references, unrecognized `loading`, `decoding`, `fetchpriority` attributes, and lazy images without positive width/height HTML attributes. External CSS might still set dimensions.
- `picture` elements lacking a direct `img` fallback, and child `source` tags without `srcset`.
- `video` elements without a static source, caption/subtitle tracks that are absent or lack `src`, and `autoplay` without `muted` (a browser-policy review hint).

The analyzer excludes content in `template` or `noscript`, plus media hidden by explicit `hidden`, `aria-hidden="true"`, or simple inline `display:none` / `visibility:hidden`. Stylesheets and JavaScript may change actual visibility.

## Privacy and evidence boundary

Structured results include **only controlled counts, fixed issue codes/messages and element indices**, not source URLs, HTML text, image alt values, query parameters, credentials, video URLs, caption content, paths or original markup. The response is bounded to 12 findings with `total_findings`, `findings_truncated`, `media_elements_checked` and `media_elements_truncated`. No private page content is persisted.

Every result has `coverage_limited: true`: source HTML cannot establish runtime resource loading, CSS sizing, responsive source selection, decoded image quality, caption correctness, playback behavior, WCAG conformance, Core Web Vitals, LCP, ranking effects or the behavior of dynamically created media. `V08` owns future browser resource failures; `V09` owns viewport parity. Avoid overlapping those implementations.

## Verification

- `npm run check`, `npm test`, `npm run build` at the root; `test/browser-ux-media-diagnostics.test.js` and a real stdio `media.diagnostics` tools/list and tools/call canary.
- Installed npm tarball smoke `test/installed-package-smoke.mjs`, `npm pack --dry-run`, `npm run check:manifests` and production `npm audit --omit=dev`.
- Hosted `npm run check`, `npm test`, `npm run deploy:dry-run` to guard the independent Cloudflare boundary. **No deployment, release or hosted MCP tool registration.**
- Independent GitHub local, Windows, Ubuntu screenshot, hosted and security CI checks must pass before integration.

P1-10 remains **partial** in the architecture map because this phase supplies real static diagnostics but not browser-verified media and interaction behavior.
