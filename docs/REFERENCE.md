# declick reference

The material the README links out to: the desktop recipe format, the compiled manifest, and every environment variable declick reads. The README covers the output contract, the engines and the command surface.

## Desktop recipe steps

A recipe is a list of deterministic steps with no model in the loop at replay time. Elements are located by a path of `ControlType:Name` segments matched against a fresh snapshot with backtracking, never by screen coordinates, and `*` matches any name.

A step is one of:

| Step | What it does |
|---|---|
| `window` | Focus the window, or launch it first if `manifest.launch` is set and it is not open |
| `launch` | Start the app inline |
| `find` / `wait-for` | Locate an element by path; `wait-for` polls up to `timeout` ms |
| `read-all` | Every match of a path as rows, with optional per-field sub-paths |
| `read` | A property off an already-found element: `name`, `value`, `toggle`, `selected`, `enabled`, `expanded`, or `text` for a live UIA text read |
| `wait-for-text` | Poll a window or element for substring text |
| `assert` | Compare a read value with `equals` or `matches`; fails the run unless `optional` |
| `click`, `type`, `key`, `scroll` | Act on a found element |
| `expand`, `collapse`, `select`, `context` | Tree and menu actions; `context` is a right-click |
| `set` | Drive a toggle or checkbox to a state |
| `clipboard` | `get` or `set` |
| `dismiss` | Escape on the foreground window |
| `wait` | A fixed pause |

Any step can carry `"optional": true` to skip instead of failing when its element is not there. `read` re-resolves its element against a fresh snapshot before reading, so it reports what a prior `click`, `type` or `set` actually did.

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

`declick recipes <name>` and `declick recipe <name> <verb>` read what is stored; `declick remove <name> <verb>` drops one verb.

When the app changes, replay does not guess. The missing path exits 2 and the envelope carries a diff of the recorded tree against the live one:

```
{"ok":false,"error":"element not found: Group:Standard operators > Button:Plus Sign in \"Calculator\"; run: declick repair calculator add","exit":2,"data":{"missing":[...],"added":[...],"unresolved":[...]}}
```

## The manifest

