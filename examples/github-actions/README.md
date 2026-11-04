# Copy-ready GitHub Actions metadata gate

This example runs the **local** Web Validator MCP server (stdio) against a
single built HTML file, using its offline `seo.metadata` tool. It requires no
API key, paid provider, browser download, network audit target, or production
deployment. GitHub Actions runner and npm installation normally use network
access; the audit tool itself does not. GitHub Actions runner minutes depend on
your repository and account allowance; use only free minutes if you require
strictly zero spend.

1. In your website repository copy `check-metadata.mjs` to
   `.github/scripts/check-metadata.mjs` and `web-validator.yml` to
   `.github/workflows/web-validator.yml`.
2. Set the workflow's **Build website** command and `dist/index.html` path to
   your actual build script and generated HTML location. The example assumes
   an npm project with a committed `package-lock.json`.
3. Open a pull request. The job fails for Web Validator **error** findings,
   prints the counts, and treats warnings and informational findings as
   advisory. Input, transport, or invalid MCP response failures also fail
   closed, with a separate exit code.

This is **not** a W3C conformance check, a complete accessibility audit, or
live URL validation; it checks the supported on-page metadata and basic
accessibility signals in the selected generated HTML only. For full site
coverage, add a separate build-output enumeration and reporting strategy
instead of assuming that one `index.html` covers the entire site.

For local reproduction from a consuming project after installing
`mcp-web-validator` and `@modelcontextprotocol/sdk`:

```sh
node .github/scripts/check-metadata.mjs dist/index.html
```
