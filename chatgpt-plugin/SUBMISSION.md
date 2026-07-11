# ChatGPT plugin submission notes

This directory contains the public Streamable HTTP app included in the Web Validator by DigestSEO plugin. It is intentionally separate from the repository's local npm/stdio server.

## Public app boundary

The hosted app accepts only HTML, CSS, options, and public URLs supplied in a tool call. It cannot read local files, create files, or run Puppeteer. No tool changes user data or publishes content.

Data flow by tool:

| Tool | Processing and recipients | Annotations |
| --- | --- | --- |
| `validate_html` | Sends supplied HTML to `https://html5.validator.nu/`, an external Nu HTML Checker service, and returns capped diagnostics. | `readOnlyHint: false`, `openWorldHint: true`, `destructiveHint: false` |
| `validate_css` | Parses supplied CSS inside the Worker without an external validation request. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `audit_seo_metadata` | Analyzes supplied HTML inside the Worker. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `validate_schema_markup` | Parses JSON-LD blocks inside the Worker. | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| `check_broken_links` | Makes capped `HEAD` requests, with a bounded `GET` fallback where required, to eligible public HTTP(S) links. Redirects are not followed and response bodies are not returned. | `readOnlyHint: false`, `openWorldHint: true`, `destructiveHint: false` |
| `generate_validation_report` | Combines external Nu HTML validation with local CSS, SEO, and JSON-LD checks; public link requests occur only when explicitly enabled. | `readOnlyHint: false`, `openWorldHint: true`, `destructiveHint: false` |

DigestSEO does not retain tool inputs or results. Do not submit credentials, access tokens, payment data, health data, private source code, or other sensitive personal data. The external `html5.validator.nu` service is a separate recipient of HTML submitted for validation; its operation is outside DigestSEO's control.

## Production endpoint

- MCP URL: `https://web-validator-mcp.digestseo.com/mcp`
- Health URL: `https://web-validator-mcp.digestseo.com/health`
- Authentication: none
- Expected discovery: six tools and one UI resource
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
- Description: `Validate supplied HTML with the Nu HTML Checker, parse CSS locally for syntax errors, audit on-page SEO metadata and JSON-LD, and check authorized public links.`

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

1. `Validate this HTML and explain the problems: <html><head><title>Hi</title></head><body><img src="logo.png"></body></html>`
2. `Validate this CSS and explain the error: body {`
3. `Audit the SEO metadata in this HTML and give me the highest-priority fixes: <html><head><title>Hi</title></head><body><h1>Example</h1></body></html>`
4. `Check the JSON-LD in this HTML: <script type="application/ld+json">{</script>`
5. `Check the public links in this HTML. I own this test page and authorize the checks: <a href="https://example.com">Example</a>`
6. `Generate a validation report for this HTML: <html><head><title>Hi</title></head><body></body></html>`

### Indirect prompts

1. `Why is this markup invalid? <p><div>Example</div></p>`
2. `Find the on-page SEO problems in this document: <html>...</html>`

### Negative prompts

1. `Validate the CSS in my local file at C:\private\site.css.` The hosted app must not claim local-file access.
2. `Log in to this site and crawl private account pages.` The app must not request credentials or attempt authenticated crawling.
3. `Publish these SEO changes to my website.` The app must not claim write or publishing capabilities.

Record expected tool selection, arguments, output, widget behavior, and confirmation behavior for each test. Outputs should be relevant to the prompt and must not expose internal identifiers or diagnostic metadata.

## Annotation justification

CSS syntax, SEO, and JSON-LD checks stay inside the Worker and do not change state, so they are advertised as read-only and closed-world. HTML validation sends user-supplied markup to an external recipient. Link checking contacts public third-party hosts. The aggregate report always performs external HTML validation and may also perform authorized link checks. Those outbound-data tools are deliberately marked `readOnlyHint: false` and `openWorldHint: true` so ChatGPT can present the appropriate approval boundary; none is destructive.

## Review and maintenance

OpenAI stores the metadata discovered during **Scan Tools** as the version under review. Any change to tool names, descriptions, schemas, annotations, security schemes, `_meta`, server instructions, UI-resource metadata, or CSP requires a new deployment, a fresh scan, and a new review version. Live implementation-only fixes still require production regression testing.

Identity or business verification and the required `api.apps.read` / `api.apps.write` permissions must be complete before submission. Do not submit from a project configured for unsupported regional data residency.
