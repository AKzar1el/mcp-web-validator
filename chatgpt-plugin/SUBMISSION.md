# ChatGPT plugin submission notes

This directory contains the public Streamable HTTP app included in the Web Validator by DigestSEO plugin. It is intentionally separate from the repository's local npm/stdio server.

## Public app boundary

The hosted app accepts supplied HTML/CSS, can fetch one explicitly requested public HTML webpage, and can run a tightly bounded sitemap-first audit of an authorized public site. It cannot read local files, create files, run Puppeteer, authenticate to websites, execute page JavaScript, recursively follow HTML links, or perform an unbounded crawl. No tool changes user data or publishes content.

Data flow by tool:

| Tool | Processing and recipients | Annotations |
| --- | --- | --- |
| `audit_public_webpage` | Fetches one authorized public `text/html` page with bounded size, time, and redirects; sends the fetched HTML to `https://html5.validator.nu/`; runs local SEO/accessibility-signal and JSON-LD syntax checks; and optionally checks up to 20 eligible links. | `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false` |
| `audit_public_site` | Fetches one authorized public site seed, then reads bounded same-origin `robots.txt` and XML sitemap documents to audit at most eight same-origin eligible `text/html` pages. It respects applicable robots rules, rejects private/reserved/custom-port and cross-origin destinations/redirects, does not follow HTML links, and does not run site-wide link checks. Eligible page HTML may be sent to `https://html5.validator.nu/`; SEO/accessibility and JSON-LD checks run inside the Worker. | `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false` |
| `validate_html` | Sends supplied HTML to `https://html5.validator.nu/`, an external Nu HTML Checker service, and returns capped diagnostics. | `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false` |
| `validate_css` | Parses supplied CSS inside the Worker without an external validation request. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `audit_seo_metadata` | Analyzes supplied HTML inside the Worker. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `validate_schema_markup` | Parses JSON-LD blocks inside the Worker. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `check_broken_links` | Makes capped `HEAD` requests, with a bounded `GET` fallback where required, to up to 20 eligible public HTTP(S) links. Redirects are not followed and response bodies are not retained. | `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false` |
| `generate_validation_report` | Combines external Nu HTML validation with local CSS, SEO, and JSON-LD checks for supplied markup; public link requests occur only when explicitly enabled. `base_url` resolves relative links and does not fetch a page. | `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false` |

DigestSEO does not retain tool inputs, fetched HTML, robots files, sitemaps, or results. Do not submit credential-bearing URLs, access tokens, payment data, health data, private source code, or other sensitive personal data. For `audit_public_webpage` and eligible pages in `audit_public_site`, the requested public host receives bounded requests and the external `html5.validator.nu` service receives fetched HTML for validation. That external service is outside DigestSEO's control.

## Production endpoint

- MCP URL: `https://web-validator-mcp.digestseo.com/mcp`
- Health URL: `https://web-validator-mcp.digestseo.com/health`
- Authentication: none
- Expected discovery: eight tools and one UI resource
- CSP app domain: `https://web-validator-mcp.digestseo.com`

The endpoint is universal, not a per-workspace URL template.

## Submission metadata

- Name: `Web Validator by DigestSEO`
- Publisher/company URL: `https://digestseo.com/validator-mcp/`
- Documentation URL: `https://github.com/AKzar1el/mcp-web-validator#readme`
- Logo: `https://raw.githubusercontent.com/AKzar1el/mcp-web-validator/main/icon.jpg` (1024 × 1024 JPEG)
- Privacy policy: `https://digestseo.com/privacy/`
- Support: `https://digestseo.com/support/`
- Terms: `https://digestseo.com/terms/`
- Description: `Audit one authorized public webpage, a bounded sitemap-first public site, or supplied markup with HTML validation, local SEO and JSON-LD syntax checks, and optional focused public-link checks.`

## Pre-submission verification

Run the locked local checks before deployment:

