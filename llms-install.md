# Web Validator by DigestSEO: installation instructions

Use this file with the repository README to install the local stdio MCP server.

## Requirements

- Node.js 22.12.0 or newer
- npm
- No API keys or environment variables are required

## Install and build

From the repository root, run:

```bash
npm ci
npm run build
```

The compiled server entry point is `dist/index.js`.

## Cline MCP configuration

Add a stdio server entry using the absolute path to the cloned repository:

```json
{
  "mcpServers": {
    "mcp-web-validator": {
      "command": "node",
      "args": ["<repository-root>/dist/index.js"]
    }
  }
}
```

Replace `<repository-root>` with the actual checkout path. On Windows, use the
absolute path with escaped backslashes or forward slashes in JSON.

## Cursor Marketplace plugin

This repository includes the Cursor plugin manifest at
`.cursor-plugin/plugin.json` and its MCP configuration at `mcp.json`. After
marketplace approval, install the plugin from Cursor's Marketplace. For local
plugin testing, place a checkout at:

```text
%USERPROFILE%\.cursor\plugins\local\mcp-web-validator
```

Then restart Cursor or reload its window. The plugin starts the published
package with `npx -y mcp-web-validator`; no API keys or environment variables
are required.

## Verify

Run the repository checks before enabling the server:

```bash
npm run check
```

The local server exposes these tools over stdio:

- `html.local` and `html.url` for W3C HTML validation
- `css.local` for W3C CSS validation
- `seo.metadata` for local SEO and accessibility-signal checks
- `links.broken` for bounded public-link checks
- `schema.markup` for JSON-LD syntax checks
- `report.validation` for a combined local report
- `screenshot.capture` for responsive screenshots

The local tools may read selected files, contact W3C validators or eligible
public URLs, and write screenshot PNGs when explicitly called. Use only inputs
the user is authorized to inspect. The repository also documents a separate
hosted HTTP app; that hosted app is not required for this local Cline setup.
