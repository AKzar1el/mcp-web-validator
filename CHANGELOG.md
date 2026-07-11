# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
