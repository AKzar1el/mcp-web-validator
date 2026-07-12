# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added the hosted `audit_public_site` tool for bounded, sitemap-first, same-origin public-site audits with robots enforcement, page continuation, compact coverage, grouped findings, and a transparent health-score denominator.
- Added the hosted `audit_public_webpage` tool for one-page live URL audits with bounded public fetching, redirect validation, HTML validation, SEO/accessibility-signal checks, JSON-LD syntax checks, and optional link checks.

### Changed

- Upgraded the hosted Worker contract to version 0.5.0 and the results widget to v5.
- Added a dedicated per-client rate limit for bounded public-site audits and cache-busted the site-aware widget resource.
- Limited hosted link checks to 20 targets so the worst-case live-page audit remains below the Cloudflare Workers Free subrequest ceiling.
- Corrected non-mutating external tool annotations, clarified tool-selection metadata, and distinguished checked CSS from CSS that was not supplied.
- Renamed the hosted HTML diagnostic field from `errors` to `messages` because it contains errors, warnings, and informational notes.

### Fixed

- Prevented client-controlled MCP session IDs from bypassing coarse rate limiting.
- Added bounded Nu response handling and a structured final Worker error boundary.
- Corrected warning-only next-step copy and the JSON-LD syntax-check title.

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
