# Safe local activation and release channels

This repository has **three different distribution states**:

1. **GitHub `main`**: the newest merged source, possibly not yet released.
2. **npm + official MCP Registry**: a separately versioned, public stdio distribution. Release tags trigger npm trusted publishing; successful npm publication triggers Registry publication.
3. **Hosted Cloudflare Worker**: a separate Streamable HTTP app deployed from `chatgpt-plugin/`. A Git push or an npm release does not deploy it, and neither action submits an OpenAI Platform app update.

The default `npx -y mcp-web-validator` command follows **published npm**, not GitHub `main`. A restarted MCP client may pick up a newer published package, subject to npm cache behavior, but restarting cannot make unversioned GitHub changes appear.

## Optional source-of-truth launcher for your own Codexify development environment

The opt-in launcher `scripts/activate-web-validator.mjs` checks the canonical
`AKzar1el/mcp-web-validator` GitHub `main` on *each MCP process start*. It:

- Contacts GitHub only before starting a new stdio MCP; no background polling.
- Never edits, switches, resets, cleans or builds your active Git worktrees.
- Clones the exact upstream commit into a **dedicated cache**; checks Git SHA,
  locked dependencies, TypeScript build and a **real stdio MCP canary** (four
  essential tool names, at least 39 total tools, and an offline `seo.metadata` call).
- Promotes that immutable revision only after every gate passes.
- Preserves last verified build when network, dependency installation, build,
  smoke test or another activation attempt fails. It also tolerates an
  intentionally offline policy (`MCP_WEB_VALIDATOR_UPDATE_POLICY=offline`).
- Keeps all logs on **stderr**, leaving stdout exclusively for JSON-RPC.
- Never restarts existing MCP processes; it only controls the **new** instance
  that its client is starting.

**Prerequisites:** Node.js 22.12+, Git, npm, and a trustworthy local copy of
this repository containing the launcher. Ensure the checkout already has a
built `dist/index.js` as an initial fallback (run `npm ci` and `npm run build`
once). The first successful GitHub activation creates its own reusable cache;
all subsequent updates are independent of the checkout. The launcher is
intentionally **not** the public npm package entrypoint.

### Configure exactly one MCP source

Point your local Codexify/Codex stdio MCP configuration at this script using an
**absolute path**, for example:

```json
{
  "mcpServers": {
    "mcp-web-validator": {
      "command": "node",
      "args": ["C:/absolute/path/to/mcp-web-validator/scripts/activate-web-validator.mjs"]
    }
  }
}
```

Use the format applicable to your MCP client. In Codex CLI the equivalent
existing `[mcp_servers.mcp-web-validator]` configuration has `command = "node"`
and `args = ["C:/absolute/path/to/.../scripts/activate-web-validator.mjs"]`.
**Do not add a second server under a different name** just to activate the
updater. Change only the Web Validator source; leave other MCPs and running
agents alone. Apply the configuration at your next normal service activation or
perform a deliberate reload of this **one** source when no call is active.

A sample local test, without changing any global MCP configuration:

```powershell
npm ci
npm run build
node --test test/activation-launcher.test.js
node scripts/smoke-activation.mjs
$env:MCP_WEB_VALIDATOR_UPDATE_POLICY = 'offline'
node scripts/activate-web-validator.mjs
```

The final command becomes a live stdio MCP server and stays open waiting for
JSON-RPC; press Ctrl+C to end a manual test. The offline policy starts the
cached verified version or the checkout's own built fallback. Clear that
environment variable to allow canonical GitHub updates next time.

### Fail-safe behavior, cache, and rollback

- Default cache: `~/.cache/mcp-web-validator-activation/`. Override with
  `MCP_WEB_VALIDATOR_ACTIVATION_HOME` for an explicitly dedicated test cache.
- `active.json` names the last successfully verified revision. Candidate
  sources live under `revisions/<40-character Git SHA>/` and are never modified
  in place. An atomic `.activation-lock` directory prevents competing builds.
- If the network fails, a newer commit changes during clone, smoke fails,
  or a lock exists, the launcher starts the last verified version. If the cache
  is empty, it falls back to the built `dist/index.js` next to the launcher.
  If neither exists, it exits clearly rather than serving a broken package.
- An interrupted first-time build can leave a staging directory or lock.
  **Do not blindly delete an existing lock or cache**: first verify no related
  activation/update process is alive. Revisions are retained deliberately,
  because currently running agents may still load those files. Clean old
  revisions only during a controlled maintenance window with no consumers.
- To roll back a bad GitHub commit, revert it through GitHub and allow CI to
  pass. For immediate offline fallback use a separately known-good launcher
  checkout or restore a previously verified `active.json` SHA; do not edit
  source inside an immutable cached revision.
- This is a *local developer opt-in*, **not** self-updating software for all
  npm users. The script can execute code merged to your trusted GitHub repo;
  protect `main` with reviews/CI and do not run it for untrusted forks.

## Professional public release checklist

- Merge feature work only after focused tests, complete source CI, dependency
  audit, package inspection and independent review.
- Batch related fixes. Bump the package version intentionally and sync
  `package-lock.json`, `registry/server.json`, `manifest.json`,
  `server.json`, and editor/plugin manifests before tagging. Document changes
  in `CHANGELOG.md`.
- Push a version tag `vX.Y.Z` only from the **exact green main commit**.
  The `publish-npm.yml` workflow uses npm trusted publishing with provenance;
  successful publication triggers `publish-mcp-registry.yml` to update the
  official registry. Verify the actual installed package afterward.
- GitHub Releases are separate and optional; their presence does not prove
  successful npm publication.
- Deploy the hosted Worker separately only when explicitly in release scope,
  with its own test/build/Cloudflare identity gates, then verify its actual
  `/mcp` endpoint with `npm run smoke:hosted`.
- **OpenAI Platform submission is always a separate user-controlled release
  channel and is not performed by any of the steps above.**
