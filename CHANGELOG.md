# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.39] - 2026-09-24

### Added

- Added current OpenAI Codex MCP installation guidance for both the published local stdio package and the existing hosted Streamable HTTP endpoint, including `codex mcp list` verification and capability differences between the two surfaces.

### Fixed

- Preserved `application/xhtml+xml` semantics when validating local `.xhtml` files through `html.local` and `report.validation`, while ordinary `.html` files continue to use `text/html`.
- Requested and preserved W3C Jigsaw CSS warnings separately from CSS errors, exposed them additively through `css.local` and validation reports, and narrated warning-only results as review items without changing error-based CSS scoring or known `@container` limitation handling.

## [1.3.38] - 2026-09-24

### Fixed

- Reported non-empty `rel="canonical"` href values that cannot be parsed as URLs instead of treating them as usable canonical targets, while preserving valid relative canonical support.
- Recognized supported `aria-labelledby`, `aria-label`, and `title` accessible names on active image-map area links and excluded `aria-hidden` areas from the accessible-name check while preserving `alt` and same-href labeled equivalents.

## [1.3.37] - 2026-09-24

### Fixed

- Required usable accessible names on SVG-namespace elements explicitly exposed as `img`, `graphics-document`, or `graphics-symbol`, while preserving supported labels plus inert-template and `aria-hidden` exclusions.
- Resolved explicit ARIA fallback-role lists from the first recognized non-abstract role across current WAI-ARIA, Graphics ARIA, and DPUB-ARIA before applying image-accessibility semantics, so invalid or abstract tokens fall through while earlier valid roles stop fallback.
## [1.3.36] - 2026-09-24

### Fixed

- Required usable accessible names on neutral generic elements such as `<div role="img">` and `<span role="image">`, while preserving supported alternate labels plus inert-template and `aria-hidden` exclusions.
- Preserved the fetched-page/document fallback base for relative-link checks when the first active `<base href>` is malformed or uses the base-disallowed `data:`/`javascript:` schemes, while continuing to reject parseable private/non-public document bases.

## [1.3.35] - 2026-09-24

### Fixed

- Stopped reporting missing accessible-name findings for ordinary images explicitly marked `role="none"` or `role="presentation"` when no focusability, contenteditable, or ARIA conflict restores image semantics.
- Required a non-empty accessible name for exact-empty-alt images that explicitly retain semantic `img`/`image` roles, while preserving ordinary decorative `alt=""` behavior and supported alternate labels.

## [1.3.34] - 2026-09-24

### Fixed

- Treated `maximum-scale=yes` viewport metadata as restricting 200% zoom, matching the current W3C ACT interpretation while preserving existing non-restricting controls.
- Stopped reporting missing accessible-name findings for ordinary images and image submit buttons explicitly hidden from the accessibility tree by `aria-hidden="true"` on themselves or an ancestor.
- Added hosted `application/xhtml+xml` support so public XHTML pages preserve XML/XHTML decoding and Nu-validation media-type semantics instead of being rejected or coerced to `text/html`.

## [1.3.33] - 2026-09-24

### Fixed

- Preserved decorative-image semantics for ordinary `<img alt="">` elements so exact empty alternate text is not reported as a missing-alt error, while omitted and whitespace-only alternate text keep their existing diagnostics.
- Accepted non-empty `aria-label`, resolvable non-empty `aria-labelledby` text, or non-empty `title` as bounded static alternate accessible names for ordinary `<img>` elements when `alt` is absent, while still reporting genuinely unnamed images.

## [1.3.32] - 2026-09-24

### Fixed

- Preserved `application/xhtml+xml` when fetched XHTML is forwarded to the Nu HTML checker so XML/XHTML well-formedness failures are not hidden by `text/html` parsing.
- Accepted non-empty `aria-label`, `title`, or resolvable non-empty `aria-labelledby` text as valid accessible names for `input[type="image"]` controls while still reporting genuinely unnamed image submit buttons.

## [1.3.31] - 2026-09-23

### Added

- Added informational guidance for usable non-fragment relative `rel="canonical"` URLs, recommending absolute canonicals while preserving supported relative canonical behavior.

### Fixed

- Stopped classifying HTTP 304 Not Modified link-check responses as redirects; only 301, 302, 303, 307, and 308 are now narrated and counted as redirects while existing reachability scoring is preserved.

