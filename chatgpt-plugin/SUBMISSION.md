# ChatGPT plugin submission notes

This directory contains the public, remote ChatGPT App version of `mcp-web-validator`. It is intentionally separate from the repository's local stdio server.

## Public tool scope

The public app accepts supplied HTML or CSS. It does not access local files, create files, run Puppeteer, or retain user inputs. HTML validation sends supplied markup to the W3C Nu HTML Checker; CSS syntax parsing, SEO analysis, and JSON-LD checks run locally. Link checking sends `HEAD`/fallback `GET` requests to capped, public URLs from supplied markup. Redirects are not followed. No tool modifies user data.

## Pre-submission deployment

```powershell
cd chatgpt-plugin
npm install
npm run check
npm run deploy:dry-run
npm run deploy
```

Use the deployed `https://web-validator-mcp.digestseo.com/mcp` endpoint in the OpenAI plugin submission portal. The server has no user authentication, so no reviewer test credentials are required.

## Directory metadata

- Name: `Web Validator by DigestSEO`
- Publisher/company URL: `https://digestseo.com/validator-mcp/`
- Privacy policy: `https://digestseo.com/privacy/`
- Support: `https://digestseo.com/support/`
- Description: `Validate supplied HTML with the W3C Nu HTML Checker, parse CSS locally for syntax errors, audit on-page SEO metadata and JSON-LD, and check authorized public links.`

## Required review material

Create genuine screenshots in ChatGPT Developer Mode after deploying the Worker. Do not use mockups: screenshots must show the published app's real tool results.

Suggested reviewer prompts:

1. `Validate this HTML and explain the problems: <html><head><title>Hi</title></head><body><img src="logo.png"></body></html>`
2. `Validate this CSS and explain the error: body {`
3. `Audit the SEO metadata in this HTML and give me the highest-priority fixes: <html>...</html>`
4. `Check the JSON-LD in this HTML: <script type="application/ld+json">{</script>`
5. `Check the public links in this HTML. I own this test page and authorize the checks: <a href="https://example.com">Example</a>`
6. `Generate a validation report for this HTML: <html><head><title>Hi</title></head><body></body></html>`

In the submission form, explain that CSS syntax, SEO, and JSON-LD checks are local and marked `readOnlyHint: true`, `openWorldHint: false`. HTML validation, public link checks, and validation reports may send user-authorized inputs to external services, so they are marked `readOnlyHint: false`, `openWorldHint: true`, and `destructiveHint: false`.
