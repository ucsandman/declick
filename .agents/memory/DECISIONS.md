# Decisions

## 2026-09-02

- declick owns every engine natively (mcp via a JSON-RPC client, web via CDP) instead of delegating to mcporter or OpenCLI. opencli is not on npm, and a delegate cannot honor declick's output contract (the fixed envelope, exit codes and `--dry-run`/`--fields`/`--limit` behavior every generated adapter must have).
- The zero-dependency policy holds for the new engines: YAML is a vendored subset parser (no `js-yaml`), sqlite uses `node:sqlite`, and the browser is driven over raw CDP (no `puppeteer`/`playwright`).
- A verb's `mutating` flag is derived from its method or its recipe steps, not asserted freely; a manifest may only raise it above what was derived, never lower it below a genuinely mutating action.
- Governance is strict by default once `DASHCLAW_API_KEY` is set: an unreachable, timed-out, or non-decision guard response is exit 3 rather than warn-and-proceed. `DASHCLAW_URL` has no default endpoint and is required alongside the key.
- Row projection auto-unwraps only verb responses, never `describe`/`manifest` payloads, and only when `--fields` or `--limit` is passed, so paging flags never silently change the shape of introspection output.
- Credential scoping binds a key to the adapter's build-time origin; an explicit `--base-url` still releases the key across origins, with the release recorded in `meta.credentials` and a warning, rather than refused outright. Open product question: should an explicit `--base-url` refuse instead of warn-and-release.