## [1.3.30] - 2026-09-23

### Added

- Warned when authored viewport metadata prevents users from zooming to 200% through `user-scalable=no` or a finite non-negative `maximum-scale` below 2, while preserving non-restricting viewport controls.
- Warned when the first valid declarative meta refresh uses a delay greater than 0 and at most 20 hours, with parsing aligned to HTML refresh semantics and immediate redirects left unflagged.

## [1.3.29] - 2026-09-23

### Added

- Reported explicitly authored root `<html lang>` values whose primary language subtag is unknown in the current IANA Language Subtag Registry, while preserving fragment-safe audits and accepting known primary subtags with irregular later subtags.

### Changed

- Updated the screenshot runtime to Puppeteer/Puppeteer Core 25.12.0, `@puppeteer/browsers` 3.2.3, and the matching Chrome Headless Shell 154.0.8037.57 while retaining lazy first-use browser installation.

## [1.3.28] - 2026-09-23

### Fixed

- Reported explicitly authored root `<html>` elements whose `lang` attribute is missing or empty, while leaving fragment-oriented metadata audits unaffected by Cheerio's synthesized wrapper.
- Warned when a usable `rel="canonical"` href contains a URL fragment, matching Google Search canonicalization guidance while preserving supported non-fragment relative canonicals.

## [1.3.27] - 2026-09-23

### Fixed

- Reported active image-map `<area href>` links whose required text alternatives are missing or unusable, while preserving the same-resource labeled-area exception and ignoring dead or inert markup.
- Required usable non-empty values for the four Open Graph basic properties (`og:title`, `og:type`, `og:image`, and `og:url`) while preserving informational severity and multiple-image semantics.

## [1.3.26] - 2026-09-23

### Fixed

- Escaped Markdown control syntax in generated validation-report table cells so validator and page diagnostics render literally instead of becoming active links, images, or emphasis.
- Reported missing or empty functional `alt` text on `<input type="image">` submit controls in package and hosted accessibility audits while preserving valid labels and inert template contents.

## [1.3.25] - 2026-09-23

### Fixed

- Preserved IANA's globally reachable `192.0.0.9/32` and `192.0.0.10/32` anycast exceptions while continuing to reject the rest of the non-global `192.0.0.0/24` IETF Protocol Assignments block.
- Reported multiple document `<title>` and meta-description declarations as ambiguous while keeping first-declaration empty/length analysis instead of merging duplicate values.
- Escaped HTML-like validator and page fragments in generated Markdown report tables so untrusted markup is rendered literally instead of as raw HTML.

## [1.3.24] - 2026-09-23

### Fixed

- Rejected otherwise-unallocated addresses inside IANA's `2001::/23` IETF Protocol Assignments block from public URL targets while preserving its currently globally reachable more-specific allocations.
- Ignored links and `<base>` elements inside inert `<template>` contents during broken-link checks so inactive markup no longer changes link results or relative-URL resolution.
- Checked active image-map `<area href>` hyperlinks alongside ordinary anchors during broken-link checks.

### Changed

- Exposed the local runtime tool table under the standard `## Tools` README heading used by MCP directory extractors.

## [1.3.23] - 2026-09-23

### Fixed

- Ignored inert `<template>` contents when auditing robots directives, H1 headings, image alternative text, and JSON-LD so inactive template markup no longer creates page findings.
- Rejected the RFC 9637 `3fff::/20` IPv6 documentation prefix from public URL targets while preserving ordinary globally routable IPv6 support.

## [1.3.22] - 2026-09-23

### Fixed

- Reported `robots`/`googlebot` `noindex`-equivalent meta directives, including body metadata honored by Google Search, instead of silently treating index-blocked pages as clean.

### Changed

- Raised the minimum supported Undici 7.x dependency floor to 7.29.1 while preserving the package's Node.js `>=22.12.0` support contract.

## [1.3.21] - 2026-09-22

### Fixed

- Flagged multiple simultaneously usable `rel="canonical"` declarations and ignored canonical annotations that Google does not use for canonicalization, while preserving existing head scoping, rel-token, and empty-target behavior.
- Aligned the lazily installed Chrome Headless Shell build with Puppeteer Core 25.11.0's declared supported revision and added a regression guard to prevent future runtime drift.

