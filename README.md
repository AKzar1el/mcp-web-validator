# Web Validator by DigestSEO

[![npm version](https://img.shields.io/npm/v/mcp-web-validator.svg)](https://www.npmjs.com/package/mcp-web-validator)
[![CI](https://github.com/AKzar1el/mcp-web-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/mcp-web-validator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server for HTML and CSS validation, technical SEO and accessibility checks, JSON-LD syntax validation, broken-link checks, and responsive screenshots. It is part of the [DigestSEO](https://digestseo.com/) suite of open-source SEO tools.

- Product: [digestseo.com/validator-mcp](https://digestseo.com/validator-mcp/)
- Documentation: [this README](https://github.com/AKzar1el/mcp-web-validator#readme)
- Support: [digestseo.com/support](https://digestseo.com/support/)
- Privacy: [digestseo.com/privacy](https://digestseo.com/privacy/)

## Choose the right surface

This repository contains two deliberately separate MCP surfaces:

| Surface | Transport | Best for | Access and side effects |
| --- | --- | --- | --- |
| Local npm server | stdio | Claude Desktop, Cursor, and other local MCP clients | Can read user-selected workspace files, contact validation and link targets, and write screenshot files. |
| Hosted app | Streamable HTTP | ChatGPT and remote MCP clients | Can fetch one authorized public HTML page or process supplied markup. It cannot access local files, authenticate, crawl sites, execute page JavaScript, or create screenshots. |

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

Puppeteer may download a compatible browser during npm installation. The browser is used only by the local `screenshot_capture` tool.

## Local server tools

The npm package exposes these exact runtime tool names:

| Tool | Purpose | Network or filesystem behavior |
| --- | --- | --- |
| `html_validate_local` | Validate a local HTML file. | Reads the selected file and submits its markup to the external W3C Nu HTML Checker at `validator.w3.org/nu/`. |
| `html_validate_url` | Validate the markup returned by a public URL. | Fetches the URL, then submits the returned markup to the external Nu checker. |
| `css_validate_local` | Validate a local CSS file. | Reads the selected file and submits its CSS to the external W3C Jigsaw CSS Validator. |
| `seo_audit_metadata` | Audit titles, descriptions, canonical tags, headings, viewport metadata, image alt attributes, and Open Graph metadata. | Processes supplied HTML locally. |
| `links_check_broken` | Check links extracted from supplied HTML. | Sends bounded HTTP requests to eligible public links. |
| `schema_validate_markup` | Parse JSON-LD blocks and report JSON syntax errors. | Processes supplied HTML locally. |
| `report_generate_validation` | Combine HTML, optional CSS, SEO, JSON-LD, and bounded link checks in a Markdown report. | Reads selected files, contacts the validators, and checks eligible public links found in the HTML. |
| `screenshot_capture` | Capture desktop, tablet, mobile, or custom viewport screenshots. | Opens a selected local file or eligible public URL and writes PNG files to the selected output directory; existing matching files may be replaced. |

## Hosted app tools

The hosted app exposes seven tools:

| Tool | Purpose |
| --- | --- |
| `audit_public_webpage` | Fetch one authorized public HTML page and run the combined HTML, SEO/accessibility-signal, and JSON-LD syntax audit. Link checks are optional. |
| `validate_html` | Validate raw HTML markup already supplied in the conversation. |
| `validate_css` | Parse supplied CSS for syntax errors inside the Worker. |
| `audit_seo_metadata` | Audit supplied HTML for covered on-page SEO and accessibility signals. |
| `validate_schema_markup` | Check JSON-LD blocks in supplied HTML for JSON syntax errors. |
| `check_broken_links` | Check up to 20 authorized public links extracted from supplied HTML. |
| `generate_validation_report` | Combine the checks for supplied markup; `base_url` resolves relative links but does not fetch a page. |

`audit_public_webpage` follows at most three validated redirects, accepts a bounded `text/html` response, and records the final URL. It does not crawl additional pages, execute JavaScript, authenticate, or fetch linked stylesheets and assets. The fetched HTML is sent to `https://html5.validator.nu/`, the same external Nu HTML Checker used by `validate_html` and the report tool. CSS parsing, SEO analysis, and JSON-LD parsing run inside the DigestSEO Worker. Optional link checks make capped `HEAD` requests, with a bounded `GET` fallback where necessary, to eligible public HTTP(S) URLs; link redirects are reported but not followed. The hosted app does not retain tool inputs, fetched HTML, or results.

## Privacy and safe use

Only validate files, markup, and public webpages that you own or are authorized to inspect. Public page URLs can contain sensitive query values, so remove tokens and private identifiers before submitting them. Do not submit passwords, API keys, access tokens, payment data, health data, private source code, or other sensitive personal data.

The local server runs with the same operating-system permissions as its MCP client. Review tool inputs before approving file access, outbound validation, link checking, or screenshot creation. The hosted app has no access to your local filesystem.

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

## License

Licensed under the [MIT License](LICENSE).
