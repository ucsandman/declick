# Changelog

## 0.1.0 (2026-09-02)

First release.

- One output contract for every generated CLI: `describe` under 500 tokens, `--json`, `--fields`, `--limit`, `--dry-run`, fixed exit codes, mutating verbs gated by DashClaw when configured, auth by env name through the creds vault, auto SKILL.md.
- openapi engine: compile a spec into verbs, dry-run and live calls.
- desktop engine for native Windows apps on deskclaw: deterministic recipes replayed against a fresh UI Automation snapshot, element paths by ControlType:Name, tree diff on a miss.
- Authoring and repair: `declick add app:<Window> --goal "..."` runs a bounded Claude Code session that proposes a recipe, dry-runs it, replays it once for real, and saves only on a matching result. `declick repair` reruns that seeded with the last diff.
- `declick ui`: local page listing every adapter with last run and build, repair, remove buttons.
- mcp and web sources exit 4 with the install line; delegates land in 0.2.
