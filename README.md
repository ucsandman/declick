# declick

Turn anything into a CLI so your agents stop clicking.

## Why

Every time an agent reads a screenshot or a DOM to find a button, it pays in tokens and latency, and it pays again in the next session because nothing was learned. declick compiles the surface once and replays it deterministically forever: a spec, an app window, or a server becomes a set of named verbs with stable output. The point is not the conversion, it is that every generated CLI honors the same output contract no matter which engine produced it, and that declick itself honors it too, so an agent never has to leave the shell.

declick wraps or sits beside the engines that already solved one input class each: [OpenCLI](https://github.com/jackwener/opencli) for websites and Electron apps, [mcporter](https://github.com/openclaw/mcporter) for MCP servers, and Printing Press style generators for API specs. The engine nobody built is native Windows, so declick owns that one, built on [deskclaw](https://github.com/ucsandman/deskclaw) UI Automation.

## Install

Requires Node 24 or newer.

```
npm i -g declick
declick add https://petstore3.swagger.io/api/v3/openapi.json --name petstore
declick run petstore describe
declick run petstore get-pet-by-id 7 --dry-run
```

`declick add` writes three things: `~/.declick/petstore/manifest.json` (the compiled surface), `~/.declick/bin/petstore.cmd` plus a bash twin (a two line launcher), and `~/.claude/skills/petstore/SKILL.md` so agents discover it without being told. It also writes `~/.claude/skills/declick/SKILL.md`, declick's own skill, so an agent that finds one adapter knows how to build the next.

`declick run <name> <verb>` works everywhere with no setup. Once `~/.declick/bin` is on PATH (`declick path --install` does it for new shells, `declick doctor` tells you whether it is), the short form `petstore get-pet-by-id 7` works too. Both forms have identical output and exit codes.

## The output contract

Every generated adapter, and every `declick` command, follows this:

| Guarantee | Detail |
|---|---|
| `<name> describe` | Whole surface in under 500 tokens. Verbs, one line purpose, required args, base URL or window. `--full` for flag detail, `--verb v` for one verb, `--json` for the same as data. |
| `--json` | Default when stdout is not a TTY. Success: `{ok:true, data, meta:{count, truncated}}`. Failure: `{ok:false, error, exit}` plus `data` when the engine has a payload (an API error body, a desktop tree diff). `--json false` forces text. |
| `--fields a,b` | Project only named fields. Applies to top-level arrays and objects. |
| `--limit N` | Cap list output. Default 50. Must be a positive integer; anything else is exit 1. |
| `--dry-run` | Every mutating verb accepts it, prints what it would do, and sets `meta.dryRun: true`. |
| Flags | `--flag value` and `--flag=value` both work. Boolean flags (`--json`, `--dry-run`, `--full`, `--help`) never consume the next argument, so order does not matter. Unknown flags are exit 1, never ignored. `--` ends flags. |
| Exit codes | 0 ok, 1 error, 2 not found (adapter, verb, window or element), 3 blocked (governance, deskclaw unarmed or STOP), 4 auth needed. |
| Mutating flag | The manifest marks each verb `mutating: true/false`. The runtime and the authoring replay both route mutating verbs through the DashClaw guard when `DASHCLAW_API_KEY` is set (see Governance). Without a key it prints one warning line and proceeds. |
| Auth | The manifest names required env keys only. At runtime declick reads `process.env` first, then `~/.creds/vault.env` (`CREDS_VAULT` overrides), for just those names. `declick auth <name>` reports which keys are present and from where. Secrets never land in a manifest. |
| SKILL.md | Generated from the manifest: when to use, the describe output, three runnable examples, the `declick run` fallback, the exit codes that apply to that engine. Never overwrites a skill declick did not write. |
| Lint | `declick lint <name>` fails the build on: describe over 2000 chars, duplicate or reserved verb names (`describe`), flags or args that collide with the contract flags, descriptions over 80 chars or spanning lines, a relative or templated base URL, a path parameter with no arg, an invalid desktop recipe, or a value that looks like a secret. |

## Everything is a command

An agent with only a shell can do all of this. Every command takes `--json` and returns the envelope above.

| Command | What it gives you |
|---|---|
| `declick doctor` | node version, home, whether `~/.declick/bin` is on PATH (with the fix), skill dirs, vault, deskclaw presence and arm state, `claude` on PATH, governance config, engine readiness. Exit 1 only when node is too old. |
| `declick list` | every adapter: engine, source, verb names, auth keys, last run, last error. A corrupt manifest is one broken row, not a crash. |
| `declick describe <n> [--full] [--verb v]` | the surface as text or data |
| `declick manifest <n> [--verb v]` | the compiled contract: http method, path, query, body props, or recipe steps |
| `declick run <n> <verb> [args] [--flags]` | invoke a verb without touching PATH |
| `declick status [<n>]` | last run, last error with the tree diff, pending proposals, stored recipes |
| `declick auth <n>` | which env keys are missing and where present ones came from; exit 4 when any is missing |
| `declick add <source> --name n [--verbs a,b \| --tag t] [--engine e] [--force]` | build; `--verbs` or `--tag` subsets a large spec, `--engine` overrides detection, `--force` overwrites a launcher or skill name collision (a name that already resolves on PATH, such as `calc` on Windows, is refused without it) |
| `declick build <n>` / `declick lint <n>` / `declick skill [<n>]` | recompile from the stored source, check the contract, regenerate SKILL.md without refetching |
| `declick remove <n> [<verb>]` | delete the manifest, the launcher and the skill, or just one verb |
| `declick export <n>` / `declick import [<file>\|-]` | a JSON bundle of manifest plus recipes that rebuilds on another machine through lint |
| `declick engines` / `declick version` / `declick path [--install]` | what is live, which build, where things are |
| `declick author`, `repair`, `proposals`, `accept`, `recipes`, `recipe`, `desk` | the desktop authoring loop, below |
| `declick ui [--port N] [--open]` | the human page; prints `{url, port}` on stdout |

## Desktop adapters: author, replay, repair

Hand-written recipes still work (`declick add app:Notepad --recipes fixtures/notepad`; a single `.json` file or `-` for stdin with `--verb` also work, and every recipe is validated before it is stored). The normal path is to let Claude write one:

```
declick desk arm 15
declick add app:Calculator --name calculator --goal "multiply two numbers and return the display" --verb multiply
declick run calculator multiply Three Four
```

`declick add --goal` runs one bounded Claude Code session (sonnet) that may only read the window tree through deskclaw. It proposes a recipe with an `example` and an `expect` regex. declick dry-runs the recipe to prove every element path resolves, routes the live replay through the governance guard when the recipe is mutating, replays it once for real, and saves it only when the returned value matches `expect`. A rejected proposal is kept at `~/.declick/<name>/proposals/<verb>.json`; `declick proposals <name>` lists them and `declick accept <name> <verb>` promotes one after you fix it. Nothing else changes.

`declick author <name> --goal "..."` adds a verb to an existing adapter. `declick repair <name> <verb>` runs the same loop seeded with the recipe and the tree diff from the last exit 2, which the runtime writes to `~/.declick/<name>/last-error.json` and `declick status <name>` shows. `declick recipes <name>` and `declick recipe <name> <verb>` read what is stored; `declick remove <name> <verb>` drops one verb.

Requires the Claude Code CLI on PATH (`DECLICK_CLAUDE` overrides; `DECLICK_AUTHOR_TIMEOUT_MS` bounds the session, default 300000). The authoring session receives an allowlisted environment, never `ANTHROPIC_API_KEY` or your other keys.

## declick ui

```
declick ui --open
```

One local page at `http://127.0.0.1:4870` (127.0.0.1 only): every adapter, its engine and verb count, the last run and result, an add form, and build, repair, remove buttons per row. Repair is enabled when the runtime has recorded an element miss for that adapter. Buttons run the same `declick` commands you would type. The server refuses requests whose Host or Origin is not its own, so a web page you happen to have open cannot drive it.

## Desktop engine

deskclaw is a PowerShell layer over .NET UI Automation that can snapshot a window into a tree of `@eN` element refs and act on them (`click`, `type`, `key`, `focus`). Acting is gated: `declick desk arm 15` opens a window of a few minutes, an unarmed acting call and a STOP file both surface as declick exit 3, and `declick desk status` shows both switches. declick does not modify deskclaw. It shells out to it.

A recipe is a list of deterministic steps with no model in the loop at replay time. Elements are located by a path of `ControlType:Name` segments matched against a fresh snapshot with backtracking, never by screen coordinates, and `*` matches any name:

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
declick desk arm 15
declick add app:Calculator --name calculator --recipes fixtures/calculator
declick run calculator add Seven Seven
```

When the app changes, replay does not guess. The missing path exits 2 and the envelope carries a diff of the recorded tree against the live one, so the failure is legible instead of a silent misclick:

```
{"ok":false,"error":"element not found: Group:Standard operators > Button:Plus Sign in \"Calculator\"; run: declick repair calculator add","exit":2,"data":{"missing":[...],"added":[...],"unresolved":[...]}}
```

A window that is not open is reported as exactly that, with no repair suggested. A recipe placeholder that is not a declared arg is exit 1 before anything is clicked.

## Governance

Set `DASHCLAW_API_KEY` and every real mutating call (runtime and authoring replay) posts `{tool, action, risk_score, method, target}` to `DASHCLAW_URL` (default `https://my-dashclaw.vercel.app`) with a 3 second timeout (`DASHCLAW_TIMEOUT_MS`). Risk scores: DELETE 70, PUT and PATCH 55, POST 45, desktop 60. `block` and `require_approval` exit 3 with a JSON envelope; `warn` prints the reason and proceeds. A guard that is unreachable, times out, or answers anything but a decision prints a warning and proceeds, unless `DECLICK_GUARD=strict`, which turns every guard failure into exit 3.

## The manifest

`~/.declick/<name>/manifest.json` is the compiled contract, `manifestVersion: 1`. Fields: `name`, `engine`, `source` (absolute path or URL), `builtAt`, `baseUrl` or `window`, `auth.env[]`, `verbs[]` with `name`, `description`, `mutating`, `args[{name, required, type}]`, `flags[{name, description, required, type}]`, and per engine `http{method, path, query, bodyProps, bodyType, security}` or `recipe{steps, returns, tree}`. Read it with `declick manifest <name>`; do not edit it by hand, `declick build` regenerates it.

## Roadmap

- 0.2: mcp and web delegates through mcporter and OpenCLI. Both currently exit 1 with the install line.
- YAML specs: convert first with `npx js-yaml spec.yaml > spec.json`; declick stays dependency free.

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
node bin/declick.mjs run petstore get-pet-by-id 7 --dry-run
```

Releases: bump `version` in package.json and add a CHANGELOG entry, then `git tag v0.x.y && git push --tags`. The publish workflow runs the tests and publishes with provenance.

The desktop live tests drive real windows, so they are opt in:

```
declick desk arm 15
DECLICK_LIVE=1 npm run test:live
declick desk disarm
```

Without `DECLICK_LIVE=1` they report as skipped rather than passing on no work.

Env overrides: `DECLICK_HOME` (adapter dir), `DECLICK_SKILLS` (SKILL.md target), `OPENCLAW_SKILLS` (a second SKILL.md target), `DECLICK_DESK` (path to the deskclaw launcher), `DECLICK_CLAUDE` (authoring binary), `DECLICK_AUTHOR` (test double for the authoring binary), `DECLICK_AUTHOR_TIMEOUT_MS`, `CREDS_VAULT` (env file to read key names from), `DASHCLAW_API_KEY`, `DASHCLAW_URL`, `DASHCLAW_TIMEOUT_MS`, `DECLICK_GUARD`.
