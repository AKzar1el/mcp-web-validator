# DigestSEO Web Validator

Local review of HTML markup, canonical and robots metadata, title/description consistency, social metadata, and selected JSON-LD structural profiles in VS Code. Reuses the bounded analysis modules of the open-source [Web Validator MCP server](https://github.com/AKzar1el/mcp-web-validator). The editor extension is independent of the MCP runtime.

## Use

Open an HTML document. The extension reviews it on open and save; use **DigestSEO: Review Active HTML** to review unsaved text. Findings appear in the Problems panel. HTML parser recovery findings have source offsets; metadata and JSON-LD findings are document-level. **DigestSEO: Clear Diagnostics** clears findings. Editing a document clears stale findings until the next review.

Set the optional resource setting `digestseoWebValidator.pageUrl` to the exact intended HTTP(S) document URL before comparing resolved canonical and Open Graph targets. If omitted, URL-dependent comparisons are skipped. Set `digestseoWebValidator.onSave` to false to disable automatic review.

## Scope and privacy

The extension processes open HTML text locally, with a 180,000 UTF-8 byte input bound and capped findings. It does not scan a workspace, send source to any service, execute HTML/JS, fetch URLs, modify source, require an API key, or collect extension telemetry.

HTML parser recovery warnings are not a complete HTML conformance test. Canonical and noindex observations are not evidence of Google's selected canonical or index status. An intentional noindex is not an error. JSON-LD checks use selected bounded structural profiles; they are not full Schema.org or rich-result eligibility validation. Template source and client-rendered output may differ.

## Development

In this directory, use Node 22 and run:

```sh
npm ci
npm test
npm run package
```

The build bundles only the local analysis modules and includes their dependency license notices. The parent MCP server and release remain unchanged. Set `VSCODE_EXECUTABLE` to an installed VS Code executable, then run `npm run test:host`. This starts a disposable profile, disables optional update and AI activity only in that profile, and requires an explicit receipt from the real extension host. The test does not modify your normal VS Code settings.

[Web Validator project](https://digestseo.com/validator-mcp/) | [Maintainer portfolio](https://tomiseregi.si/) | [Issues](https://github.com/AKzar1el/mcp-web-validator/issues)

MIT licensed; see LICENSE and bundled third-party notices.
