# Contributing

Thanks for your interest! This project is small and the bar for contributions is
"does it work, is it tested, does it not break existing users."

## Quick start

```bash
git clone https://github.com/yzonur/sap-adt-mcp.git
cd sap-adt-mcp
npm install
npm test
```

You'll need a config at `~/.sap-adt-mcp/config.json` (see `config.example.json`)
to test the server end-to-end against a real SAP system. The unit tests do not
require any SAP connection.

## What to send a PR for

Welcome:

- New ADT endpoint coverage as a high-level tool (especially for object types
  that are awkward through `adt_request`)
- Better parsing of ADT XML responses into structured JSON
- Bug fixes with a regression test
- Documentation, example prompts, troubleshooting tips
- NetWeaver / S/4 release-specific compatibility notes

Please discuss first (open an issue):

- Anything that adds a runtime dependency
- Schema changes to existing tools (breaks downstream agents)
- Network behavior changes (timeout defaults, retry semantics)

Out of scope:

- Wrappers around endpoints that have meaningful security implications
  (arbitrary RFC calls, generic table reads against business data)
- ABAP debugger integration
- ADT mock servers

## Coding conventions

- Pure JavaScript, ESM, Node 18+. No TypeScript build step.
- All comments in source code in **English**.
- Prefer the standard library over new dependencies. Both runtime deps
  (`@modelcontextprotocol/sdk`, `undici`) are deliberate; please don't add more
  without discussion.
- Lint and test must pass: `npm run lint && npm test`.
- Add a test for any non-trivial pure function. Network code is harder to test
  and may not be covered — flag it in the PR if so.

## Tool design checklist

When adding a new high-level tool:

1. Keep the input schema flat and small. Use the friendly type aliases from
   `src/object-uris.js` rather than forcing TADIR codes on the agent.
2. Wrap errors via `errorResult(...)` so the ADT XML error envelope gets parsed.
3. Decide how the tool behaves under `readOnly` mode. If it writes, document
   it. If its endpoint is a "read-only POST" (search, where-used, etc.), add it
   to `READONLY_POST_PATHS` in `adt-client.js`.
4. Document the tool in `README.md` (table + example prompt) and `CHANGELOG.md`.
5. If the endpoint shape varies across NetWeaver / S/4 releases, say so in the
   tool description so agents know to fall back to `adt_request`.

## Releasing (maintainers)

1. Update `CHANGELOG.md`.
2. Bump version in `package.json` (semver).
3. `npm publish --access public`.
4. Tag and push: `git tag vX.Y.Z && git push --tags`.
