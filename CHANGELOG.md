# Changelog

## 0.2.0 (2026-09-02)

Everything an agent needs is now a declick command with the same JSON envelope and exit codes as the generated adapters.

- New commands: `run`, `status`, `doctor`, `auth`, `manifest`, `proposals`, `accept`, `recipes`, `recipe`, `skill`, `export`, `import`, `engines`, `version`, `path [--install]`, `desk status|arm|disarm`, `remove <name> <verb>`. `help` exits 0. `add --verbs a,b`, `--tag t`, `--engine e`, `--force`; `--recipes` accepts a file or `-`.
- Every management command honors `--json` (default when piped), `--fields`, `--limit`; errors are `{ok:false,error,exit}` envelopes. `list` survives a corrupt manifest. `ui` prints `{url,port}` on stdout and has an add form.
- Flags: `--k=v`, `--no-flag`, boolean flags never consume the next argument, repeated flags become arrays, `--` ends flags, bad `--limit` is exit 1, unknown flags on a verb are exit 1. Hyphenated query and body names work.
- OpenAPI: relative server URLs resolve against the spec URL, server variables substitute, local `$ref` parameters and bodies resolve, path plus operation parameters dedupe, required query flags are enforced and shown, oauth2 / openIdConnect / cookie auth is sent, 204 and empty bodies succeed, form bodies use the right content type, missing operationIds no longer collide, reserved names are renamed `param-*`, file sources are stored absolute.
- Desktop: `findByPath` backtracks; a closed window is reported as such; `last-error.json` clears on success and after repair; undeclared `{{vars}}` are exit 1; stored recipes are validated; missing deskclaw is a clear message.
- Authoring: the live replay goes through the governance guard; proposals are kept on every rejection including an unarmed desk; any ``` fence parses; timeouts are reported as timeouts; the child env is an allowlist; screen text is fenced as untrusted in the repair prompt; `mutating` defaults to true.
- Governance: shared `src/guard.mjs` with a 3s timeout, `r.ok` and decision checks, `warn` surfaced, method-based risk scores, `DECLICK_GUARD=strict`. A block is a JSON envelope with exit 3.
- Security: ui refuses foreign Host and Origin and non-JSON POSTs; adapter and verb names are validated on every path (no `../`); SKILL.md frontmatter is quoted and sanitized and never overwrites a foreign skill; launchers refuse to shadow an existing executable; the secret scanner catches mid-string tokens and stops rejecting long kebab names; manifests are written atomically with `manifestVersion`.
- `remove` deletes the launcher and the skill too. `describe` shows base URL or window and `--full`. SKILL.md gets runnable examples, the `declick run` fallback and engine-specific exit code advice. declick ships its own SKILL.md.
- mcp and web stubs exit 1 (was 4, the auth code). YAML specs get a convert hint instead of a JSON parser error.

## 0.1.0 (2026-09-02)

First release.

- One output contract for every generated CLI: `describe` under 500 tokens, `--json`, `--fields`, `--limit`, `--dry-run`, fixed exit codes, mutating verbs gated by DashClaw when configured, auth by env name through the creds vault, auto SKILL.md.
- openapi engine: compile a spec into verbs, dry-run and live calls.
- desktop engine for native Windows apps on deskclaw: deterministic recipes replayed against a fresh UI Automation snapshot, element paths by ControlType:Name, tree diff on a miss.
- Authoring and repair: `declick add app:<Window> --goal "..."` runs a bounded Claude Code session that proposes a recipe, dry-runs it, replays it once for real, and saves only on a matching result. `declick repair` reruns that seeded with the last diff.
- `declick ui`: local page listing every adapter with last run and build, repair, remove buttons.
- mcp and web sources exit 4 with the install line; delegates land in 0.2.
