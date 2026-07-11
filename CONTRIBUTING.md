# Contributing

Thank you for improving Web Validator by DigestSEO. Keep changes focused, testable, and explicit about network and filesystem behavior.

## Before you start

- Use Node.js 22.12.0 or newer.
- Search existing issues and pull requests before starting duplicate work.
- Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Never commit credentials, tokens, `.env` files, captured private pages, or user data.

## Repository structure

- `src/` contains the local npm/stdio MCP server. It can work with user-selected workspace files and create screenshots.
- `chatgpt-plugin/` contains the independently deployed, public Streamable HTTP app. It must not gain local-file or screenshot access.
- `registry/` contains Official MCP Registry metadata.

Keep the two MCP surfaces separate. A tool, schema, or disclosure change on one surface does not automatically apply to the other.

## Set up the local server

```bash
git clone https://github.com/AKzar1el/mcp-web-validator.git
cd mcp-web-validator
npm ci
npm run check
npm test
npm run build
```

Before submitting a package-related change, also inspect the package contents:

```bash
npm pack --dry-run
```

## Set up the hosted Worker

```bash
cd chatgpt-plugin
npm ci
npm run check
npm test
npm run deploy:dry-run
```

Do not deploy from a contribution branch. A maintainer is responsible for production deployment and marketplace metadata updates.

## Development expectations

- Validate tool inputs at runtime, not only in TypeScript types or advertised JSON Schema.
- Keep `inputSchema`, `outputSchema`, `structuredContent`, tool descriptions, annotations, and implementation behavior consistent.
- Add or update tests for success, invalid input, upstream failure, timeout, and boundary cases.
- Treat URLs as hostile input. Preserve public-address checks, redirect restrictions, request limits, timeouts, and concurrency limits.
- Keep stdio protocol output on stdout and send diagnostic logging to stderr.
- Do not log raw HTML, CSS, credentials, personal data, or complete tool payloads.
- Update README and submission disclosures whenever data recipients, retention, tool behavior, or permissions change.
- Use clear, non-promotional tool names and descriptions. Tool names are public API contracts and should not change without a migration reason.

## Pull requests

In the pull request description:

1. Explain the user-visible behavior and why it is needed.
2. Identify whether the local server, hosted app, or both are affected.
3. Describe network, filesystem, privacy, and compatibility implications.
4. List the commands you ran and their results.
5. Include real screenshots only when the UI changed.

Keep unrelated refactors out of the same pull request. Use a concise conventional commit-style title such as `fix: block private link targets` or `docs: clarify hosted data flow`.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
