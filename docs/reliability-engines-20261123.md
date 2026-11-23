# Web Validator reliability engines — 23 November 2026

This change **extends existing tools only**: 39 local MCP tools and 27 hosted
tools remain. Optional engines are off by default for an 8 GB Windows laptop.
SiteOne and Unlighthouse are standalone opt-in CLI checks, not background jobs.

## HTML: local Nu Checker fallback

Existing tools html.local, html.url and report.validation accept checker or
htmlChecker: auto (default), remote, or local.

- auto: primary W3C Nu service, with local fallback on transient failures
  only when MCP_WEB_VALIDATOR_NU_LOCAL_URL is configured.
- remote: only the W3C service.
- local: require locally operated Nu checker; never upload submitted HTML.

Optional local Nu service:

    docker run --rm -p 127.0.0.1:8888:8888 ghcr.io/validator/validator:latest

Environment for only the local stdio MCP process:

    MCP_WEB_VALIDATOR_NU_LOCAL_URL=http://127.0.0.1:8888/?out=json

Only HTTP literal loopback hosts 127.0.0.1 or ::1 and fixed checker routes
are allowed. No executable installation, service startup, credential
provisioning or hidden network activity is performed by default. The same
input/response bounds and no-redirect policy apply, and partial or malformed
checker evidence must not become a clean result. Upstream vnu.jar needs Java
17+, while the upstream standalone binaries include an embedded Java runtime.

Hosted Cloudflare Workers cannot reach this local checker. They instead
make at most one second request to a fixed alternate public Nu endpoint for
transient 429/5xx or transport failure, sharing the original 15-second
deadline. Aborted requests, redirects and malformed diagnostics are not
retried. Incomplete audits remain explicitly partial.

## CSS: Stylelint optional offline rules

Existing css.local supports checker: "stylelint"; default is "w3c".
The local engine checks ten conservative CSS quality rules, does not load
configuration files, fetch network resources, autofix content or echo CSS.
Input limit 128 KB; diagnostic cap 200 with complete severity counts.
Linting does NOT establish W3C CSS conformance. Stylelint 17 preserves the
original Node 22.12 minimum; Stylelint 18 requires newer Node versions.

## Accessibility: axe-core optional

Existing browser.wcag accepts includeAxe: true. It first strips page
scripts, event handlers and frames, blocks all external requests, then
executes locally installed axe-core rules on sanitized HTML in the existing
pinned sandboxed Chromium. No original DOM, selectors, user text, URLs,
form input or document snippets are returned; only bounded static rule IDs,
impact bands and affected-element counts. The original 180 KB HTML input
cap and 20-second browser deadline still apply. Unavailable engine or
runtime is NOT a passing result.

The automated rules and limited keyboard checks do not prove WCAG 2.2
conformance for live/hydrated sites; production scripts and assistive
technology are not exercised.

## Visual regression: pixelmatch optional

Existing screenshot.capture accepts baselineDir to compare with previously
recorded viewport screenshots. It must be an existing directory separate
from outputDir. PNGs need matching names, e.g. mobile_375x812.png. Each
image is capped at 12 MB and 2,073,600 pixels. Only numeric changed-pixel
counts and percentages are returned. No diff PNG or source content is
stored. Missing, malformed, over-budget or incomplete-asset comparisons
are inconclusive, never a false clean result.

## Independent site-wide engines: explicit opt-in

SiteOne and Unlighthouse may be used separately with:

    node scripts/deep-audit-optional.mjs --help
    node scripts/deep-audit-optional.mjs --engine=siteone --url=https://digestseo.com/ --allow-host=digestseo.com --max-pages=4
    node scripts/deep-audit-optional.mjs --engine=unlighthouse --url=https://digestseo.com/ --allow-host=digestseo.com --max-pages=2 --paths=/,/blog

The default is DRY RUN (plan only). Adding --execute requires an already
installed siteone-crawler or unlighthouse-ci executable on PATH, explicit
ownership confirmation via --allow-host, and review of site impact.

- SiteOne: one worker, max one request/sec, 384 MB crawler memory cap,
  max four visited pages, bounded queue/timeout and disabled HTTP cache.
- Unlighthouse: max four explicit paths, one Lighthouse sample per page,
  mobile-only, time-bounded child process; Chrome and CPU may be expensive.
- Origins must be public HTTPS, exact-host authorized, without credentials,
  nonstandard ports, queries or fragments. Literal IP, local/test/internal
  domains and unsafe paths are rejected.
- The third-party command-line crawlers are NOT the MCP DNS-pinned fetch
  engine. Never run them on untrusted URLs; review their own SSRF behavior.
  Their output does not silently affect canonical Web Validator scores.
- Neither is auto-installed, auto-launched or permanently scheduled.

These integrations are evaluated using offline CLI-plan and bounded-input
tests. Running actual third-party site crawls requires the external binaries
and a controlled staging-site validation before declaring them production
ready. No paid API key is required for these baseline modes.

## Licenses and decision

Nu Html Checker: MIT (external service); axe-core: MPL-2.0 (optional npm);
Stylelint: MIT (optional npm); pixelmatch: ISC (optional npm);
pngjs: MIT (optional npm); SiteOne Crawler: MIT (external CLI);
Unlighthouse: MIT (external CLI).

Upstream source is not vendored or modified. Preserve third-party npm
license notices before distribution. Do not duplicate the existing SEO,
robots, sitemap and Lighthouse tools.

References:
- https://github.com/validator/validator
- https://github.com/dequelabs/axe-core
- https://github.com/stylelint/stylelint
- https://github.com/mapbox/pixelmatch
- https://github.com/janreges/siteone-crawler
- https://github.com/harlan-zw/unlighthouse