`~/.declick/<name>/manifest.json` is the compiled contract, `manifestVersion: 1`. Fields: `name`, `engine`, `source` (absolute path or URL), `builtAt`, `baseUrl` or `window`, `auth.env[]`, `verbs[]` with `name`, `description`, `mutating`, `args[{name, required, type}]`, `flags[{name, description, required, type}]`, `returns` (`{shape, fields, rowsPath?}`, compiled from the response schema for openapi verbs or from the recipe's `returns` alias for desktop verbs; `null` or `{shape:'none'}` when nothing is known), and per engine `http{method, path, query, bodyProps, bodyType, security}` or `recipe{steps, returns, tree}`. Read it with `declick manifest <name>`; do not edit it by hand, `declick build` regenerates it.

Every text field that can come from an untrusted spec or an imported bundle (`source`, `window`, `baseUrl`, verb and arg and flag names and descriptions, `returns.rowsPath` and return field names, `auth.env` entries) is validated to be one line, free of backticks, not starting with `#`, and under a length bound (100 chars for names, 200 for descriptions, 500 for source, window and baseUrl). `declick lint` rejects a manifest that breaks this; `describe` and `describe --json` also sanitize on the way out, so a manifest edited by hand still cannot inject markdown or fences into SKILL.md. On the way in, `saveManifest` normalizes a description first: one line, then its first sentence, and a sentence still over the bound is cut back to the last word boundary.

`declick manifest --schema` prints the same field reference as data.

## Per-adapter flag defaults

`~/.declick/<name>/defaults.json` is optional and hand-editable: an object of scopes, each an object of flag names to values.

```json
{
  "*": { "limit": 20, "fields": "id,name" },
  "find-pets-by-status": { "status": "sold" }
}
```

- `*` applies to every verb of the adapter; a key named after a verb applies to that verb only and overrides `*`; a flag typed on the command line overrides both. The keys that came from the file are listed in `meta.defaults`.
- Values are parsed exactly like the tokens they stand for: `"fields": "id,name"` splits into a field list, `"limit": 0` is the same error as `--limit 0`, `"dry-run": true` is the boolean. Keys may be kebab-case or camelCase. A key repeated across scopes is replaced, never turned into an array.
- A key the verb does not accept is exit 1 naming the file and the key; `declick defaults <name> --unset <key>` is the fix and is never checked against the manifest, so a file left behind by an old build is always repairable. `--set` refuses a value the runtime would reject and writes nothing.
- A file that is not valid JSON is exit 1 when a verb runs, naming the file and the `--clear` that fixes it. `describe`, `lint`, `build` and `skill` keep working and print `defaults: unreadable`.
- The file lives beside `manifest.json`, so `declick build` and `declick add --force` leave it alone; `declick remove` deletes the directory and takes it with it.

`--no-defaults` skips the file for one call; `DECLICK_DEFAULTS=off` skips it for every call.

## Batch input (`--each`)

`--each <file>` takes NDJSON, one JSON object per line, blank lines ignored; a file whose first non-space character is `[` is a JSON array of the same objects; `--each -` reads stdin. An item is one of two shapes:

| Shape | Example | Meaning |
|---|---|---|
| Explicit | `{"args": ["7"], "flags": {"fields": "id,name"}}` | positional args by index, flags by name |
| Shorthand | `{"petId": 7, "fields": "id,name"}` | keys matching the verb's arg names become positional args, everything else is a flag |

An item that mixes the two, an item that is not an object, a line that is not JSON, and a file that does not exist are exit 1 naming the line, and nothing runs. Values become the tokens the same call would have carried: a number its digits, an array a repeated flag, an object JSON, `true`/`false` a boolean flag. A value the parser rejects fails that item only, like a flag name the verb does not know. Command-line args and flags are the defaults for every item and are overridden per key, except `--dry-run`, which an item can turn on but never off.

The answer is one envelope. `data` is one entry per item in input order: `input` (the item as read), `ok`, `exit`, and `data` (shaped by the item's own `--fields`, `--limit`, `--rows`) or `error`. `meta` carries `count`, `failed` and `each: true` beside the usual `governance` and `credentials`. Exit 0 when every item is ok, otherwise the first failing item's code. A failing item does not stop the ones after it; a blocked item does, and the entries behind it read `not run: item N was blocked` with exit 3. `~/.declick/audit.jsonl` gets one line for the batch carrying `each: {count, failed}`.

## Local policy (`policy.json`)

`$DECLICK_HOME/policy.json`, or the path in `DECLICK_POLICY`. One object with one field, `rules`, an array evaluated top to bottom. The first rule that matches decides; no file and no match both mean allow.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `adapter` | string glob | `*` | Adapter name: `*`, an exact name, or a glob like `pet*` |
| `verb` | string glob | `*` | Verb name, same glob rules (`delete-*`) |
| `mutating` | boolean | unset | When set, matches only verbs whose effective mutating flag equals it (the manifest's flag, raised by the engine's derivation, never lowered) |
| `decision` | `allow` \| `warn` \| `block` | required | What happens to a matching run |
| `reason` | string | unset | Shown to the agent in the error or the warning; a rule with no reason reads as `rule <index>` |

Any other field, a `rules` that is not an array, a decision outside the three, or JSON that does not parse is an invalid file, and invalid fails closed: every run exits 1 with `policy file <path> is invalid: <why>; fix it or unset DECLICK_POLICY`, and `declick policy` refuses in the same words.

Where it runs: mutating verbs inside the same gate DashClaw uses (`src/guard.mjs`), so the runtime, `declick ui` and the authoring replay are all covered; read-only verbs in `bin/run.mjs` before credentials are scoped and before a request is built. A policy `warn` prints to stderr and, when a key is set, still goes on to DashClaw. `--dry-run` skips the policy as it skips the guard. Under `--each` every item is evaluated on its own and a blocked item stops the batch.

A blocked run is exit 3, `ok:false`, `error: "blocked by policy: <reason>"`, and `meta.governance: { enabled, decision: "block", reason, source: "policy" }`. `source` is `"policy"` on any decision the local file made and absent otherwise: no `source` with `enabled: true` came from DashClaw, no `source` with `enabled: false` is `skipped`, `read-only verb` or `dry-run`. The audit line carries the same object.

Commands: `declick policy` (path, existence, one line per rule), `declick policy --check <adapter> <verb>` (the verb's mutating flag, the winning rule, the decision and reason), `declick policy --example` (an example file as data).

## Compose chain files

A chain file is JSON. `declick add compose:<file>` compiles it; a plain `.json` whose top-level object carries `"compose": true` routes to the compose engine on its own. `declick compose <name> --steps <file|->` is the same compile (`-` reads stdin and keeps a copy the adapter owns, so `declick build <name>` still works); `declick compose <name>` prints the chain step by step.

| Field | Required | Meaning |
|---|---|---|
| `compose` | for a bare `.json` source | `true` marks the file as a chain |
| `verbs` | yes | non-empty; each entry becomes one verb |
| `verbs[].name` / `description` | yes | kebab-case and unique; one line, 80 chars or fewer |
| `verbs[].args` | no | positional arguments in order, each `{name, description}`; `"required": false` renders as `[name]` |
| `verbs[].flags` | no | named flags, each `{name, description}`; none may collide with a contract flag |
| `verbs[].steps` | yes | non-empty, run in order |
| `verbs[].steps[].run` | yes | a command string split shell-style (quotes respected) or an argv array: adapter, verb, then arguments and flags |
| `verbs[].steps[].as` | no | the name later templates read this step's data by |
| `verbs[].steps[].optional` | no | `true` records a failure and continues with `as` unset |
| `verbs[].returns` | no | a step's `as`, or a template like `{owner.email}`; default the last step's data |

Templates: `{name}` matches `[A-Za-z_][A-Za-z0-9_-]*`, optionally dotted. A bare name is one of the verb's arguments or flags; a dotted name reads an earlier step through its `as`. `{my-pet}` and `{myPet}` are the same step, the rule declick already applies to flags. Only own properties are read, an object or array is JSON-stringified, and a literal `{"a":1}` passes through unchanged. There is no escape syntax.

Checked at compile: every step's adapter and verb exist in the real manifests (a missing one names what it looked for), every template names an argument, a flag or an earlier step, no `as` shadows one of those, and `returns` names something that exists. The composite's `mutating` is taken from the target manifests at compile time and recorded per step; `declick lint` derives the same value, so a hand-edited manifest may raise it and never lower it.

Run time: each step runs as `node bin/run.mjs <adapter> <verb> --json=true [--dry-run=true] ...` in a child process that inherits the environment, so `DECLICK_<NAME>_BASE_URL`, credentials, the adapter's `defaults.json`, governance and the audit log all apply to the step as they would to the same command typed by hand. `DECLICK_TIMEOUT_MS` bounds each step; `DECLICK_COMPOSE_DEPTH` is set by the engine and refuses a chain nested more than 8 deep. `returns.rowsPath` is left undefined; `--fields` and `--limit` apply to the composite's answer, never to a step, and a dry-run payload is never projected away.

## Web tree and text

`declick web tree <url>` and `declick web text <url>` open the url headless and answer without a screenshot.

- `--selector css` scopes either action to one element.
- `--grep re` is a case-insensitive regex. On `tree` it is tested against `role:name` and `href`; on `text` against each line. Zero matches exits 2 with `no element matches /re/ on <url>` or `no line matches /re/ on <url>`. An invalid regex exits 1.
- `--limit N` (default 50) caps the rows; `meta.count` and `meta.truncated` report the true match count when `--grep` narrowed a bigger page.

`declick web text` returns `{n, text}` rows, `n` being the 1-based line number in the full trimmed text, so an agent can quote where it found something after `--grep` filtered the list. Text mode prints `n<TAB>text` per line.

## Streamed responses

For an openapi verb whose response content-type is `text/event-stream`, `data` is an array of `{ event?, id?, data }` objects (SSE `data:` lines joined with `\n`, JSON payloads parsed, everything else a string) and the envelope carries `meta.stream: { events, complete, truncatedByTimeout, ms }`. When the `--timeout` or `DECLICK_TIMEOUT_MS` budget runs out before the stream ends, `complete` is false, `truncatedByTimeout` and the top-level `meta.truncated` are true, the events already received are returned, and the exit code stays 0. `--retry` never applies once a stream has started.

## Warm MCP servers (`daemon.json`)

`declick daemon start` spawns a detached process that keeps stdio MCP servers alive between runs, so only the first call pays the server's startup. HTTP MCP adapters have no process to keep and never use it.

| Command | Answer |
|---|---|
| `declick daemon start` | `{running, pid, endpoint, started, already}`. Idempotent: a daemon that is already up is returned with `already: true` |
| `declick daemon status` (or no action) | `{running, pid, started, endpoint, servers:[{adapter, pid, calls, idleMs}]}`; exit 2 with `running: false` when nothing is running |
| `declick daemon stop` | sends a shutdown and waits for the process to go; exit 2 when nothing is running |

`~/.declick/daemon.json` is `{pid, endpoint, token, started}`, written when the daemon starts listening and deleted when it stops. `endpoint` is `\\.\pipe\declick-<user>-<hash of DECLICK_HOME>` on Windows and `<DECLICK_HOME>/daemon.sock` elsewhere; the hash keeps two homes on one machine from sharing a daemon. On macOS and Linux both the socket and `daemon.json` are chmod 0600. On Windows a file mode is only the read-only bit, so what keeps the endpoint to one user there is the per-user pipe name plus the token, not the mode. A `daemon.json` whose `pid` is no longer alive is a crash, not a daemon, and every reader treats it as not running.

The protocol is newline-delimited JSON, one request per connection: `{token, op, adapter, verb, tool, args}` in, `{result}`, `{status}` or `{error}` out. Every message carries the token; a wrong one is answered `{"error":"unauthorized"}` and nothing else, and the token appears in no reply, log or `doctor` output. Servers are pooled by adapter name plus a hash of the command, its arguments and the adapter's auth key names, so a rebuild with a different command gets a new server. Calls that race a cold pool share the one server being started rather than starting one each. A server that crashes is dropped and respawned on the next call; a server idle for `DECLICK_DAEMON_IDLE_MS` (default 600000) is dropped, and a daemon with no servers for the same window exits.

A pooled server inherits the daemon's environment, taken at `daemon start`, not the environment of the run that reaches it. `DECLICK_TIMEOUT_MS` set for one run still bounds that run's wait on the socket.

On the run side, an mcp verb tries the daemon first with a 300 ms connect budget and falls back to spawning its own server when nothing answers; a run served by the daemon carries `meta.daemon: true`. A `--each` batch uses the daemon for every item, but its envelope is the batch's own `{count, failed, each}`, so `meta.daemon` is not reported per item. The daemon is a cache, not a policy boundary: flag checking, `defaults.json`, the local policy, the governance guard and the audit line all still run in `bin/run.mjs`, on the client side of the socket.

## Environment variables

| Variable | Effect |
|---|---|
| `DECLICK_HOME` | Adapter directory, default `~/.declick` |
| `DECLICK_SKILLS` | SKILL.md targets, comma separated. When set it replaces the detected list, nothing is appended |
| `OPENCLAW_SKILLS` | A second SKILL.md target, appended to the detected list |
| `DECLICK_DESK` | Path to the deskclaw launcher |
| `DECLICK_CLAUDE` | Authoring binary |
| `DECLICK_AUTHOR` | Test double for the authoring binary |
| `DECLICK_AUTHOR_TIMEOUT_MS` | Bounds an authoring session, default 300000 |
| `CREDS_VAULT` | Env file to read key names from, default `~/.creds/vault.env` |
| `DASHCLAW_API_KEY` | Turns the governance guard on |
| `DASHCLAW_URL` | Guard endpoint, required alongside the key, no default |
| `DASHCLAW_TIMEOUT_MS` | Guard call timeout, default 3000 |
| `DECLICK_GUARD` | `strict` (default once a key is set) or `open` |
| `DECLICK_AUDIT` | `off` disables `~/.declick/audit.jsonl` |
| `DECLICK_DEFAULTS` | `off` ignores every `~/.declick/<name>/defaults.json` |
| `DECLICK_POLICY` | path of the policy file, default `~/.declick/policy.json` |
| `DECLICK_ENV_ALLOW` | Comma-separated key names allowed to cross origins |
| `DECLICK_<NAME>_BASE_URL` | Per-adapter base URL override |
| `DECLICK_TIMEOUT_MS` | mcp and http client timeout default |
| `DECLICK_DAEMON_IDLE_MS` | how long a pooled MCP server, and then the daemon itself, may sit unused before exiting, default 600000 |
| `DECLICK_CDP` | Attach to a running Chrome or Edge instead of launching one |
| `CHROME` | Browser binary path for the web engine |
| `DECLICK_LIVE` | Opt in to the desktop and web tests that drive real windows and browsers |
| `DECLICK_NODE_VERSION` | Overrides the reported Node version, for testing the version gate |
| `DECLICK_CLIENT_HOME` | Directory the agent clients live under (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.agents`), default `os.homedir()`. Every path `declick setup` touches derives from it |
| `DECLICK_NUDGE_OFF` | `1` silences the Claude Code PreToolUse hook `declick setup` installs |
| `DECLICK_PATH_PROFILE` | Test-only. When set, the shell-profile branch of `path --install` and `declick setup` writes to this file instead of the real shell profile, and the Windows User-PATH branch is skipped |

## Setup snapshot

`declick setup` never writes to a client file before it has copied it. The snapshot lives at `~/.declick/setup/<ISO timestamp, `:` replaced by `-`>/`, and `~/.declick/setup/latest` names the current one. Inside:

- `files/<n>` — an exact byte copy of every file setup is about to modify, for every one that already existed.
- `manifest.json` — `{ version, at, clientHome, files:[{path, existed, before:sha256|null, after:sha256, copy:'files/<n>'|null}], adapters:[names built by this run], path:{kind:'win-user'|'profile'|null, file, line, added:bool} }`. `before`/`after` are the file's sha256 immediately before and after the run; `copy` is the path under `files/` holding the pre-write byte copy, or `null` when the file did not exist.
- `revert.mjs` — a standalone copy of the revert logic (node builtins only), which reads the sibling `manifest.json` and performs the same file restores and PATH undo as `declick setup --revert`, so `node ~/.declick/setup/<timestamp>/revert.mjs` works even after `npm rm -g declick`. It does not remove adapters; it prints the `declick remove <name>` lines instead.

`declick setup --revert` reads `~/.declick/setup/latest`, compares each file's current sha256 against the manifest's `after`: unchanged means restore the copy (or delete, if `existed` was false); changed means the file was edited since setup ran, so revert strips only the `<!-- declick:start -->` / `<!-- declick:end -->` block or the hook entry in `settings.json` and leaves the rest of the file alone.
