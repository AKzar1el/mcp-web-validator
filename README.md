# Web Validator by DigestSEO

[![npm version](https://img.shields.io/npm/v/mcp-web-validator.svg)](https://www.npmjs.com/package/mcp-web-validator)
[![CI](https://github.com/AKzar1el/mcp-web-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/mcp-web-validator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Indexed on TensorBlock MCP Index](https://mcp-index.tensorblock.co/v1/servers/github-akzar1el-mcp-web-validator-4b38b48a/badge.svg)](https://tensorblock.co/mcp/servers/github-akzar1el-mcp-web-validator-4b38b48a)
[![mcp-web-validator MCP server](https://glama.ai/mcp/servers/AKzar1el/mcp-web-validator/badges/score.svg)](https://glama.ai/mcp/servers/AKzar1el/mcp-web-validator)


An MCP server for HTML and CSS validation, technical SEO and accessibility checks, JSON-LD syntax validation, broken-link checks, and responsive screenshots. It is part of the [DigestSEO](https://digestseo.com/) suite of open-source SEO tools.

- Product: [digestseo.com/validator-mcp](https://digestseo.com/validator-mcp/)
- Engineering case study: [DigestSEO MCP Suite — AI visibility, Search Console, web validation, and trend intelligence](https://tomiseregi.si/projects/digestseo-mcp-suite)
- Documentation: [this README](https://github.com/AKzar1el/mcp-web-validator#readme)
- Support: [digestseo.com/support](https://digestseo.com/support/)
- Privacy: [digestseo.com/privacy](https://digestseo.com/privacy/)

## Choose the right surface

This repository contains two deliberately separate MCP surfaces:

| Surface | Transport | Best for | Access and side effects |
| --- | --- | --- | --- |
| Local npm server | stdio | Claude Desktop, Cursor, and other local MCP clients | Can read user-selected workspace files, contact validation and link targets, and write screenshot files. |
| Hosted app | Streamable HTTP | ChatGPT and remote MCP clients | Can fetch one authorized public HTML page, run a bounded sitemap-first site audit, or process supplied markup. It cannot access local files, authenticate, recursively crawl links, execute page JavaScript, or create screenshots. |

Local installation:

```bash
npx -y mcp-web-validator
```

Hosted endpoint:

```text
https://web-validator-mcp.digestseo.com/mcp
```

## Requirements

- Node.js 22.12.0 or newer
- An MCP client that supports stdio, or a client that supports Streamable HTTP for the hosted endpoint

The validation, SEO, schema, link, and report tools do not download a browser during installation. The local `screenshot.capture` tool installs its pinned headless browser into Puppeteer's cache on first use, then reuses that browser for later screenshots. Set `PUPPETEER_CACHE_DIR` if you need a custom cache location.

## Tools

**Large results:** MCP structured diagnostic previews are bounded by serialized byte size. Exact totals and severity counts remain available, and `truncated` indicates omitted previews. `links.broken` also returns `totalLinks`. Extremely large `report.validation` results use a condensed Markdown summary instead of oversized tables; the score and check-status values still reflect the full audit.

The npm package exposes these exact runtime tool names:

| Tool | Purpose | Network or filesystem behavior |
| --- | --- | --- |
| `html.local` | Validate a local HTML or XHTML file. | Reads the selected file and submits its markup to the external W3C Nu HTML Checker at `validator.w3.org/nu/`; `.xhtml` paths use `application/xhtml+xml` parsing semantics. |
| `html.url` | Validate the markup returned by a public URL. | Fetches the URL, then submits the returned markup to the external Nu checker. |
| `http.directives` | Review 1-8 caller-supplied same-origin HTTP response observations for non-HTML document MIME types, X-Robots-Tag noindex/agent scopes and conflicts, HTTP Link canonical declarations, attachment dispositions and status. | **Offline; no HTTP requests or binary downloads.** Returns only bounded resource numbers/counts and fixed review messages, not original URLs, headers, files or Google indexing verdicts. |
| `css.local` | Validate a local CSS file. | Reads the selected file and submits its CSS to the external W3C Jigsaw CSS Validator. |
| `seo.metadata` | Audit titles, descriptions, canonical tags, robots noindex directives, headings, viewport metadata, image alt attributes, and Open Graph metadata. | Processes supplied HTML locally. |
| `content.duplicates` | Compare exact and conservative near-duplicate main content within the same language across up to eight supplied HTML pages. | Fully offline, with no network, browser execution or storage; returns only evidence pairs and coverage, never main text. |
| `content.quality` | Review empty or short static main content, repeated substantive boilerplate within sampled same-language URL families, and possible low unique value. | Offline analysis of up to eight supplied HTML pages; results are review signals, **not** proof that a short page lacks value or that Google penalized it. |
| `content.metadata` | Compare repeated, conflicting and mismatched title, description, canonical, Open Graph, Twitter and explicit robots metadata across 1-8 supplied same-origin HTML pages. | Fully offline; no page fetch, canonical selection, ranking or indexing verdict. Identical duplicate fields and social-title differences are advisory, not automatic SEO errors. |
| `content.provenance` | Compare explicit citations, dataset releases/snapshot dates, publication chronology, and methodology links with optional supplied source evidence and opt-in freshness windows. | Fully offline for up to eight supplied HTML pages; no citation/dataset fetching, external fact checks, browser, storage or claim of scientific truth. Missing source evidence remains unverified. |
| `content.competitors` | Compare static search-intent signals between one primary page and up to six user-supplied competitor pages. Optional caller-chosen intent and query-heading word overlap identify review leads, never ranking winners. | Fully offline; **does not fetch competitor sites, scrape SERPs, use GSC, run a semantic classifier or claim Google intent alignment**. |
| `product.claims` | Compare explicit local MCP capability promises in supplied or fetched landing-page HTML against the local runtime's **actually registered** tools and metadata. | Processes supplied HTML offline or fetches exactly one authorized public page using SSRF-safe network rules; registration consistency is **not** successful execution or a full marketing truth verdict. |
| `site.hreflang` | Compare up to 16 supplied localized HTML pages for hreflang return links, self references, locale conflicts, `x-default` and canonical target clusters. | Fully offline and cross-domain aware; no crawling, private credentials, local-file access or storage. Unseen targets are unverified, not broken. |
| `site.links` | Review contextual same-origin internal links, accessible anchor labels, generic link text, internal nofollow, repeated labels and lexical overlap with supplied destination headings. | Fully offline across 1-8 user-supplied same-origin HTML pages; **does not fetch linked pages, claim broken destinations, infer semantic relevance or Google rankings**. Navigation links and unsupplied targets are excluded/unverified. |
| `links.broken` | Check links extracted from supplied HTML. | Sends bounded HTTP requests to eligible public links. Returned link URLs omit queries and embedded credentials; requests still use the original URLs. |
| `media.diagnostics` | Review supplied static image, picture and video metadata: alt and link-name hints, intrinsic dimensions, loading/decoding/fetch priority, picture fallbacks and caption-track declarations. | Local-only, offline markup inspection with bounded redacted results. Does not fetch media, run Chromium, measure performance, decode files, verify caption contents or certify WCAG compliance. |
| `browser.wcag` | Sample interactive accessibility evidence in a fresh, sandboxed headless Chromium page: rendered accessible-name hints, positive tabindex, aria-hidden focus, custom role Tab stops, up to 24 real keyboard Tab targets, computed focus indicators and a native disclosure toggle. | Local-only, supplied HTML rendered **without script execution or page network requests**. Active scripts, embeds and refreshes are stripped; no buttons/links clicked or forms submitted, no screenshots or original input returned. Provides bounded **review leads**, never a WCAG certification or full dynamic-interaction test. The pinned browser may be downloaded on first use. |
| `schema.markup` | Parse JSON-LD blocks and report JSON syntax errors. | Processes supplied HTML locally. |
| `schema.supported` | Review explicit JSON-LD structures for a limited set of Article, Product, BreadcrumbList, FAQPage, Organization and WebSite profiles. | Fully offline; checks bounded property shapes and review recommendations, **not** complete Schema.org validity, Google rich-result eligibility, content correctness or external contexts. The original syntax checker remains unchanged. |
| `report.validation` | Combine HTML/XHTML, optional CSS, SEO, JSON-LD, and bounded link checks in a Markdown report. | Reads selected files, contacts the validators, and checks eligible public links found in the markup; `.xhtml` inputs use XHTML parsing semantics for Nu validation. |
| `audit.history` | Opt-in local site-audit snapshot history: `save`, `list`, or `get` by ID. | Stores comparison-relevant fields only in one local JSON file, with a hard cap of 10 versions (oldest automatically evicted). No database or network access. |
| `screenshot.capture` | Capture desktop, tablet, mobile, or custom viewport screenshots. | Opens a selected local file or eligible public URL and writes PNG files to the selected output directory; existing matching files may be replaced. |

Different links that differ only by query parameters may therefore appear under the same displayed URL. Do not submit private tokens in HTML or URL inputs.

For direct Node.js integrations, `auditSeoMetadata(html, xRobotsTag)` and
`auditSeoMetadataDetailed(html, xRobotsTag)` from `dist/seo-auditor.js` accept
an optional caller-observed `X-Robots-Tag` HTTP response-header value. Separate
multiple header fields with newlines. This inspection is offline and never
fetches headers; the MCP `seo.metadata` tool still analyzes supplied HTML only.

## Hosted app tools

The hosted app exposes sixteen tools in the proposed source code (deployed catalog may differ):

| Tool | Purpose |
| --- | --- |
| `audit_public_webpage` | Fetch one authorized public HTML page and run the combined HTML, SEO/accessibility-signal, and JSON-LD syntax audit. Link checks are optional. |
| `audit_public_site` | Run a bounded sitemap-first audit of up to eight authorized, same-origin public pages. It respects `robots.txt`, returns compact page coverage and deduplicated findings, **plus a sampled cross-page indexability evidence graph**, **same-language exact/near-duplicate main-content pairs**, **static empty/short/boilerplate content-quality review**, and **hreflang/canonical cluster evidence**. Full 16-page reciprocal coverage requires the local offline tool with supplied page HTML. No site-wide link checks. |
| `compare_site_audits` | Offline before/after comparison of two saved `audit_public_site` structured results. Flags per-page regressions, coverage loss, and sitemap drift; reports newly observed or no-longer observed grouped findings only for an identical, fully checked page sample; partial sitemap coverage never proves a site-wide fix. No network calls or retained history. |
| `verify_product_claims` | Check visible explicit hosted tool names, an advertised site batch limit, and selected read-only/screenshot-scope statements against the hosted MCP's registered tool names, schemas and annotations. Accepts supplied static HTML or one authorized public HTML URL; unknown statements remain unverified. |
| `verify_content_provenance` | Offline comparison of explicit citation URLs, dataset metadata, published/modified dates and methodology references in up to eight caller-supplied HTML pages against optional supplied evidence. No citation URLs are fetched, and unsupported factual/freshness claims remain unverified. |
| `compare_competitor_intent` | Offline comparison of one primary and up to six user-supplied competitor HTML pages for static informational, commercial, transactional or navigational signals and optional exact query/heading lexical overlap; no competitor crawling, SERP or ranking inference. |
| `validate_html` | Validate supplied HTML or a public webpage URL (`url` field, or standalone URL in `html`). Uses the same bounded, redirect-checked public fetch as the webpage audit for URL inputs. |
| `validate_css` | Parse supplied CSS for syntax errors inside the Worker. |
| `audit_seo_metadata` | Audit supplied HTML for covered on-page SEO, robots noindex, and accessibility signals. |
| `validate_schema_markup` | Check JSON-LD blocks in supplied HTML for JSON syntax errors. |
| `validate_supported_schema` | Review supported JSON-LD node types and selected property structures, including Product offer prices, Article dates, breadcrumb positions and FAQ answer text. Unknown types remain unverified; no rich-result eligibility promise. |
| `review_internal_links` | Review contextual internal links and accessible anchor labels across 1-8 already-supplied same-origin static HTML pages, with limited lexical heading comparison for supplied targets. No network requests, search metrics, destination verification or semantic relevance assertions. |
| `review_metadata_consistency` | Offline consistency review of duplicate/conflicting title, description and canonical declarations, social metadata and robots directives, and repeated titles/descriptions between supplied same-origin pages. No network, selected-canonical or ranking claims. |
| `review_http_directives` | Offline review of 1-8 supplied same-origin non-HTML HTTP status, MIME, X-Robots-Tag, HTTP Link canonical and attachment observations. No live document request, indexed-status judgment, raw URL/headers or storage. |
| `check_broken_links` | Check up to 20 authorized public links extracted from supplied HTML. |
| `generate_validation_report` | Combine the checks for supplied markup; `base_url` resolves relative links but does not fetch a page. |

`audit_public_webpage` follows at most three validated redirects, accepts a bounded `text/html` response, and records the final URL. It does not crawl additional pages, execute JavaScript, authenticate, or fetch linked stylesheets and assets. `audit_public_site` first locks the final public origin, then reads bounded `robots.txt` plus same-origin XML Sitemap, RSS 2.0, Atom 1.0, and plain-text sitemap representations before auditing at most eight eligible sitemap pages in one call. Robots discovery may follow up to five validated public redirects across authorities, as defined by the robots protocol; the resulting rules and relative Sitemap directives are still interpreted for the originally audited authority. Sitemap entries and audited pages remain same-origin, and private/reserved destinations, credentials, custom ports, service self-fetches, and HTTPS-to-HTTP redirect downgrades are rejected. The tool never follows HTML links or external sitemap entries; use `page_offset` when the response says more eligible pages remain. The fetched HTML is sent to `https://html5.validator.nu/`, the same external Nu HTML Checker used by `validate_html` and the report tool. CSS parsing, SEO analysis, and JSON-LD parsing run inside the DigestSEO Worker. Optional link checks make capped `HEAD` requests, with a bounded `GET` fallback where necessary, to eligible public HTTP(S) URLs; link redirects are reported but not followed. The site tool intentionally does not perform site-wide link checking. The hosted app does not retain tool inputs, fetched HTML, or results.

### Sampled indexability evidence graph

The hosted `audit_public_site` result now includes per-page `indexability` static signals (canonical state/target, an **observed** noindex directive, bounded page title, and bounded hreflang declarations) and a new `indexability_graph` section. Findings are derived only from the HTML/headers already requested by the site audit: **zero additional page requests, no JavaScript execution, no stored audit history, and no extra recipients**.

The graph identifies evidence-supported canonical cycles and chains between sampled pages, sampled sitemap URLs observed with noindex, sampled canonicals pointing to other sampled noindex pages, potential duplicate titles for distinct canonical destinations, and missing sampled hreflang return links. `coverage_limited` and `limitations` explain why partial results cannot establish a site-wide pass.

A cross-page finding is not proof of deindexing, Google's selected canonical, a search ranking signal, or a traffic-change cause. Query-bearing/credentialed canonical and alternate URLs are **not echoed** and are excluded from cross-page assertions rather than incorrectly normalized to a different page. The graph does not follow canonical or hreflang links: targets must already be inside the bounded audited sample.

### Before/after site regression checks

1. Run `audit_public_site` on an authorized website and preserve the returned **structured result** as a baseline.
2. After a release or repair, rerun `audit_public_site` using the same website and page-selection settings. If continuing paginated audits, use the fingerprint supplied by that run; do not reuse a stale continuation.
3. Pass both structured results to `compare_site_audits` as `baseline` and `current`. Check `status`, `page_changes`, `limitations`, and `issue_group_comparison_available` before deciding whether a change is safe.

The comparison never fetches pages or keeps audit history. It separately reports failures and incomplete coverage. When both snapshots contain the same fully checked selected URLs and the same discovery fingerprint, grouped findings may be compared *within that sample*, even if the whole sitemap was not audited; this is **not** a verified site-wide fix. It cannot determine Google indexing or ranking changes, prove why traffic changed, or replace a complete accessibility audit. The `health_score_delta` is a heuristic within this tool, not a Google ranking metric.

### Optional local history: maximum 10 versions

The hosted app deliberately retains **nothing**. If you use the local npm/stdio MCP, `audit.history` can save the JSON `structuredContent` from `audit_public_site` on your own computer. Choose `action: "save"` and supply `snapshotJson` as a JSON string; use `list` to see saved version IDs and `get` with an ID to retrieve its compact JSON. You can then pass two retrieved snapshots to `compare_site_audits`. Saving is always opt-in; audits do not silently create history.

One compact `audit-history.json` file lives at `~/.mcp-validator/audit-history.json`; when `MCP_WEB_VALIDATOR_WORKSPACE_ROOT` is configured, the file instead lives in that root's `.mcp-validator/` directory. It stores **up to 10 total versions**, newest first when listed. Saving the eleventh automatically deletes the oldest. Each source snapshot is limited to 60 KB and is reduced to comparison-relevant fields (no raw HTML, browser screenshots, widget state, or full indexability graph). The history file has a 660 KB cap. There are no database services, background processes, or network calls. Files stay on the user's computer and are readable only with local filesystem access.

**Security:** Do not save secrets in page diagnostics. URL fields containing query strings, credentials, or fragments are rejected; audit-history file symlinks and oversized or corrupt files fail closed. Concurrent saves from one local process are serialized. Separate concurrently running MCP processes should use separate workspace roots to avoid writing the same file.

#### Test the storage boundary

Run `npm test` to exercise the local history implementation **through a real stdio MCP client**: saving 11 versions, evicting only the oldest, retrieving a snapshot after the MCP process restarts, and isolating two different workspace roots. The hosted Worker test suite separately verifies that multiple ChatGPT-style HTTP clients can connect with no session cookie, that comparisons stay request-local, and that the hosted tool list **does not** expose `audit.history`.

Run `npm run smoke:hosted` to verify the **actually deployed** public MCP endpoint using read-only `initialize`, `tools/list`, and one offline JSON-LD check. This intentionally makes three small requests to the live service and does not crawl websites or save data. It fails if deployment still exposes an older tool catalog, even when repository CI is green. An HTTPS preview URL can be selected with `MCP_WEB_VALIDATOR_HOSTED_URL`. Do not mistake green source tests for a published deployment.

For a separately **opt-in live cross-surface smoke test**, from a repository checkout with dependencies installed, set `MCP_AUDIT_TARGET_URL` to the HTTPS root of a site you own or are authorized to inspect and run `npm run smoke:interop`. For example, in PowerShell: `$env:MCP_AUDIT_TARGET_URL = 'https://digestseo.com/'` followed by `npm run smoke:interop`. This makes **one** bounded, single-page hosted `audit_public_site` call, then checks local `audit.history` save/get and hosted `compare_site_audits` against the same snapshot. It saves only into a disposable temporary directory, cleans it up, and never creates cloud storage. Set `MCP_WEB_VALIDATOR_LOCAL_ENTRYPOINT` to an absolute path to test a separate installed stdio package rather than the repository build. A `partial` audit remains `partial`: the script reports validator coverage instead of claiming a site-wide clean bill of health. This check contacts the public site and W3C validator, so **it is not run by CI automatically**.

Local history is **not** a per-user cloud history system. ChatGPT users invoking the hosted MCP cannot retrieve local snapshots; cloud-side per-user persistence would require separately implemented authentication and storage. These tests prove the existing stateless architecture, not that unimplemented feature.

## Privacy Policy

Only validate files, markup, and public webpages that you own or are authorized to inspect. Public page URLs can contain sensitive query values, so remove tokens and private identifiers before submitting them. Do not submit passwords, API keys, access tokens, payment data, health data, private source code, or other sensitive personal data.

The local server runs with the same operating-system permissions as its MCP client. Review tool inputs before approving file access, outbound validation, link checking, or screenshot creation. The hosted app has no access to your local filesystem.

For tighter local-file validation scope, optionally set `MCP_WEB_VALIDATOR_WORKSPACE_ROOT` to an **absolute directory path** in the local MCP server's environment. When set, `html.local`, `css.local`, local-file inputs to `report.validation`, and local screenshot `targetPath` accept only files whose resolved paths (including symlinks) stay within that directory. Screenshot `outputDir` must also remain within the resolved root, including when creating a new nested directory or following an existing symlink. Screenshots write PNG bytes through an exclusive open temporary sibling file before replacing the final filename, so an existing hard link or symlink cannot redirect the image write. Without this setting, the documented user-selected local-file and screenshot destination behavior is unchanged. This is a defense against unintended tool arguments, not an isolation boundary against a malicious local process concurrently changing filesystem paths.

See the published [privacy policy](https://digestseo.com/privacy/) for data-handling details and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Configure a local client

### Claude Desktop

Add the server to `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-web-validator": {
      "command": "npx",
      "args": ["-y", "mcp-web-validator"]
    }
  }
}
```

Restart Claude Desktop after saving the configuration.

### Cursor and compatible clients

Create a command/stdio MCP server with:

```text
npx -y mcp-web-validator
```

This repository also includes a Cursor Marketplace plugin manifest. After the
plugin is published, install **Web Validator by DigestSEO** from Cursor's
Marketplace or add the repository from Cursor's plugin UI. The plugin bundles
the same local stdio server and does not require API keys or environment
variables.

### Visual Studio Code with GitHub Copilot

In VS Code, run **MCP: Add Server** from the Command Palette and choose **Command
(stdio)** with `npx -y mcp-web-validator`. Or add the following to your own
workspace's `.vscode/mcp.json` (VS Code format):

```json
{
  "servers": {
    "mcp-web-validator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-web-validator"]
    }
  }
}
```

For a remote-only connection, use this server entry instead (no local Node.js
required, but local-file and screenshot tools are unavailable):

```json
{
  "servers": {
    "mcp-web-validator-hosted": {
      "type": "http",
      "url": "https://web-validator-mcp.digestseo.com/mcp"
    }
  }
}
```

Open **MCP: List Servers** to start/check the connection. In Copilot Agent
chat, ask it to run `seo.metadata` on an HTML snippet you provide (input field
`htmlContent`) and report its metadata issues. This is an offline, no-network
smoke test of the local stdio server; it should return structured `issues` and
`totalIssues` without contacting W3C or fetching a webpage. Use the **local**
server for this check, since the hosted surface has different tool names.

The repository also contains a portable root `.mcp.json` for compatible
Copilot harness clients. Its top-level key is `mcpServers`, **not** `servers`;
do not copy that object unchanged into `.vscode/mcp.json`. VS Code's
[MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
explains the file formats and supported scopes. Review tool permissions before
allowing outbound validation or filesystem-writing screenshot calls.

### OpenAI Codex

Codex CLI can add the published local stdio package directly:

```bash
codex mcp add mcp-web-validator -- npx -y mcp-web-validator
```

Or add the existing hosted Streamable HTTP surface instead:

```bash
codex mcp add mcp-web-validator-hosted --url https://web-validator-mcp.digestseo.com/mcp
```

Verify either configuration with:

```bash
codex mcp list
```

The local package includes workspace-file validation and responsive screenshot
capture. The hosted surface is remote-only and cannot access local files or
create screenshots.

### Gemini CLI

Gemini CLI supports local stdio MCP servers. Add the published package with:

```bash
gemini mcp add mcp-web-validator npx -y mcp-web-validator
```

This writes the server definition to Gemini CLI's MCP configuration. No API
keys or environment variables are required by Web Validator.

### GitHub Copilot CLI

Add the published local stdio server with:

```bash
copilot mcp add mcp-web-validator -- npx -y mcp-web-validator
```

When Copilot CLI is started inside a clone of this repository, it can also
discover the checked-in root `.mcp.json`, which already points
`mcp-web-validator` at `npx -y mcp-web-validator`.

### Kiro

[![Add to Kiro](https://kiro.dev/images/add-to-kiro.svg)](https://kiro.dev/launch/mcp/add?name=mcp-web-validator&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-web-validator%22%5D%2C%22disabled%22%3Afalse%2C%22autoApprove%22%3A%5B%5D%7D)

This installs the local stdio package, preserving its workspace-file and screenshot capabilities. Node.js 22.12.0+ is required.

## Development

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/AKzar1el/mcp-web-validator.git
cd mcp-web-validator
npm ci
```

Run the local quality gates:

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

Run the local stdio server:

```bash
npm start
```

Validate the hosted Worker separately:

```bash
cd chatgpt-plugin
npm ci
npm run check
npm test
npm run deploy:dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations. Deployment and marketplace-review notes live in [chatgpt-plugin/SUBMISSION.md](chatgpt-plugin/SUBMISSION.md).
For agent-assisted installation, see [llms-install.md](llms-install.md).
For a copy-ready, zero-paid-provider GitHub Actions metadata gate, see [examples/github-actions](examples/github-actions/README.md).

## Ecosystem

[![LightNow capabilities](https://lightnow.ai/badge/io.github.AKzar1el/mcp-web-validator)](https://lightnow.ai/servers/io.github.AKzar1el/mcp-web-validator)

## License

Licensed under the [MIT License](LICENSE).