### Changed

- Upgraded `encoding-sniffer` to 1.0.2 and refreshed the Puppeteer screenshot runtime dependency set to Puppeteer/Puppeteer Core 25.11.0 with `@puppeteer/browsers` 3.2.2.

## [1.3.20] - 2026-09-22

### Fixed

- Gave XML byte-order marks precedence over conflicting HTTP charset declarations for XML media types while preserving HTTP charset precedence over XML declarations when no BOM is present.
- Reported present-but-empty viewport metadata as unusable instead of treating it as a configured mobile viewport declaration.

## [1.3.19] - 2026-09-22

### Fixed

- Preserved full Jigsaw CSS diagnostic totals and actionable/compatibility counts when local/package output is capped at 200 messages, with explicit truncation metadata/disclosure so validation-report summaries and heuristic scoring no longer undercount large result sets.
- Preserved full SEO/accessibility and JSON-LD severity counts when structured findings are capped at 200, exposing total/truncation metadata so standalone narration and validation-report summaries/scoring no longer undercount large audits.
- Decoded charset-less XML media types, including `application/xhtml+xml`, with XML-aware BOM, UTF-16 signature, and XML declaration encoding detection instead of silently treating non-UTF-8 XML as UTF-8.

## [1.3.18] - 2026-09-22

### Fixed

- Treated Nu HTML Checker `non-document-error` diagnostics as errors instead of informational messages in local validation, report scoring, and narration, matching the validator's documented JSON semantics and hosted behavior.
- Preserved full Nu HTML diagnostic totals and severity counts when local/package output is capped at 200 messages, with explicit truncation metadata/disclosure so summaries and heuristic scoring no longer undercount large result sets.

## [1.3.17] - 2026-09-22

### Fixed

- Kept known upstream CSS validator limitations separate from trusted CSS error counts in validation-report summaries while preserving the raw diagnostic and compatibility-limited score withholding.
- Rejected scalar and scalar-array top-level values in JSON-LD syntax checks so valid JSON that is not a JSON-LD document no longer passes cleanly.

## [1.3.16] - 2026-09-22

### Fixed

- Labeled pure advisory action lists as review items instead of "Fix first" work while preserving Fix-first prioritization when errors or warnings exist.
- Accepted CR, LF, and CRLF robots.txt line endings in hosted sitemap-first site audits, matching RFC 9309 parsing syntax.
- Aligned hosted broken-link resolution with document-base semantics so the first safe `<base href>` overrides the fallback page URL, while unsafe declared bases no longer cause relative links to be checked against the wrong fallback target.
- Added hosted sitemap discovery for Google-supported RSS 2.0, Atom 1.0, and plain-text sitemap representations while preserving same-origin/public crawl guards.
- Fell back to HTML encoding sniffing when a `text/html` response declares an unsupported HTTP charset, while preserving supported transport charset precedence.

## [1.3.15] - 2026-09-22

### Fixed

- Pinned Chromium screenshot HTTP(S) connections to DNS answers revalidated as public at proxy connection time, closing a DNS-rebinding/TOCTOU gap while preserving the original hostname for TLS/SNI validation.
- Scoped Open Graph title/image checks to the document head so body-only metadata lookalikes cannot suppress missing social-preview guidance.

## [1.3.14] - 2026-09-21

### Fixed

- Preserved legacy HTML text when a public `text/html` response omits an HTTP charset but declares a supported encoding in the first 1024 bytes of the document, while keeping an explicit HTTP charset authoritative.
- Made informational-only HTML and SEO narration review-oriented instead of labeling advisory findings as attention-needed work or telling users to fix nonexistent errors.

## [1.3.13] - 2026-09-21

### Fixed

- Kept title and meta-description character ranges as non-scoring editorial guidance instead of treating Google-independent length heuristics as SEO warning penalties.
- Resolved relative link checks through the document's first `<base href>` when present, including relative base URLs resolved against the fetched page URL, while preserving public-URL safety checks.

## [1.3.12] - 2026-09-21

### Fixed

