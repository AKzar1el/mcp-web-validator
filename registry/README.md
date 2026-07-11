# Official MCP Registry publishing

`server.json` describes the hosted **Web Validator by DigestSEO** service, not
the repository's separate local stdio/MCPB package. Keeping the definitions
separate prevents the Registry listing from advertising local file access or
screenshot tools that are not available at the public endpoint.

## Preflight

- The endpoint must remain publicly reachable at
  `https://web-validator-mcp.digestseo.com/mcp`.
- The Registry server version must match the deployed hosted service version.
- Keep the `io.github.AKzar1el/` name when authenticating through GitHub as
  `AKzar1el`.
- Replace the icon URL only after the new image has been committed to the
  default branch and is publicly reachable over HTTPS.

## Publish

Install the official `mcp-publisher` binary, then run these commands from the
repository root:

```powershell
mcp-publisher login github
mcp-publisher publish registry/server.json
```

The first command opens GitHub's device-authorization flow. It requires an
interactive approval by the owner of the `AKzar1el` GitHub account; it does not
use the repository's GitHub token or require a Registry API key.

After publishing, verify the listing:

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.AKzar1el%2Fmcp-web-validator"
```

For future releases, bump `version` here before publishing a changed hosted
service version. The Registry is still in preview, so retain the publish output
and re-check its documentation before each release.
