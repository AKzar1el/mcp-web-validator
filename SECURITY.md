# Security policy

## Supported versions

Security fixes are applied to the current npm release of `mcp-web-validator` and the currently deployed hosted endpoint at `https://web-validator-mcp.digestseo.com/mcp`. Older npm versions are not supported; upgrade to the latest published version before reporting a problem that may already be fixed.

## Report a vulnerability privately

Do not open a public GitHub issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/AKzar1el/mcp-web-validator/security/advisories/new). If that form is unavailable, email `tomi.seregi99@gmail.com` with the subject `Security report: mcp-web-validator`. Do not include secrets or unrelated personal data.

Include, where possible:

- the affected surface (local npm server, hosted Worker, website, or packaging metadata);
- the affected version, commit, endpoint, and tool name;
- reproducible steps or a minimal proof of concept;
- the expected and observed impact;
- any suggested mitigation; and
- whether the issue has been disclosed elsewhere.

Please avoid accessing data that is not yours, disrupting the public service, or including credentials or personal data in the report. We aim to acknowledge complete reports within three business days and will coordinate remediation and disclosure with the reporter.

## Security boundaries

The local stdio server runs with the permissions of the MCP client that launches it. Its documented features can read user-selected files, make outbound validation and link-check requests, open local files or public URLs in a headless browser, and write screenshot files. Users should review every sensitive tool call and run MCP clients with least privilege.

The hosted app cannot access local files. It accepts only tool inputs supplied by the client, sends HTML validation payloads to the external `html5.validator.nu` service, and may contact eligible public URLs during authorized link checks. See the [privacy policy](https://digestseo.com/privacy/) for data-handling details.

The following are normally outside this project's vulnerability scope unless they expose a project-specific weakness:

- availability or behavior of third-party validation services;
- social-engineering reports without a technical vulnerability;
- automated scanner output without a reproducible impact; and
- denial-of-service testing against the production endpoint without prior written permission.
