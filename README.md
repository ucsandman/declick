# declick

Turn anything into a CLI so your agents stop clicking.

## Why

Every time an agent reads a screenshot or a DOM to find a button, it pays in tokens and latency, and it pays again in the next session because nothing was learned. declick compiles the surface once and replays it deterministically forever: a spec, an app window, or a server becomes a set of named verbs with stable output. The point is not the conversion, it is that every generated CLI honors the same output contract no matter which engine produced it.

declick wraps or sits beside the engines that already solved one input class each: [OpenCLI](https://github.com/jackwener/opencli) for websites and Electron apps, [mcporter](https://github.com/openclaw/mcporter) for MCP servers, and Printing Press style generators for API specs. The engine nobody built is native Windows, so declick owns that one, built on [deskclaw](https://github.com/ucsandman/deskclaw) UI Automation.

## Install

```
npm i -g declick
declick add https://petstore3.swagger.io/api/v3/openapi.json --name petstore
petstore describe
petstore get-pet-by-id 7 --dry-run
```

`declick add` writes three things: `~/.declick/petstore/manifest.json` (the compiled surface), `~/.declick/bin/petstore.cmd` (a two line launcher, add `~/.declick/bin` to PATH once), and `~/.claude/skills/petstore/SKILL.md` so agents discover it without being told.

Until `~/.declick/bin` is on PATH, run any adapter as `node bin/run.mjs petstore get-pet-by-id 7 --dry-run` from a clone.

## The output contract

| Guarantee | Detail |
|---|---|
| `<name> describe` | Whole surface in under 500 tokens. Verbs, one line purpose, required args. `--full` for flag detail. |
| `--json` | Default when stdout is not a TTY. Stable shape: `{ok, data, meta:{count, truncated}}`. |
| `--fields a,b` | Project only named fields. |
| `--limit N` | Cap list output. Default 50. |
| `--dry-run` | Every mutating verb accepts it and prints what it would do. |
| Exit codes | 0 ok, 1 error, 2 not found or element missing, 3 blocked (governance or STOP), 4 auth needed. |
| Mutating flag | The manifest marks each verb `mutating: true/false`. The runtime routes mutating verbs through the DashClaw guard when `DASHCLAW_API_KEY` is present, otherwise it prints a one line warning and proceeds. |
| Auth | The manifest names required env keys only. At runtime declick reads `process.env` first, then `~/.creds/vault.env`, for just those names. Secrets never land in a manifest. |
| SKILL.md | Generated from the manifest: when to use, the describe output, three examples. |
| Lint | `declick lint <name>` fails the build if any guarantee above is violated. |

## Desktop adapters: author, replay, repair

Hand-written recipes still work (`declick add app:Notepad --recipes fixtures/notepad`). The normal path is to let Claude write one:

```
declick add app:Calculator --goal "multiply two numbers and return the display" --verb multiply
calc multiply Three Four
```

`declick add --goal` runs one bounded Claude Code session (sonnet) that may only read the window tree through deskclaw. It proposes a recipe with an `example` and an `expect` regex. declick dry-runs the recipe to prove every element path resolves, replays it once for real (deskclaw must be armed: `desk arm 15`), and saves it only when the returned value matches `expect`. A rejected proposal is kept at `~/.declick/<name>/proposals/<verb>.json` for inspection, and nothing else changes.

`declick author <name> --goal "..."` adds a verb to an existing adapter. `declick repair <name> <verb>` runs the same loop seeded with the recipe and the tree diff from the last exit 2, which the runtime writes to `~/.declick/<name>/last-error.json`.

Requires the Claude Code CLI on PATH (`DECLICK_CLAUDE` overrides). The authoring session never receives `ANTHROPIC_API_KEY`.

## declick ui

```
declick ui --open
```

One local page at `http://127.0.0.1:4870` (127.0.0.1 only, no auth): every adapter, its engine and verb count, the last run and result, and three buttons per row: build, repair, remove. Repair is enabled when the runtime has recorded an element miss for that adapter. Buttons run the same `declick` commands you would type.

## Desktop engine

deskclaw is a PowerShell layer over .NET UI Automation that can snapshot a window into a tree of `@eN` element refs and act on them (`click`, `type`, `key`, `focus`). Acting is gated: `desk arm 15` opens a window of a few minutes, an unarmed acting call exits 4, and a STOP file halts everything with exit 3. declick does not modify deskclaw. It shells out to it.

A recipe is a list of deterministic steps with no model in the loop at replay time. Elements are located by a path of `ControlType:Name` segments matched against a fresh snapshot, never by screen coordinates, and `*` matches any name:

```json
{ "description": "Add two digits and read the display",
  "args": [{ "name": "a" }, { "name": "b" }], "mutating": true,
  "steps": [
    { "window": "Calculator" },
    { "find": ["Group:Number pad", "Button:{{a}}"], "as": "first" }, { "click": "first" },
    { "find": ["Group:Standard operators", "Button:Plus"], "as": "plus" }, { "click": "plus" },
    { "find": ["Text:Display is *"], "as": "display" }, { "read": "display", "as": "result" }
  ],
  "returns": "result" }
```

Build and run it:

```
desk arm 15
declick add app:Calculator --name calc --recipes fixtures/calculator
calc add Seven Seven
```

When the app changes, replay does not guess. The missing path exits 2 and prints a diff of the recorded tree against the live one, so the failure is legible instead of a silent misclick:

```
{"ok":false,"error":"element not found: Group:Standard operators > Button:Plus Sign in \"Calculator\"; run: declick repair calc add","exit":2}
```

`declick repair <name> <verb>` reruns authoring seeded with that diff. See the authoring section above; hand-written recipes are still accepted through `--recipes <dir>`.

## Roadmap

- 0.2: mcp and web delegates through mcporter and OpenCLI. Both currently exit 4 with the install line.

## Development

```
npm test
```

Zero runtime dependencies, zero dev dependencies. Tests are `node --test`.

From a clean clone:

```
git clone https://github.com/ucsandman/declick && cd declick
npm test
node bin/declick.mjs add fixtures/petstore.json --name petstore
node bin/run.mjs petstore get-pet-by-id 7 --dry-run
```

Releases: bump `version` in package.json and add a CHANGELOG entry, then `git tag v0.x.y && git push --tags`. The publish workflow runs the tests and publishes with provenance.

The desktop live tests drive real windows, so they are opt in:

```
desk arm 15
DECLICK_LIVE=1 npm run test:live
desk disarm
```

Without `DECLICK_LIVE=1` they report as skipped rather than passing on no work. Env overrides used by the tests: `DECLICK_HOME` (adapter dir), `DECLICK_SKILLS` (SKILL.md target), `DECLICK_DESK` (path to the deskclaw launcher), `CREDS_VAULT` (env file to read key names from).
