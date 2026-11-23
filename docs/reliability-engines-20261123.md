# Web Validator reliability engines — 23 November 2026

This change **extends existing tools only**: 39 local MCP tools and 27 hosted
tools remain. Optional engines are off by default for an 8 GB Windows laptop.
SiteOne is a standalone opt-in CLI check, not a background job.
The earlier Unlighthouse adapter was removed: it was not executed end-to-end,
requires a separate Node 24.13.1+ runtime, and overlaps existing Lighthouse
checks. It must not be advertised as a supported or verified integration.

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

**Verified Windows alternative (recommended):** install the official Nu
Checker Windows runtime (which bundles Java 17+), verify its release SHA-256,
then configure the local MCP process with an absolute path to the bundled
runtime's java.exe:

    MCP_WEB_VALIDATOR_NU_JAVA_PATH=C:/path/to/vnu-runtime-image/bin/java.exe

With that environment variable, selecting checker="local" starts Nu on
demand, binds its temporary HTTP listener explicitly to 127.0.0.1, validates
the supplied HTML or XHTML, and terminates the Java child. Auto mode uses it
only when remote W3C is temporarily unavailable. At most one temporary
Nu instance runs per MCP process, with a 256 MB Java heap limit and strict
startup/response timeouts. No Windows service, Docker daemon, permanent
listener or system Java upgrade is required. A real 2026-11-23 check observed
about 350 MB working set during execution; it is **not** always resident.
The verified official Windows release archive (vnu.windows.zip, 26.11.20)
had SHA-256:
34bbc89b6247dfe9fc869fa9900aebcc0dcd102c224f92677b817f61d57e14c0.
The binary is installed outside the npm package, not vendored.

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

## Independently verified SiteOne: explicit opt-in

Run the verified native SiteOne CLI separately:

    node scripts/deep-audit-optional.mjs --help
    node scripts/deep-audit-optional.mjs --engine=siteone --url=https://digestseo.com/ --allow-host=digestseo.com --max-pages=4

Use the installed executable on PATH, or set
MCP_WEB_VALIDATOR_SITEONE_BIN to its absolute path (e.g. the verified official
Windows 2.5.1 binary). Add --execute for an actual crawl.
For an npm installation, call the separate mcp-web-validator-siteone
executable. Its audited JSON files are written under the **current working
directory**, never inside the npm installation or npx cache. This adds
no MCP tools.

The default is DRY RUN (plan only). Adding --execute requires an already
installed SiteOne binary, explicit exact-host ownership confirmation, and
review of the site's impact. The adapter performs public IPv4 DNS preflight,
runs in a private working directory with scrubbed credentials/configuration,
and checks that an actual bounded SiteOne JSON report was produced.

- SiteOne: one worker, max one request/sec, 384 MB crawler memory cap,
  max four visited pages, bounded queue/timeout and disabled HTTP cache.
  A fresh isolated HOME/USERPROFILE/APPDATA and working directory avoids
  loading the user's global crawler configuration or credentials.
- Origins must be public HTTPS, exact-host authorized, without credentials,
  nonstandard ports, queries or fragments. Literal IP, local/test/internal
  domains and unsafe paths are rejected.
- SiteOne is NOT the MCP DNS-pinned fetch engine: Windows 2.5.1 was tested
  with the --resolve option, which incorrectly mapped the public domain
  to loopback and produced no pages. The adapter therefore does NOT use this
  override and **cannot guarantee resistance to DNS rebinding or unsafe
  redirects**. Run it only for sites you control and trust, never arbitrary
  untrusted URLs. Its output does not silently affect canonical MCP scores.
- SiteOne is never auto-launched or permanently scheduled.

**Real tests on 23 November 2026:** the verified official Windows SiteOne
v2.5.1 executable crawled one URL on tomiseregi.si and two and four URLs
in independent digestseo.com tests, wrote bounded JSON reports containing
corresponding stats.totalUrls values, and exited successfully. The official
Windows ZIP had SHA-256:
6b6758daa866df99d9bd7a020b51eaeca2d5f52f3172ec5270f9f96b964c16db.
DNS pinning remained a
documented limitation, not a claimed security control. No paid API key
or heavyweight persistent runner is required.

## Licenses and decision

Nu Html Checker: MIT (external service); axe-core: MPL-2.0 (optional npm);
Stylelint: MIT (optional npm); pixelmatch: ISC (optional npm);
pngjs: MIT (optional npm); SiteOne Crawler: MIT (external CLI).

Upstream source is not vendored or modified. Preserve third-party npm
license notices before distribution. Do not duplicate the existing SEO,
robots, sitemap and Lighthouse tools.

References:
- https://github.com/validator/validator
- https://github.com/dequelabs/axe-core
- https://github.com/stylelint/stylelint
- https://github.com/mapbox/pixelmatch
- https://github.com/janreges/siteone-crawler