```powershell
cd chatgpt-plugin
npm ci
npm run check
npm test
npm run deploy:dry-run
```

Then deploy through the authorized Cloudflare account:

```powershell
npm run deploy
```

After deployment:

1. Confirm `/health` returns HTTP 200.
2. Use MCP Inspector to initialize the production `/mcp` endpoint, list all tools, read the UI resource, and call every tool with representative input.
3. Confirm a request with an unapproved `Origin` is rejected with HTTP 403 while normal server-to-server MCP requests still work.
4. Verify that tool names, descriptions, schemas, annotations, server instructions, the UI resource, CSP, app domain, and localization fields match the intended review snapshot.
5. Test the app in ChatGPT Developer Mode on web and mobile.
6. Confirm the privacy, support, terms, company, documentation, and icon URLs load without authentication.
7. Re-select **Scan Tools** in the plugin submission portal after the final deployment.

The server has no user authentication, so reviewer test credentials are not required.

## Review test set

Use genuine results from the deployed app. For apps with a UI, screenshots must show the real ChatGPT component rather than a mockup.

### Direct prompts

1. `Audit https://digestseo.com/validator-mcp/ as a public webpage. I own this page. Do not check its links. Show the three highest-priority findings.`
2. `Audit https://digestseo.com/ as a public site. I own this site. Start with five sitemap pages, do not check links, and tell me whether another bounded batch remains.`
3. `Validate this HTML and explain the problems: <html><head><title>Hi</title></head><body><img src="logo.png"></body></html>`
4. `Validate this CSS and explain the error: body {`
5. `Audit the SEO metadata in this HTML and give me the highest-priority fixes: <html><head><title>Hi</title></head><body><h1>Example</h1></body></html>`
6. `Check the JSON-LD in this HTML: <script type="application/ld+json">{</script>`
7. `Check the public links in this HTML. I own this test page and authorize the checks: <a href="https://example.com">Example</a>`
8. `Generate a validation report for this HTML: <html><head><title>Hi</title></head><body></body></html>`

### Indirect prompts

1. `Why is this markup invalid? <p><div>Example</div></p>`
2. `Find the on-page SEO problems in this document: <html>...</html>`

### Negative prompts

1. `Validate the CSS in my local file at C:\private\site.css.` The hosted app must not claim local-file access.
2. `Log in to this site and crawl private account pages.` The app must not request credentials or attempt authenticated crawling.
3. `Publish these SEO changes to my website.` The app must not claim write or publishing capabilities.
4. `Audit http://127.0.0.1/admin.` The app must reject loopback, private, reserved, credentialed, custom-port, and other non-public destinations.
5. `Crawl every page on this domain.` The app must use the bounded sitemap-first tool or explain its eight-page per-call cap; it must not claim an unbounded crawl or follow HTML links.

Record expected tool selection, arguments, output, widget behavior, and confirmation behavior for each test. Outputs should be relevant to the prompt and must not expose internal identifiers or diagnostic metadata.

## Annotation justification

Every hosted tool is non-mutating, so every tool uses `readOnlyHint: true`. CSS syntax, SEO, and JSON-LD checks stay inside the Worker and use `openWorldHint: false`. HTML validation sends markup to an external recipient, link checking contacts public hosts, the webpage tool fetches the requested public page, and the site tool fetches bounded public robots/sitemap/page resources; those tools therefore use `openWorldHint: true`. No tool is destructive. External interaction and data-recipient disclosures remain explicit in tool descriptions and server instructions.

## Review and maintenance

OpenAI stores the metadata discovered during **Scan Tools** as the version under review. Any change to tool names, descriptions, schemas, annotations, security schemes, `_meta`, server instructions, UI-resource metadata, or CSP requires a new deployment, a fresh scan, and a new review version. Live implementation-only fixes still require production regression testing.

Identity or business verification and the required `api.apps.read` / `api.apps.write` permissions must be complete before submission. Do not submit from a project configured for unsupported regional data residency.
