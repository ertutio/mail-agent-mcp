# GitHub installation releases

The project identity is `ertutio/mail-agent-mcp`, with MCP name
`io.github.ertutio/mail-agent-mcp`. Version `0.1.0` is the first release under this
fork identity; earlier upstream versions remain in the changelog.

The maintainer authorized this GitHub installation release. npm and MCP Registry
publication require separate authorization. `package.json` is private and
`server.json` has no published package entry. The release workflow draft remains
inactive; releases are assembled manually from a verified commit.

## Validate and freeze

Read [acceptance](../acceptance.md) before choosing checks. Verify
package/lock/server/runtime identity consistency, affected tests, build, lint,
whitespace, secret scan, both dependency audits and package contents. Complete
required Node 22/24 CI at the exact candidate SHA. Reuse still applicable T35
coverage; do not label historical coverage as a fresh run.

## Assemble and smoke-test

Build from the frozen commit. Stage only:

- `dist/`, `public/`, `package.json`, `package-lock.json`, `server.json`;
- `README.md`, `README.en.md`, `INSTALL.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`;
- `docs/agent-integration.md`.

Create `mail-agent-mcp-<version>.zip` with one `mail-agent-mcp-<version>` root
directory. Exclude source build helpers, development files, configuration,
credentials, logs, caches and `node_modules`. Dependencies remain external, so
the lockfile and `npm ci --omit=dev` are required; `dist` alone is insufficient.

Unpack the actual ZIP into a clean directory, install production dependencies,
run enrollment `--help`, and use an isolated temporary `IMAP_MCP_CONFIG_DIR` for
stdio `initialize` and `tools/list`. Check the returned server identity/version
and tool list. Do not invoke real-provider tools or read the maintainer profile.
Record the ZIP SHA256 in `SHA256SUMS.txt` after verification.

## Publish

Verify the final main commit has the tested candidate tree. Validate that the tag
is exactly `v<package.version>` and is a strict semantic version. Create the tag
at that commit and publish a GitHub Release with the ZIP, checksum file and notes
identifying the source SHA, Node requirement, installation command and verification
scope. With GitHub CLI, `--verify-tag` prevents accidental tagging of another
default-branch commit. Verify the published tag and assets match the local ZIP.

The installation smoke is separate from T36 real-provider deployment acceptance.
Keep T36 `NOT_RUN` until the actual configured process and representative mailbox
operations are explicitly authorized and verified.
