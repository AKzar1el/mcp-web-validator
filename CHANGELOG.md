# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
