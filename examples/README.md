# Example agent workflows

These are realistic prompts that exercise multiple `sap-adt-mcp` tools
together. Use them as a starting point — the agent decides the exact tool
sequence, you just describe the intent.

Pair each prompt with a system that has the relevant data: most workflows here
target a development system (DEV) and assume the agent's user has read access
to the package being explored. Workflows that write or release transports need
write access (i.e. `readOnly: false`).

Index:

- [Discover a project](./discover-project.md)
- [Audit a class](./audit-class.md)
- [Cross-system release verification](./release-verification.md)
- [Refactor with where-used safety](./refactor-with-where-used.md)
- [Triage a failing test](./triage-failing-test.md)
- [Scaffold a new class from spec](./scaffold-new-class.md)
