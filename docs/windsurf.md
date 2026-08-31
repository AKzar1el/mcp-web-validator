# Windsurf / Devin Desktop

mcp-web-validator works with Windsurf / Devin Desktop through Cascade's native MCP support.

## Local stdio setup

Open `~/.codeium/windsurf/mcp_config.json` and merge this server into the existing `mcpServers` object:

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

Do not replace existing MCP entries when adding this configuration.

## Verify

Reload Windsurf after changing the config, open Cascade's MCP settings, confirm `mcp-web-validator` starts, then inspect its tool list. A safe first check is to run a read-only validation against a public URL you control.

- Product: https://digestseo.com/validator-mcp/
- npm: https://www.npmjs.com/package/mcp-web-validator
- Official MCP Registry ID: `io.github.AKzar1el/mcp-web-validator`
- Windsurf MCP docs: https://docs.devin.ai/desktop/cascade/mcp
