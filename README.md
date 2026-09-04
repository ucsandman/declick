# declick

A compiler for the interface your agent already has: the shell. MCP makes an agent carry every tool's schema on every turn; declick compiles an API, an MCP server, or a database once into named verbs the model loads one at a time, and every verb returns one envelope with five exit codes. Ten engines, zero runtime dependencies, Node 24.

The saving is measured, not claimed: against nine real MCP servers (258 tools), the raw tool listing an MCP client puts in context is 236,818 bytes and `declick describe` is 58,309, a 4.1x reduction. `node scripts/bench-tokens.mjs` reproduces it on your own adapters; the method and the caveats are in [docs/bench.md](docs/bench.md).

[![npm](https://img.shields.io/npm/v/declick.svg)](https://www.npmjs.com/package/declick)
[![ci](https://github.com/ucsandman/declick/actions/workflows/ci.yml/badge.svg)](https://github.com/ucsandman/declick/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D24-informational)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

![declick compiling the National Weather Service, Openverse, a GraphQL API, a SQLite database, the gh binary, an MCP server and GitHub's 1,224-verb REST spec, then making live calls, hitting a governance block, and listing the audit log](docs/demo.gif)

## Quickstart

Requires Node 24 or newer. An older Node exits 1 with one line naming the version it found, from either entry point, instead of a stack trace.

```
npm i -g declick
declick setup
declick add https://petstore3.swagger.io/api/v3/openapi.json --name petstore
declick run petstore describe
declick run petstore get-user-by-name user1 --fields username,email
declick run petstore get-pet-by-id 7 --dry-run
```

`declick setup` puts `~/.declick/bin` on PATH, adopts your agent's existing MCP servers as adapters, adds a rules block to its instruction file, and (Claude Code only) installs a hook that nudges the model toward the adapter; `declick setup --revert` puts everything back byte for byte.

The fifth line is a real call: petstore's user endpoints declare no auth, so the envelope comes back with the row. `get-pet-by-id` declares an API key in the spec, so without `PETSTORE_API_KEY` set it exits 4 and names the key; `--dry-run` shows the request it would send instead.

`declick add` writes three things: `~/.declick/petstore/manifest.json` (the compiled surface), `~/.declick/bin/petstore` (a two line launcher, with a `petstore.cmd` twin on Windows), and a `petstore/SKILL.md` in each agent skills directory it knows about, so agents discover it without being told. It also writes declick's own skill next to it, so an agent that finds one adapter knows how to build the next.

`declick run <name> <verb>` works everywhere with no setup. Once `~/.declick/bin` is on PATH (`declick path --install` does it for new shells, `declick doctor` tells you whether it is), the short form `petstore get-pet-by-id 7` works too. Both forms have identical output and exit codes.

## Set up your agent, and undo it

Integrating declick into an agent by hand means four things. `declick setup` does all four in one call, and `declick setup --dry-run` shows the plan first:

1. **PATH.** The same thing `path --install` does: puts `~/.declick/bin` on PATH for new shells.
2. **Adopt the agent's MCP servers.** Reads `.claude.json`, `.mcp.json`, installed Claude Code plugins, and Codex's `config.toml`, and builds an adapter for each server it finds, so they get describe, `--fields`, `--limit` and the rest of the contract for free. A server that needs a bearer token it does not have is skipped and named, not silently dropped.
3. **A rules block.** Adds a fenced block between `<!-- declick:start -->` and `<!-- declick:end -->` markers to `CLAUDE.md` or `AGENTS.md`, telling the agent to reach for a declick adapter before an MCP call, WebFetch, a browser read or raw curl. Running setup again replaces the block in place instead of duplicating it.
4. **The Claude Code hook.** Registers a PreToolUse hook that nudges the model, once per adapter per session, when it calls an MCP tool or WebFetch that has a declick adapter. The hook also watches the tool call right after a nudge and counts it as followed (a shell command naming declick) or ignored, in `~/.declick/hooks/nudge-stats.json`; `declick doctor` shows the totals and the follow rate under `integration.nudge`, so a nudge that is wrong too often shows up as a number. A hook entry from an older setup gets the wider matcher in place on the next `declick setup`.

Before any of that writes anything, setup takes a byte-exact snapshot of every file it is about to touch under `~/.declick/setup/<timestamp>/`. `declick setup --revert` reads the latest snapshot and undoes exactly what setup did:

- A file setup touched that you have not edited since is restored byte for byte (or deleted, if setup created it).
- A file you edited since setup ran keeps your edits; revert removes only the rules block or the hook entry it added, nothing else.
- A file setup created is deleted.

The snapshot is also standalone: `node ~/.declick/setup/<timestamp>/revert.mjs` restores files with no dependency on the declick package, so it still works after `npm rm -g declick`. `declick uninstall --yes` runs a revert, if one is available, then deletes `~/.declick` entirely and prints the `npm rm -g declick` line.

## Why

Every time an agent reads a screenshot or a DOM to find a button, it pays in tokens and latency, and it pays again in the next session because nothing was learned. declick compiles the surface once and replays it deterministically: a spec, an app window, or a server becomes a set of named verbs with stable output. The point is not the conversion. It is that every generated CLI honors the same output contract no matter which engine produced it, and that declick itself honors it too, so an agent never has to leave the shell.

## Engines

Every engine is built in, with zero runtime dependencies. `declick engines` lists them and `declick engines --source <x>` says which one a source would land on before anything is written.

| Engine | Source |
|---|---|
| openapi | `spec.json`, `spec.yaml`, `https://.../openapi.json` (openapi 3 and swagger 2, json or yaml, through a built-in YAML parser) |
| postman | `collection.json` (postman v2.1), `insomnia.json` (v4 export) |
| har | `capture.har` from a browser network capture; `--host api.example.com` picks the API host |
| graphql | `graphql:https://.../graphql`, `schema.json`, `schema.graphql`; `--url` gives a schema file its endpoint |
| mcp | `mcp:<command args>` for stdio servers, `mcp:https://host/mcp` for streamable http |
| sqlite | `sqlite:<path>` or `data.db`: tables and views become list/get/insert/update/delete plus a parameterized `query` |
| cli | `cli:<binary> [fixed args]`, compiled from the tool's own `--help` |
| web | `web:https://<site> --recipes <dir>`: a real browser over CDP, and a miss returns the elements that are there instead of a screenshot |
| desktop | `app:<window title>` on Windows through [deskclaw](https://github.com/ucsandman/deskclaw) UI Automation. `declick engines` reports it as not ready, Windows only, on any other platform |
| compose | `compose:<chain.json>`: a chain of verbs from adapters you already built becomes one verb with one envelope (see "Compose verbs") |

A spec-shaped URL (`.json`, `.yaml`, `openapi`, `swagger`, `api-docs` in the path) routes to the openapi engine even when the `openapi` key is not in the first 64 KB, which is the case for large specs that list `components` first. A spec URL that answers 404 fails naming the status (`GET <url> -> 404`), and a plain page URL is told it is not a spec rather than compiled as one.

## Compose verbs

An agent that needs the owner behind a pet id runs two commands and remembers the join between them. Next session it works the join out again. A chain writes the join down once:

```json
{
  "compose": true,
  "verbs": [
    {
      "name": "pet-owner",
      "description": "the owner record behind a pet id",
      "args": [{ "name": "id", "description": "pet id" }],
      "steps": [
        { "run": "petstore get-pet-by-id {id}", "as": "pet" },
        { "run": "crm find-customer --name {pet.owner.name}", "as": "owner" }
      ],
      "returns": "owner"
    }
  ]
}
```

```
declick add compose:./chain.json --name ops     # or: declick compose ops --steps ./chain.json
ops pet-owner 7
declick compose ops                              # print the chain, step by step
```

`ops pet-owner 7` answers with one envelope, one exit code and one audit line, like any other verb; `--json`, `--fields`, `--limit` and `--dry-run` all work on the composite, and `meta` carries `steps` and `ms`. `{id}` reads the composite's own arguments and flags, `{pet.owner.name}` reads an earlier step's data through its `as`; an object or array is JSON-stringified into the argument, and a template naming nothing is refused when the chain is compiled, not when an agent first runs it. `returns` is a step's `as`, a template like `{owner.email}`, or, left out, the last step's data.

A step that exits non-zero stops the chain and the composite keeps that step's exit code, with an error naming it (`step 1 (petstore get-pet-by-id): GET /pet/999 -> 404`) and `data.steps` carrying every step that already ran. A step marked `"optional": true` records its error and lets the chain continue. `--dry-run` passes `--dry-run` to every step, so nothing is sent; a template that reads an earlier step stays literal in the preview.

Every step runs as its own `declick` command in a child process, so it is guarded, credentialed, defaulted and audited by its own adapter. A composite is mutating when any step's target verb is, resolved from the target manifests at compile time, so a mutating chain is put to DashClaw twice: once for the composite and once per mutating step. The audit log gets one line per step plus one for the composite. `declick add` refuses a chain naming an adapter or verb that is not there, and a chain that calls itself stops at eight levels deep.

## The output contract

Every generated adapter, and every `declick` command, follows this:

| Guarantee | Detail |
|---|---|
| `<name> describe` | Whole surface in under 2000 characters, about 500 tokens. Verbs, one line purpose, required args, base URL or window. A surface over the 2000 char ceiling pages itself: the page ends with a footer naming how many verbs are left, the total, and the flags that reach them (`--grep text`, `--offset N`, `--limit N`, `--verb v`). `--full` adds flag detail plus a `->` line showing each verb's compiled `returns` (shape and field names, or the `--rows` path), `--json` gives the same as data (`verbs[].returns` is always present there, `null` when the spec has no response schema). |
| `--json` | Default when stdout is not a TTY. Success: `{ok:true, data, meta:{count, truncated}}`. Failure: `{ok:false, error, exit}` plus `data` when the engine has a payload (an API error body, a desktop tree diff). `--json false` forces text. |
| `--fields a,b` | Project only named fields, dotted paths allowed (`--fields error.code,items.0.name`), resolved per row. Applies to top-level arrays and objects. A field list that matches nothing anywhere is exit 1 naming the available keys; a partial miss shows up in `meta.unknownFields`. |
| `--limit N` | Cap list output. Default 50. Must be a positive integer; anything else, including `0`, is exit 1. |
| `--rows path` | Unwrap a dotted array field inside a response object instead of projecting the object itself. `meta.rows` names the path, `meta.extra` carries the sibling fields (cursor, total, etc). Without `--rows`, a verb whose compiled `returns.rowsPath` names one is auto-unwrapped only when `--fields` or `--limit` is passed, so an unfiltered call returns the resource as the API sent it; `rowsPath` is compiled only for a list-shaped property, and `describe`/`manifest`/management output is never auto-unwrapped. |
| `--where k=v` | Filter a list before `--fields` and `--limit`. Repeatable and comma-separable, dotted paths allowed, every condition has to hold. Operators: `k=v`, `k!=v`, `k~re` (case-insensitive regex), `k>n`, `k>=n`, `k<n`, `k<=n`, `k=*` (present and not null). `meta.where` is `{matched, of}` and `meta.count` is what matched. A condition on a verb that answers with one object is exit 1. See "Filter a list before it reaches the model". |
| `--dry-run` | Every mutating verb accepts it, prints what it would do, and sets `meta.dryRun: true`. Management commands that write (`add`, `build`, `accept`, `import`, `skill`, `remove`, `path --install`, `desk arm\|disarm`) accept it too; `author`, `repair` and `ui` have no preview and refuse it. |
| `--each file` | Run the verb once per item in a file of inputs (`-` for stdin), in order, and get one envelope back: `data` is one entry per item, `meta` carries `count`, `failed` and `each: true`. Exit 0 when every item is ok, otherwise the exit of the first that was not. Each item is guarded and shaped on its own; `--dry-run` previews every item and an item can never cancel it. A failing item does not stop the rest; a blocked one does. See "Run a verb over a list". |
| `--no-defaults` | Ignore `~/.declick/<name>/defaults.json` for this call. `DECLICK_DEFAULTS=off` does the same for every call. See "Flag defaults per adapter". |
| `--max-bytes N` | Ceiling on the bytes `data` may carry, default 8192, `0` off, `DECLICK_MAX_BYTES` moves the default. Applied after `--where`, `--rows`, `--fields` and `--limit`; never to `--dry-run`, `--help` or `describe`. Over the cap: `meta.truncated: true`, `meta.capped: {bytes, max, hint}`, exit still 0. See "A ceiling on one answer". |
| `--cache <s>` | Answer a read-only verb from the response the wire already gave, when one is younger than `<s>` seconds. `meta.cache` is `{hit, age}` or `{hit: false, stored}`. Exit 1 on a mutating verb; `--dry-run`, `--cache 0` and `DECLICK_CACHE=off` bypass it. See "Cache a read". |
| Streams | A `text/event-stream` response is read as it arrives instead of buffered whole: `data` is an array of parsed events, and when the timeout budget runs out mid-stream you get every event that already came in, `meta.stream.truncatedByTimeout: true`, `meta.truncated: true` and exit 0, not an error. |
| Flags | `--flag value` and `--flag=value` both work. Boolean flags (`--json`, `--dry-run`, `--full`, `--help`) never consume the next argument, so order does not matter. Unknown flags are exit 1, never ignored. `--` ends flags. |
| Request flags | Verbs on the engines that speak HTTP (openapi, postman, har) also take `--header 'K: V'` (repeatable), `--base-url <url>` or `--server <index\|description>` (or `DECLICK_<NAME>_BASE_URL`), `--content-type <type>` to pick among the declared body types, `--body @file` / `--body-file <path>` / `--body -` for stdin, `--output <path>` for a binary response, `--retry N` and `--timeout <ms>`, `--verbose` (`meta.request`, `meta.response`, `meta.status`) and `--curl` (a runnable line with every secret masked as its env name). `describe --full` lists them. Each takes a value, so a bare `--retry` is exit 1, not a silent default. |
| Exit codes | 0 ok, 1 error, 2 not found (adapter, verb, window or element), 3 blocked (governance, deskclaw unarmed or STOP), 4 auth needed. |
| Mutating flag | The manifest marks each verb `mutating: true/false`. The runtime and the authoring replay route mutating verbs through the DashClaw guard when `DASHCLAW_API_KEY` is set (see Governance). With no key set they run normally, nothing is written to stderr, and the envelope records `governance: {enabled: false, decision: "skipped", reason: "no guard configured"}`. |
| Auth | The manifest names required env keys only. At runtime declick reads `process.env` first, then `~/.creds/vault.env` (`CREDS_VAULT` overrides), for just those names. `declick auth <name>` reports which keys are present and from where. Secrets never land in a manifest. |
| SKILL.md | Generated from the manifest: when to use, the describe output, three runnable examples, the `declick run` fallback, the exit codes that apply to that engine. Never overwrites a skill declick did not write. |
| Lint | `declick lint <name>` fails the build on: describe over 2000 chars, duplicate or reserved verb names (`describe`), flags or args that collide with the contract flags, descriptions over 80 chars or spanning lines, a relative or templated base URL, a path parameter with no arg, an invalid desktop recipe, or a value that looks like a secret. A failed build prints the first eight errors and a count of the rest. |

## Run a verb over a list

`--each <file>` runs one verb once per input and answers with a single envelope. The file is NDJSON, one JSON object per line; a file that starts with `[` is a JSON array of the same objects, and `--each -` reads from stdin. An item is either `{"args": [...], "flags": {...}}` or a flat object whose keys are the verb's argument and flag names. Whatever you type on the command line is the default for every item, and each item overrides it key by key.

```bash
$ cat pets.ndjson
{"petId": 7}
{"petId": 8}
{"args": ["9"], "flags": {"fields": "name"}}

$ declick run petstore get-pet-by-id --each pets.ndjson --dry-run
{"ok":true,"data":[
  {"input":{"petId":7},"ok":true,"exit":0,"data":{"method":"GET","url":"https://petstore3.swagger.io/api/v3/pet/7","headers":{"accept":"application/json","api_key":"<PETSTORE_API_KEY>"}}},
  {"input":{"petId":8},"ok":true,"exit":0,"data":{"method":"GET","url":"https://petstore3.swagger.io/api/v3/pet/8","headers":{"accept":"application/json","api_key":"<PETSTORE_API_KEY>"}}},
  {"input":{"args":["9"],"flags":{"fields":"name"}},"ok":true,"exit":0,"data":{"method":"GET","url":"https://petstore3.swagger.io/api/v3/pet/9","headers":{"accept":"application/json","api_key":"<PETSTORE_API_KEY>"}}}],
 "meta":{"count":3,"truncated":false,"failed":0,"each":true,"governance":{"enabled":false,"decision":"skipped","reason":"read-only verb"}}}
```

Every entry carries the item it came from, so a result is never separated from its input. A failing item is `{"input":..., "ok":false, "exit":N, "error":"..."}` and the batch keeps going; the process exits with the first failing item's code and `meta.failed` says how many there were. Governance is the one thing that stops a batch: after an item is blocked, the rest are reported as `not run: item N was blocked` rather than sent to the guard one by one. A file that cannot be read at all (a missing path, a line that is not JSON, an item that is neither shape) is exit 1 naming the line number, and nothing runs. The run log gets one line for the batch.

## Filter a list before it reaches the model

`--where k=v` narrows a list on the machine that has it. It runs before `--fields` and `--limit`, so a page of two hundred rows becomes the four that matter without any of the other one hundred and ninety six passing through the context.

```bash
$ declick run shop list-pets --where status=sold --where price>20 --fields id,name
{"ok":true,"data":[{"id":4,"name":"Cleo"}],
 "meta":{"count":1,"truncated":false,"where":{"matched":1,"of":200}, ...}}
```

| Operator | Means |
|---|---|
| `k=v` | equal. A number compares as a number (`id=7`), a bool as a bool (`done=true`), everything else as an exact string |
| `k!=v` | not equal, which includes a row with no value at that path |
| `k~re` | case-insensitive regex (`name~^a`, `url~github`) |
| `k>n` `k>=n` `k<n` `k<=n` | numeric comparison; a value that is not a number fails the condition |
| `k=*` | present and not null |

The flag repeats and splits on commas (`--where status=sold,price>20`), every condition has to hold, and a dotted path resolves per row (`--where owner.city=Oslo`). A regex cannot contain a comma, the same limit `--fields` has. `meta.where` is `{matched, of}` and `meta.count` is what matched, so a filtered call still says how big the page was. A condition alone unwraps a response object's rows the way `--fields` does. A condition on a verb that answers with one object is exit 1: `where applies to lists; get-pet returns an object`.

## A ceiling on one answer

A verb that returns 50 KB of JSON costs about 15,000 tokens of the agent's context, every time it is called, whether or not the agent needed more than two fields. So `data` has a ceiling: 8192 bytes by default, `DECLICK_MAX_BYTES` moves it, `--max-bytes N` moves it for one call, and `0` turns it off. Nothing fails; the answer arrives smaller and says so.

```bash
$ declick run shop list-big
{"ok":true,"data":[{"id":1,...},{"id":2,...}, ...30 of 200 rows],
 "meta":{"count":200,"truncated":true,
         "capped":{"bytes":52310,"max":8192,"hint":"add --fields or --limit; declick describe <name> --verb <verb> shows the shape"}}}
```

The cap is the last thing to touch the payload, after `--where`, `--rows`, `--fields` and `--limit`, so a call that already asked for two fields is rarely near it. A list drops rows from the tail and keeps at least one. A string is sliced. An object keeps every key and replaces its biggest values, biggest first, with `<40002 bytes; add --fields or --limit>`, so the shape an agent needs in order to write the right `--fields` is still readable at any cap. `--dry-run`, `--help` and `describe` are never capped. A `--each` batch is capped per item and never as a whole, because every entry is the record of a run that happened; a capped item carries its own `capped`.

## Cache a read

`--cache <seconds>` answers a read-only verb from the response the wire already gave, if one is younger than that.

```bash
declick run shop list-pets --cache 300 --fields id,name     # miss: goes to the API, stores the raw response
declick run shop list-pets --cache 300 --fields id,status   # hit: same entry, different shaping, no request
```

The key is the adapter, the verb, its positional args and its own flags. The contract flags are deliberately not in it, so `--fields`, `--limit`, `--where` and `--json` all read one stored response instead of storing four. Entries are files under `~/.declick/<name>/cache/`, holding the raw engine result under `{at, verb, args, flags, result}`; `declick build` clears them, because a rebuild recompiles the verbs they belong to, and `declick remove` takes them with the adapter.

`meta.cache` is `{hit: true, age: 42}` or `{hit: false, stored: true}`, and the audit line records `cache: hit` or `cache: miss`. Only a result that worked is stored, so a 500 is not pinned for the TTL. The local policy is still consulted on a hit, so a rule that blocks a verb blocks it whether or not an answer is on disk; the DashClaw guard is not, because only read-only verbs get this far. `--cache` on a mutating verb is exit 1 naming the verb, `--dry-run` neither reads nor writes an entry, and `--cache 0` or `DECLICK_CACHE=off` goes to the wire and stores nothing. A defaults file can set it per verb:

```bash
declick defaults shop --verb list-pets --set cache=300
```

## Flag defaults per adapter

`~/.declick/<name>/defaults.json` holds flags you would otherwise retype on every call. It sits beside `manifest.json`, so `declick build` never touches it.

```bash
declick defaults petstore --set limit=20 --set fields=id,name
declick defaults petstore --verb find-pets-by-status --set status=sold
declick defaults petstore              # print the file
declick defaults petstore --unset fields
declick defaults petstore --clear      # drop the file
```

```json
{
  "*": { "limit": 20, "fields": "id,name" },
  "find-pets-by-status": { "status": "sold" }
}
```

The `*` scope applies to every verb, a verb scope wins over `*`, and a flag typed on the command line wins over both. `meta.defaults` lists the keys a run took from the file, `declick describe <name>` prints them on a `defaults:` line, and `--no-defaults` or `DECLICK_DEFAULTS=off` ignores the file. A key the verb does not accept is exit 1 naming the file and the key, so a stale default is loud rather than silent.

## Warm MCP servers

A stdio MCP server is spawned per call, and the spawn is most of what the call costs: a real filesystem server measured 4.8 seconds, almost none of it the tool. `declick daemon start` keeps those servers alive between runs.

```bash
declick daemon start     # a detached local process, one per user
declick daemon status    # {running, pid, started, servers:[{adapter, pid, calls, idleMs}]}
declick daemon stop
```

Once it is up, every `declick run <mcp adapter> <verb>` connects to it first and reuses the running server instead of spawning one; the envelope says `meta.daemon: true` when it did. Nothing else changes: the verbs, the flags, the output contract, the local policy, the governance guard and the audit line are all still on the client side of the socket, so the daemon is a cache and never a way around them. `declick compose` runs its steps as ordinary `declick run` child processes, so a chain of MCP steps gets the warm servers with no extra work.

Servers are pooled per adapter and per what the adapter was spawned from, so rebuilding one with a different command gets a fresh server. A server nobody has called for `DECLICK_DAEMON_IDLE_MS` (default 600000) is dropped, and a daemon with no servers for the same window exits, so an idle machine ends up with no declick processes on it.

If the daemon is not running, or was killed, `declick run` spawns its own server exactly as before and says nothing: a 300 ms connect attempt is the whole cost of asking. HTTP MCP adapters never touch it, having no process to keep warm.

The endpoint is per user and `~/.declick/daemon.json` holds `{pid, endpoint, token, started}`. Every message carries that token and a wrong one is refused, which is what keeps the endpoint yours on Windows, where the pipe name is per user but a file mode means nothing; on macOS and Linux the socket and the file are both chmod 0600 as well. A `daemon.json` whose pid is gone is treated as no daemon at all.

## Works with any agent

declick is a command line tool, so the integration is the shell. `declick add` writes the adapter's `SKILL.md` into every agent skills directory that exists on the machine. `~/.claude/skills` (Claude Code) is always written; `~/.codex/skills` (Codex), `~/.hermes/skills` (Hermes), `~/.openclaw/skills` (OpenClaw) and `~/.agents/skills` are written when the directory is already there. It never creates a directory for an agent you do not have, and `DECLICK_SKILLS` names any other list, comma separated. An agent without a skills directory reads `declick describe <name>`, or you paste `declick skill <name> --print` into its AGENTS.md or system prompt. `declick setup` writes more, and only to the clients it finds: Claude Code gets the rules block and the PreToolUse hook, Codex and `~/.agents` get the rules block only, and every other agent gets adapters and skills the way `add` always wrote them.

A custom agent on the Anthropic SDK, the OpenAI SDK, or Anthropic Managed Agents needs one tool: run `declick run <adapter> <verb> [args] --json` and hand back stdout. The envelope is the tool result, the exit code is the status, and `describe --json` is the source for the tool's input schema. Nothing in that loop is specific to a model or a vendor. Governance is optional in the same way: with no DashClaw key set, mutating verbs run and nothing blocks.

```js
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const bin = fileURLToPath(import.meta.resolve('declick/bin/declick.mjs'));

// The one tool an SDK agent needs. The envelope is the result, on success and on failure.
export async function declick(adapter, verb, args = []) {
  const r = await promisify(execFile)(process.execPath, [bin, 'run', adapter, verb, ...args, '--json']).catch(e => e);
  return JSON.parse(r.stdout);
}
```

That is source, not captured output: `npm i declick` in the agent's project, then this function. Run on Node 24 against the published package, it returned the rows for `list-notes` on an mcp adapter and the exit 2 envelope for an unknown verb, with no shell involved.

## Compared with

- **Runtime REST clients such as restish** are built for a person at a keyboard: shorthand syntax, colored output, one API configured at a time. declick is built for a program: one envelope, five exit codes, a `describe` an agent can afford to read, and the same shape for a database or a window as for an API.
- **SDK generators such as openapi-generator and Speakeasy** produce a typed client library per language. The CLI on top, the output shaping and the exit codes are still yours to write. declick skips the library and writes the CLI.
- **MCP** gives an agent tools over a protocol, which needs an MCP client in the loop. The mcp engine compiles a server into shell verbs, so an agent with only a shell uses it, and `--fields` and `--limit` cut the result before it reaches the context window.
- **Screenshot and DOM agents** find the button again every session and pay tokens each time. The web and desktop engines record the path once and replay it, and a miss returns the elements that are there, not a screenshot.

The part none of those share is that all ten engines, and declick itself, honor the same contract, so an agent learns the output shape once.

## Governance

The guard is [DashClaw](https://github.com/ucsandman/DashClaw), the approval and policy layer for unattended agents from the same author: it intercepts a risky action before it runs and blocks it, or asks a person to approve it from anywhere, with one click. declick talks to it over one HTTP call per mutating verb. Nothing below is required. With no key set, a mutating verb runs, nothing is written to stderr, and the envelope records `governance.enabled` false with the reason `no guard configured`. Site: [dashclaw.io](https://www.dashclaw.io).

Set `DASHCLAW_API_KEY` and `DASHCLAW_URL` (no default endpoint; `DASHCLAW_URL` must be set alongside the key, https unless the host is loopback) and every real mutating call (runtime and authoring replay) posts `{action_type, agent_id, agent_name, declared_goal, risk_score, target, systems_touched, tool: {name, engine, method, args}}` to `<DASHCLAW_URL>/api/guard?record=true` (the key in `x-api-key`) with a 3 second timeout (`DASHCLAW_TIMEOUT_MS`). `args` is redacted first: anything secret-shaped becomes `<redacted>`, everything else is truncated at 64 chars. Risk scores: DELETE 70, PUT and PATCH 55, POST 45, desktop 60.

Once `DASHCLAW_API_KEY` is set, **strict is the default**: a guard that is unreachable, times out, blocks, or answers anything but a decision is exit 3. Set `DECLICK_GUARD=open` to fall back to warn-and-proceed on a guard failure instead (a `block` or `require_approval` decision the guard actually returns is still refused either way). `require_approval` exits 3 and carries `data.approvalId`. Every envelope, ok or not, carries `meta.governance: {enabled, decision, reason}` (`decision` is one of `allow`, `warn`, `block`, `require_approval`, `skipped` (no key set), `dry-run`, or `failed-open`).

Every invocation through `bin/run.mjs` appends one line to `~/.declick/audit.jsonl` (newest-last on disk, `declick audit` reads it newest-first): adapter, verb, mutating, dryRun, the governance decision, exit code, the bytes the envelope wrote to stdout and the duration. `DECLICK_AUDIT=off` turns this off.

`declick audit --sum` adds those lines up instead of listing them, per adapter and in total, sorted by bytes read, so the question "what did the adapters actually cost this week" is one command. `--adapter`, `--since` and `--failed` narrow the sum the way they narrow the lines.

```
$ declick audit --sum --since 24h --json false
github    88 calls   201.4 KB   14210ms   1 failed
petstore  102 calls  118.9 KB   7734ms    2 failed
calc      22 calls   19.9 KB    5102ms    0 failed
212 calls, 340.2 KB read through adapters, 3 failed
```

Credentials are scoped to the origin the adapter was built from: a request that goes to a different host than the one stored at build time (via `--base-url`/`--server` or an env override) does not get that adapter's keys unless the target name is listed in `DECLICK_ENV_ALLOW` (comma-separated) or the origin change was explicit on the command line, and either way `meta.credentials[]` records `{name, from, scopedTo, sentTo}` so the cross-origin release is visible in the envelope, not just a warning on stderr.

`declick ui` mints a random per-start token (`X-Declick-Token`) and every mutating POST from the page must echo it back (401 otherwise); `repair` and `add --goal` are refused with 403 unless the server was started with `--allow-authoring`. Mutating UI routes go through the same guard as the CLI.

### A local policy, with no service

DashClaw is the guard. `~/.declick/policy.json` is the floor under it: three decisions, one file, first match wins, no key, no endpoint, no network. It is checked on every run, read or write, before the request is built.

```json
{ "rules": [
  { "adapter": "petstore", "verb": "delete-*", "decision": "block", "reason": "no deletes from agents" },
  { "adapter": "*", "mutating": true, "decision": "warn", "reason": "writes are logged" },
  { "adapter": "crm", "decision": "allow" }
] }
```

A rule matches on `adapter` and `verb` (each a glob: `*`, a name, or a prefix like `delete-*`; both default to `*`) and, when it names `mutating`, only on verbs whose effective mutating flag equals it. `block` is exit 3 before anything is sent (`blocked by policy: <reason>`); `warn` is one stderr line and the verb runs, with DashClaw still getting the final say when a key is set; `allow` runs it and stops looking. No file, or no matching rule, means allow. `--dry-run` sends nothing, so it never asks the policy, exactly as it never asks the guard. The file fails closed: unreadable JSON, a bad decision or an unknown field makes every run exit 1 naming the file, so a policy nobody can read never reads as no policy.

```
declick policy                                  # the path, whether it exists, one line per rule
declick policy --check petstore delete-pet      # which rule wins for this verb, and why
declick policy --example                        # a file worth copying
```

`DECLICK_POLICY` moves the file. Every envelope a policy decided carries `meta.governance.source: "policy"`, and so does the audit line, so `declick audit` says which governor said no.

## Windows apps

deskclaw is a PowerShell layer over .NET UI Automation that can snapshot a window into a tree of `@eN` element refs and act on them. declick 0.3 needs deskclaw 0.3.0 or newer (`desk --version`) for the attributed snapshot lines (`value=`, `toggle=`, `selected=`, `expanded=`, `offscreen=`) that the richer recipe steps read. Acting is gated: `declick desk arm 15` opens a window of a few minutes, an unarmed acting call and a STOP file both surface as declick exit 3, and `declick desk status` shows both switches. declick does not modify deskclaw. It shells out to it.

A recipe is a list of deterministic steps with no model in the loop at replay time. Elements are located by a path of `ControlType:Name` segments matched against a fresh snapshot with backtracking, never by screen coordinates. Hand-written recipes work (`declick add app:Notepad --recipes fixtures/notepad`; a single `.json` file or `-` for stdin with `--verb` also work, and every recipe is validated before it is stored). The normal path is to let Claude write one:

```
declick desk arm 15
declick add app:Calculator --name calculator --goal "multiply two numbers and return the display" --verb multiply
declick run calculator multiply Three Four
```

`declick add --goal` runs one bounded Claude Code session (sonnet) that may only read the window tree through deskclaw. It proposes a recipe with an `example` and an `expect` regex. declick dry-runs the recipe to prove every element path resolves, routes the live replay through the governance guard when the recipe is mutating, replays it once for real, and saves it only when the returned value matches `expect`. A rejected proposal is kept at `~/.declick/<name>/proposals/<verb>.json`; `declick proposals <name>` lists them and `declick accept <name> <verb>` promotes one after you fix it. Nothing else changes.

`declick author <name> --goal "..."` adds a verb to an existing adapter. `declick repair <name> <verb>` runs the same loop seeded with the recipe and the tree diff from the last exit 2, which the runtime writes to `~/.declick/<name>/last-error.json` and `declick status <name>` shows. Requires the Claude Code CLI on PATH (`DECLICK_CLAUDE` overrides; `DECLICK_AUTHOR_TIMEOUT_MS` bounds the session, default 300000). The authoring session receives an allowlisted environment, never `ANTHROPIC_API_KEY` or your other keys.

When the app changes, replay does not guess. The missing path exits 2 and the envelope carries a diff of the recorded tree against the live one, so the failure is legible instead of a silent misclick. A window that is not open is reported as exactly that, with no repair suggested. A recipe placeholder that is not a declared arg is exit 1 before anything is clicked.

The full recipe step vocabulary, a worked recipe, the tree-diff envelope, the manifest field reference and every environment variable are in [docs/REFERENCE.md](docs/REFERENCE.md).

## declick ui

```
declick ui --open
```

One local page at `http://127.0.0.1:4870` (127.0.0.1 only): every adapter, its engine and verb count, the last run and result, an add form, and build, repair, remove buttons per row. Repair is enabled when the runtime has recorded an element miss for that adapter. Buttons run the same `declick` commands you would type. The server refuses requests whose Host or Origin is not its own, so a web page you happen to have open cannot drive it. It prints `{url, port, token, allowAuthoring}` on stdout.

## Everything is a command

An agent with only a shell can do all of this. Every command takes `--json` and returns the envelope above.

| Command | What it gives you |
|---|---|
| `declick doctor` | node version, home, whether `~/.declick/bin` is on PATH (with the fix), skill dirs, vault, deskclaw presence and arm state, `claude` on PATH, governance config, engine readiness, and integration state (has `setup` run, which clients have the rules block and hook, how many MCP servers are adapted). `blocking` and `warnings` are separate lists and `healthy` is true only when `blocking` is empty, so a fresh home with nothing on PATH is healthy with one warning. Exit 1 only when node is too old. |
| `declick daemon [start\|stop\|status]` | the warm MCP server pool. `start` launches a detached per-user daemon, `status` is `{running, pid, started, servers:[{adapter, pid, calls, idleMs}]}` and exit 2 when nothing is running, `stop` shuts it down and waits for it to go. With no action it reports status. |
| `declick setup [--dry-run] [--no-adopt] [--no-rules] [--no-hook] [--no-path] [--revert] [--keep-adapters]` | wire declick into the agents on this machine: PATH, adapters for their MCP servers, a rules block, the Claude Code hook; `--revert` undoes it byte for byte; `--dry-run` previews with no writes |
| `declick uninstall [--yes] [--keep-adapters]` | revert setup if it ran, then delete `~/.declick` entirely and print the `npm rm -g declick` line; refuses without `--yes`; `--dry-run` lists what would go |
| `declick list` | every adapter: engine, source, verb names, auth keys, last run, last error. A corrupt manifest is one broken row, not a crash. |
| `declick describe <n> [--full] [--verb v] [--grep text] [--offset N] [--limit N]` | the surface as text or data, paged instead of printed whole when it is large |
| `declick manifest <n> [--verb v]` | the compiled contract: http method, path, query, body props, or recipe steps |
| `declick run <n> <verb> [args] [--flags]` | invoke a verb without touching PATH |
| `declick status [<n>]` | last run, last error with the tree diff, pending proposals, stored recipes |
| `declick auth <n>` | which env keys are missing and where present ones came from; exit 4 when any is missing |
| `declick add <source> --name n [--verbs a,b \| --tag t] [--engine e] [--host h] [--url u] [--force] [--dry-run]` | build from any source in the engine table above; `--verbs` or `--tag` subsets a large spec, `--engine` overrides detection, `--host` picks the API host in a HAR capture, `--url` gives a GraphQL schema file its endpoint, `--force` overwrites a launcher or skill name collision (a name that already resolves on PATH, such as `calc` on Windows, is refused without it), `--dry-run` compiles and lints without writing (refused for `--goal` authoring, which has no preview) |
| `declick build <n> [--dry-run]` / `declick lint <n>` / `declick skill [<n>] [--print] [--force] [--dry-run]` | recompile from the stored source, check the contract, regenerate SKILL.md without refetching; `--print` writes one adapter's SKILL.md text to stdout instead of disk, `--dry-run` lists the paths it would write |
| `declick remove <n> [<verb>] [--force] [--dry-run]` | delete the manifest, the launcher and the skill, or just one verb. Removing a verb exits 2 if it does not exist, exit 1 if the adapter is not desktop-engine (its verbs come from the spec, not per-verb files) or if it is the last recipe without `--force`; deleting the last verb removes the whole adapter (`adapterRemoved: true`). `--dry-run` previews what would be deleted. |
| `declick export <n>` / `declick import [<file>\|-] [--force] [--dry-run]` | a JSON bundle of manifest plus recipes that rebuilds on another machine through lint. `import` reads `export`'s envelope as it comes, so `declick export petstore \| declick import -` round-trips. It refuses to replace an adapter of the same name whose `source`, `engine` or `baseUrl` differs (`data.diff`) unless `--force`; the write is transactional, rolling back only what that import created on failure. `--dry-run` validates and previews without writing. |
| `declick engines [--source x]` / `declick version` / `declick path [--install] [--dry-run]` | which engines this build has and what a source would compile to, which build, where things are; `--dry-run` on `path --install` previews without touching PATH |
| `declick author`, `repair`, `proposals`, `accept [--dry-run]`, `recipes`, `recipe`, `desk status \| arm [min] \| disarm [--dry-run]` | the desktop authoring loop; `author` and `repair` have no `--dry-run` preview |
| `declick commands` / `declick <cmd> --help` | the whole command surface as data, and one row (flags, examples, whether it previews) for one command. The shipped `declick` skill is rendered from the same table, so it cannot drift. |
| `declick audit [--adapter n] [--since 10m] [--failed] [--sum]` | one line per invocation from `~/.declick/audit.jsonl`, newest first: what ran, what governance decided, redacted args, bytes and ms. `--sum` totals them per adapter instead |
| `declick desk windows \| tree <window> \| read <window> <path> \| clipboard get\|set \| arm [min] \| disarm` | the desktop as data: `tree` takes `--depth N`, `--type Button`, `--grep re`, `--interactive`; `read` takes `--prop value\|name\|text\|toggle\|selected\|enabled` |
| `declick web tree <url> [--selector css] [--grep re]` / `declick web text <url> [--selector css] [--grep re]` | `tree` is a page as a tree of elements a recipe can click, interactive ones first, instead of a screenshot; `text` is the page's visible text as numbered lines. `--grep` filters either one (role, name and href for `tree`; the line for `text`) and exits 2 when nothing matches, so `declick web text <url> --grep "privacy policy"` answers "does the page say X" in one call |
| `declick defaults <n> [--verb v] [--set k=v] [--unset k] [--clear] [--dry-run]` | flag defaults for one adapter, printed, set, unset or cleared. `--set` and `--unset` repeat; without `--verb` they edit the `*` scope that applies to every verb. Every `--set` is checked against the flags that scope has, so a typo cannot be written |
| `declick import --example [--engine e]` / `declick manifest --schema` | a minimal valid bundle, and the manifest field reference as data |
| `declick ui [--port N] [--open] [--allow-authoring]` | the human page |

## Roadmap

Not yet shipped: a macOS/Linux desktop backend (deskclaw is Windows only), and an approval wait (`declick approve wait <id>`) for a DashClaw `require_approval` decision.

## Development

```
npm test
```

Zero runtime dependencies, zero dev dependencies. Tests are `node --test`; 503 pass on 0.4.1. The CI matrix runs `npm test` on Windows, Linux and macOS for every push and pull request.

`npm run qa` (`scripts/qa-real-specs.sh`, bash) is the release gate the suite cannot replace: it compiles six public specs (Stripe JSON and YAML, GitHub, Openverse, api.weather.gov, petstore3 YAML) from their live URLs, makes real keyless calls, checks the exit 4 path, `path --install` in a fresh login shell, the web page refusal, and the Node guard. Run it on Linux and macOS before every tag; `QA_FROM_NPM=1` runs it against the published package instead of the checkout.

From a clean clone:

```
git clone https://github.com/ucsandman/declick && cd declick
npm test
node bin/declick.mjs add fixtures/petstore.json --name petstore
node bin/declick.mjs run petstore get-pet-by-id 7 --dry-run
```

The suite passes whether or not `~/.declick/bin` is on PATH. A launcher declick wrote is recognized as its own, so after `declick path --install` the collision guard no longer reads those launchers as an existing binary of the same name.

The desktop live tests drive real windows, so they are opt in:

```
declick desk arm 15
DECLICK_LIVE=1 npm run test:live
declick desk disarm
```

Without `DECLICK_LIVE=1` they report as skipped rather than passing on no work.

## Releases

Bump `version` in package.json and add a CHANGELOG entry. The version is also embedded in `skills/declick/SKILL.md` (a test renders it from the command table and fails on a stale one, which is how the 0.6.1 push went red on CI) and in `site/index.html` and `site/controls.html`, so bump those in the same commit. Then `git tag v0.x.y && git push --tags`. The publish workflow runs the tests and publishes with provenance.

## License

0.3.0 on npm is MIT. Releases after 0.3.0 are under the Elastic License 2.0: read it, run it, change it, ship it inside your own product; do not offer it to others as a managed service. Free for individuals and for companies with fewer than ten people. Companies of ten or more buy seats at $19 per developer per month or $190 per year; production support (a named contact, two business day response, a private issue tracker) is $2,000 per year per company. Both are bought with a card at https://declick.dev/#license; the license arrives by email within a minute of paying and names what it covers.