- Began graceful cleanup of each request-scoped DNS-pinning dispatcher as soon as its terminal response is returned, preventing long-lived MCP processes from accumulating Undici Agents without interrupting response-body streaming.
- Kept Nu HTML warning subtype semantics consistent across scoring and presentation so true warnings are labeled and prioritized as warnings while pure informational diagnostics remain review-only.

## [1.3.11] - 2026-09-21

### Fixed

- Stopped treating an omitted `rel="canonical"` preference as a score-penalizing SEO warning while preserving a warning for canonical declarations with an empty target.
- Aligned hosted site-audit `robots.txt` HTTP status handling with RFC 9309: 4xx responses are treated as unavailable so sitemap discovery can continue, while 5xx responses prevent crawl candidates from being audited.
- Scoped page title, description, viewport and canonical metadata checks to the document head so body/SVG lookalikes cannot satisfy page-level SEO metadata requirements.

## [1.3.10] - 2026-09-21

### Fixed

- Kept JSON-LD syntax narration aligned with accepted `application/ld+json` media-type casing and parameters so valid parameterized blocks are not reported as absent.
- Retried link probes without a byte range when the bounded GET fallback receives HTTP 416, preventing reachable zero-length or otherwise range-unsatisfiable resources from being reported as broken.

## [1.3.9] - 2026-09-21

### Fixed

- Preserved Nu HTML Checker warning subtype metadata so pure informational diagnostics no longer inflate `htmlWarnings` or reduce the HTML heuristic score while actual warnings continue to count normally.
- Matched the `viewport` metadata name ASCII case-insensitively in both local and hosted SEO audits, preventing valid mixed-case viewport tags from being reported missing.

## [1.3.8] - 2026-09-21

### Fixed

- Honored supported character encodings declared by fetched HTML responses instead of always decoding those representations as UTF-8, preventing legacy-encoded page text from being corrupted before validation and SEO analysis.

## [1.3.7] - 2026-09-21

### Changed

- Deferred the local screenshot browser download until the first `screenshot.capture` call, so validator-only npm installs no longer fetch Chrome while screenshot users still receive the pinned verified headless shell automatically on demand.

## [1.3.6] - 2026-09-21

### Fixed

- Pinned each public HTTP(S) fetch hop to the DNS addresses already validated as public, closing a DNS-rebinding/TOCTOU gap between URL validation and connection establishment while preserving hostname-based TLS/SNI and redirect revalidation.

## [1.3.5] - 2026-09-20

### Fixed

- Rejected malformed Nu HTML Checker message objects instead of silently dropping them from local validation results.
- Withheld the validation report SEO score when JSON-LD/schema analysis is unavailable, preventing partial reports from treating missing schema evidence as clean.

## [1.3.4] - 2026-09-20

### Fixed

- Rejected mismatched explicit HTTP/HTTPS port pairs in the local public-URL boundary while preserving normalized default ports.
- Matched the standard `meta name="description"` keyword ASCII case-insensitively in both local and hosted SEO audits, preventing valid mixed-case metadata from being reported missing.
- Matched hosted robots.txt crawler groups to the exact case-insensitive product token instead of accepting prefix-only groups.
- Normalized robots.txt percent encoding according to RFC 9309 comparison rules, including unreserved-octet decoding while preserving reserved escapes.

## [1.3.3] - 2026-09-20

### Fixed

- Aligned local and hosted canonical-link detection with HTML `rel` token semantics and now flags canonical links with an empty target instead of treating them as valid.

## [1.3.2] - 2026-09-20

### Fixed

- Pinned the locally bundled Puppeteer browser line to the verified Chrome 152 headless shell after reproducing a Windows launch failure on the newer Chrome 153 line, and added a real Windows screenshot smoke test to guard the runtime path.

## [1.3.1] - 2026-09-20

### Fixed

- Preserved W3C Jigsaw's `@container` diagnostic while marking its known parser limitation and withholding misleading CSS/overall heuristic scores when that limitation is present.

## [1.3.0] - 2026-09-20

### Added

- Added stable machine-readable rule codes to local and hosted SEO, accessibility, and JSON-LD findings, including hosted site-audit findings and grouped issues.

## [1.2.1] - 2026-09-19

### Changed

- Added current Gemini CLI and GitHub Copilot CLI setup guidance for the local stdio package.
- Migrated the hosted stateless MCP handler to the supported Agents SDK v2 server-factory path and refreshed current minor/patch dependency resolutions.

