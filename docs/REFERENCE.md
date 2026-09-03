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
| `DECLICK_ENV_ALLOW` | Comma-separated key names allowed to cross origins |
| `DECLICK_<NAME>_BASE_URL` | Per-adapter base URL override |
| `DECLICK_TIMEOUT_MS` | mcp and http client timeout default |
| `DECLICK_CDP` | Attach to a running Chrome or Edge instead of launching one |
| `CHROME` | Browser binary path for the web engine |
| `DECLICK_LIVE` | Opt in to the desktop and web tests that drive real windows and browsers |
| `DECLICK_NODE_VERSION` | Overrides the reported Node version, for testing the version gate |
