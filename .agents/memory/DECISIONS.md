# Decisions

## 2026-09-02

- declick owns every engine natively (mcp via a JSON-RPC client, web via CDP) instead of delegating to mcporter or OpenCLI. opencli is not on npm, and a delegate cannot honor declick's output contract (the fixed envelope, exit codes and `--dry-run`/`--fields`/`--limit` behavior every generated adapter must have).
- The zero-dependency policy holds for the new engines: YAML is a vendored subset parser (no `js-yaml`), sqlite uses `node:sqlite`, and the browser is driven over raw CDP (no `puppeteer`/`playwright`).
- A verb's `mutating` flag is derived from its method or its recipe steps, not asserted freely; a manifest may only raise it above what was derived, never lower it below a genuinely mutating action.
- Governance is strict by default once `DASHCLAW_API_KEY` is set: an unreachable, timed-out, or non-decision guard response is exit 3 rather than warn-and-proceed. `DASHCLAW_URL` has no default endpoint and is required alongside the key.
- Row projection auto-unwraps only verb responses, never `describe`/`manifest` payloads, and only when `--fields` or `--limit` is passed, so paging flags never silently change the shape of introspection output.
- Credential scoping binds a key to the adapter's build-time origin; an explicit `--base-url` still releases the key across origins, with the release recorded in `meta.credentials` and a warning, rather than refused outright. Open product question: should an explicit `--base-url` refuse instead of warn-and-release.
- declick is a product (decided 2026-09-03): the GitHub repo stays public; 0.3.0 on npm stays MIT; every later release is under the Elastic License 2.0 (source public, no managed-service offering, license keys protected); commercial licenses for teams and production support are requested by email from the site. No pricing, keys, or paid features exist yet.
- The marketing site is two static routes with zero JavaScript, one shared stylesheet, self-hosted OFL fonts (Archivo, Spline Sans Mono), and every terminal block captured from the shipped 0.3.0 binary with the guard keys unset unless shown; docs/DESIGN.md holds the identity and the recapture procedure.
- The nudge hook (Claude Code PreToolUse) matches Bash and PowerShell as well as MCP and WebFetch, so it can count whether the call after a nudge was a declick call. The count is the answer to the adoption risk a reviewer named: a nudge that is wrong too often shows as a low followRate in doctor, not as users ripping the hook out. A shell call with no nudge pending writes nothing (2026-09-04).
- The site tiers the ten engines: openapi, mcp, sqlite and compose lead as the four most agents need and the six others sit below them with the note that web, desktop and cli drive something live and carry its flakiness. Fewer engines harder is positioning, not deletion; the engines that cannot be copied from the MCP spec stay (2026-09-04).

## 2026-09-06

- The team store is a shared folder, a git checkout, or a read-only https base of `declick export` bundles, not a hosted registry or nix packaging: nix caches binaries per machine rather than sharing a compiled adapter across a team, and it is WSL-only on Windows, where declick otherwise runs native. declick's win is the compiled adapter itself, and sharing that needs no service, no auth server and no publish step beyond a file copy or a git push.
- Store wins on pull, local wins on push: a pull never has to guess whether a local edit was intentional, and a push never has to merge someone else's state into what a machine just built.
- Defaults in a pulled bundle land only where the machine has none yet; a user's tuned defaults are never overwritten by a teammate's.
- The store ships free for everyone, not a seat-gated feature: sharing adapters is table stakes for a team tool, not a paid tier.