### Fixed

- Rejected malformed Nu HTML Checker responses that omit the required `messages` member in both local and hosted validation paths.
- Rejected malformed non-empty W3C CSS Validator JSON that omits the expected `cssvalidation` envelope.
- Rejected successful non-HTML responses from local URL validation instead of forwarding arbitrary content to the HTML checker.
- Removed unsupported exact-one-H1 SEO penalties while retaining heading-structure guidance.
- Resolved relative links from the document's first valid public `<base href>` when no explicit link-check base URL is provided.
- Recognized parameterized `application/ld+json` media types, including the standards-defined `profile` parameter, in both local and hosted schema scans.

## [1.2.0] - 2026-09-19

### Added

- Added the hosted `audit_public_site` tool for bounded, sitemap-first, same-origin public-site audits with robots enforcement, page continuation, compact coverage, grouped findings, and a transparent health-score denominator.
- Added the hosted `audit_public_webpage` tool for one-page live URL audits with bounded public fetching, redirect validation, HTML validation, SEO/accessibility-signal checks, JSON-LD syntax checks, and optional link checks.

### Changed

- Organized local MCP tool names under shallow dot-notation paths and documented every local input, including nested screenshot viewport fields.
- Upgraded the hosted Worker contract to version 0.5.0 and the results widget to v5.
- Added a dedicated per-client rate limit for bounded public-site audits and cache-busted the site-aware widget resource.
- Limited hosted link checks to 20 targets so the worst-case live-page audit remains below the Cloudflare Workers Free subrequest ceiling.
- Corrected non-mutating external tool annotations, clarified tool-selection metadata, and distinguished checked CSS from CSS that was not supplied.
- Renamed the hosted HTML diagnostic field from `errors` to `messages` because it contains errors, warnings, and informational notes.

### Fixed

- Prevented client-controlled MCP session IDs from bypassing coarse rate limiting.
- Added bounded Nu response handling and a structured final Worker error boundary.
- Corrected warning-only next-step copy and the JSON-LD syntax-check title.
- Refreshed production dependency resolutions to remove newly disclosed transitive vulnerabilities before publishing the npm release.

## [1.1.0] - 2026-07-12

### Added

- Added concise, tool-specific result summaries with prioritized fixes and clear next steps.
- Added a shared hosted result overview with truthful status, severity, truncation, schema-block, link-health, and partial-report metadata.
- Added the responsive v3 ChatGPT results widget with accessible severity groups, clean and partial states, dark-mode support, and expandable findings.

### Changed

- Replaced duplicated raw JSON in local MCP narration with polished Markdown while preserving every structured result field.
- Upgraded the hosted Worker contract to version 0.3.0 and cache-busted its UI resource.

### Fixed

- Fixed CSS errors being presented as informational results in the hosted widget.
- Fixed healthy links appearing as problems, missing truncation notices, and partial reports hiding completed checks.
- Distinguished pages with no JSON-LD from pages whose JSON-LD parsed successfully.

## [1.0.1] - 2026-07-11

### Added

- Automated contract, network-safety, report, and hosted Worker tests in CI.
- Security reporting and contribution guidance.
- Machine-readable results for every local MCP tool.

### Changed

- Reworked documentation to distinguish the local npm server from the hosted ChatGPT app.
- Documented exact runtime tool names, external data recipients, filesystem behavior, and production verification commands.
- Added bounded file and response sizes, network timeouts, capped link concurrency, public-address checks, and safer screenshot output handling.
- Upgraded the hosted Worker contract to version 0.2.0 with complete report details, a readable results widget, observability, and rate limiting.

### Fixed

- Fixed local tool calls being rejected because advertised output schemas had no matching `structuredContent`.
- Fixed relative-link resolution, unbounded link fan-out, unsafe redirect handling, and screenshot filename traversal.
- Fixed hosted HTML warnings being counted as errors.
- Reject untrusted browser `Origin` headers at the hosted Streamable HTTP boundary as required by MCP.

## [1.0.0] - 2026-07-11

### Added

- Initial public npm release with HTML and CSS validation, technical SEO and accessibility auditing, JSON-LD parsing, broken-link checks, aggregate reports, and responsive screenshots.
