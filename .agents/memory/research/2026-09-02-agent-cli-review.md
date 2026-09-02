# declick review: usability and "agents do everything through the CLI"

Date: 2026-09-02. Method: 7 parallel finders (184 raw findings) over the whole repo, then hand verification of every high-impact claim by running commands against an isolated DECLICK_HOME. The adversarial-verify, design-panel and synthesis stages of the workflow were cut off by the session rate limit; every claim marked "verified" below was reproduced by hand on this machine (Windows 11, Node 24.15).

## Verdict

The runtime contract for generated adapters is mostly honored, but the management CLI (declick itself) honors none of it: no --json, no envelope, no exit-code discipline, and about a dozen things an agent needs are reachable only through the ui page, the filesystem, or a human. The flagship README install command produces an adapter whose every verb fails (relative server URL). The flag parser silently mishandles the four most common spellings an agent will emit. The ui server accepts cross-site POSTs.

## 1. What an agent cannot do through the CLI today

| Capability | Reached today by | Add |
|---|---|---|
| Run a verb without ~/.declick/bin on PATH | git clone + node bin/run.mjs | `declick run <name> <verb> [args] [--flags]` |
| Get adapter list as JSON | scrape TSV | `declick list --json` (envelope) |
| Get describe as JSON | read manifest.json by hand | `declick describe <n> --json`, `<n> describe --json` |
| Read the compiled manifest (http method/path, recipe steps) | open ~/.declick/<n>/manifest.json | `declick manifest <n> [--verb v]` |
| Last run, last error, tree diff | GET /api/adapters on the ui server | `declick status [<n>] --json` (reuse adapterRows) |
| Rejected authoring proposals | stderr line, then the file | `declick proposals <n>`, `declick proposal accept <n> <verb>` |
| Which auth keys are missing, and where they are read from | make a real call, get exit 4 | `declick auth <n>` (loadEnv already computes found/missing) |
| Health: node, home, bin on PATH, deskclaw present/armed, claude on PATH, vault | nothing | `declick doctor --json` |
| Arm/check deskclaw | separate `desk` tool | `declick desk status`, `declick desk arm [min]` |
| Version | nothing (`--version` prints usage) | `declick version` / `--version` |
| Regenerate SKILL.md without refetching the spec | full rebuild | `declick skill <n>` |
| List/show installed recipes; import one file or stdin | filesystem | `declick recipes <n>`, `--recipes <file|->` |
| Remove one verb | delete recipe file + rebuild | `declick remove <n> <verb>` |
| Export/import an adapter | copy directories | `declick export <n>` / `declick import -` |
| Which engines are live | try one, get exit 4 | `declick engines` |
| Subset a large spec (>~60 verbs fails lint with no escape) | nothing | `declick add <spec> --verbs a,b` / `--tag t` |
| Force an engine for an ambiguous URL | nothing | `--engine openapi` |
| Learn about declick itself from a skill | README only | ship `skills/declick/SKILL.md`, write on first add |
| Add an adapter from the ui page | terminal | `/api/add` form |
| Machine-readable ui URL/port | stderr scrape | print `{ok,data:{url,port}}` on stdout |

## 2. Bugs and contract violations (verified unless marked)

High:
- src/engines/openapi.mjs:46 relative `servers[0].url` stored verbatim. Live petstore spec (the README install line) gives "Invalid URL" on every verb, including --dry-run. Lint says ok. Fix: `new URL(url, source)` when source is http(s); lint rejects non-absolute baseUrl.
- src/output.mjs:41-43 parseFlags: `--dry-run 7` eats the 7; `--dry-run=true` becomes key `dryRun=true` so the real mutation runs; `--dry-run false` is a truthy string so it dry-runs; `--limit` bare becomes 1; `--limit=5` ignored. Fix: split on first `=`, keep a boolean set {json, dryRun, full, help}, coerce true/false, validate limit as positive integer.
- src/output.mjs + openapi.mjs:61,66 hyphenated query/body names can never be passed: parser camelCases `--page-size`, engine looks up `page-size`. Silent success with the filter dropped. Fix: look up both spellings, or store the camel form at compile.
- src/engines/openapi.mjs:26 `$ref` parameters dropped; path goes out as `/b/%7Bid%7D` with ok:true on dry-run. Fix: 10-line local deref for parameters, requestBody and schema; fail if `{` remains in the path.
- src/manifest.mjs:8 SECRETISH regex is unanchored across the alternation: any 32+ char kebab string (e.g. `get-organization-membership-invitations`) fails the build as "possible secret". Fix: group and anchor, skip declick-generated fields.
- src/engines/openapi.mjs:77 oauth2/openIdConnect/cookie schemes demand the env key (exit 4) then never send it. Fix: Bearer branch for oauth2/oidc, cookie branch, or drop unsupported schemes from auth.env.
- src/skill.mjs:16 unquoted YAML frontmatter; a colon in the first verb summary makes the skill fail to load. Fix: JSON-quote the description, strip newlines.
- bin/declick.mjs:79 `remove` leaves ~/.declick/bin/<n>{,.cmd} and ~/.claude/skills/<n>/SKILL.md. Agents keep discovering a dead adapter. Fix: removeLauncher + removeSkill.
- src/engines/desktop-tree.mjs findByPath has no backtracking: `['Group:*','Button:Equals']` returns null when the first Group lacks Equals, and the author prompt teaches Claude to use `*`. Fix: recursive walk with backtracking.
- src/lint.mjs:11 describe > 2000 chars is a hard build failure with no subset flag. Fix: `--verbs`/`--tag` filter, and name it in the error.

Medium:
- bin/declick.mjs: `help` exits 1, `--help` exits 0, `--version` prints usage. Missing positional gives a raw TypeError (`source.startsWith`).
- src/engines/index.mjs:5 mcp/web stubs exit 4 (the auth code) and say "phase 4". Use exit 1 and "0.2".
- bin/run.mjs:31 guard block does `process.exit(3)` before emit: empty stdout on the one governance exit code; last-run.json not written.
- bin/run.mjs:17 guard fails open silently on non-2xx or non-JSON (verified: default endpoint with a bogus key printed nothing and proceeded); no fetch timeout; `warn` decisions never surfaced; fixed risk_score 40 with no target/method.
- bin/run.mjs:42 `process.exit()` after async stderr writes drops the "ungoverned mutating call" warning on Windows (verified: warning absent in case B). The finder's claim of exit 127 / libuv assertion did NOT reproduce here (0 of 6 runs); use `process.exitCode` regardless.
- src/output.mjs:28 error envelope drops `result.data`: the API error body and the desktop tree diff never reach stdout, contradicting README line 88.
- src/output.mjs:46 `--limit`/`--fields` are force-coerced even when the API has a query param of that name; shape() only paginates top-level arrays, so `{items:[...]}` responses ignore --limit and report count 1.
- src/launcher.mjs:14 PATH check splits on `[;:]`, shattering Windows paths at the drive colon, so "add to PATH once" prints forever (verified: printed with bin on PATH). POSIX launcher written without mode 0o755.
- src/engines/openapi.mjs:14 pickEngine accepts .yaml, loadSpec only JSON.parses. Reject with a convert hint or add a YAML front end.
- src/engines/openapi.mjs:36 missing operationId collides `${method} ${path}` names and the whole build fails on "duplicate verb".
- src/engines/openapi.mjs:26 path-level and op-level params merge without dedupe: `get-pet <petId> <petId>`.
- src/engines/openapi.mjs:89 204 with json content-type throws "Unexpected end of JSON input", reporting a successful DELETE as exit 1 (agents will retry the mutation).
- src/engines/openapi.mjs:45 relative spec path stored verbatim; `declick build` and the ui build button fail from any other cwd.
- src/recipes.mjs:26 `--recipes` copies any JSON unvalidated; validateRecipe exists but only runs on Claude output. Runtime dies with "steps is not iterable".
- src/engines/desktop.mjs:65 closed window (snapshot exit 2) reported as "element not found; run declick repair", which burns a Claude session re-authoring a fine recipe.
- src/engines/desktop.mjs:71 last-error.json never cleared, so the ui repair button and the red row stay forever after one transient miss.
- src/engines/desktop.mjs:44 unknown `{{var}}` substitutes '' silently, typing corrupted text into a real app with ok:true.
- src/author.mjs:35 parseRecipe requires exactly ```json fence; a bare ``` fence discards the whole 5-minute session with nothing kept. Timeout (ETIMEDOUT) is reported as "failed to start; set DECLICK_CLAUDE".
- src/author.mjs:100 arm-state failure at live replay throws without keepProposal; the recipe is lost. STOP at dry-run keeps it.
- src/author.mjs:106 vs desktop.mjs:31 mutating default is inverted (author persists `=== true`, compile reads `!== false`), and the prompt template literally shows `"mutating": false`, so model-authored click verbs default to ungoverned.
- lint reserves `dry-run` only among args; query/body flags named limit/fields/json/dry-run collide with contract flags and pass lint. A verb named `describe` is unreachable and passes lint.
- bin/run.mjs:38 last-run.json written even when loadManifest failed, creating stray dirs for typos.
- One corrupt manifest.json blinds `declick list` and crashes the ui process (unguarded map in adapterRows inside the request handler).
- SKILL.md examples are literal `<petId>` (shell redirect if pasted); the desktop SKILL.md tail says "4 auth needed (creds mint calc)" which is unreachable for desktop, and never mentions `desk arm`. describe never mentions `--full`, baseUrl or window.

## 3. Security

- src/ui.mjs: no Origin, Host, or Sec-Fetch-Site check on POST /api/<n>/{build,repair,remove} (verified: grep finds none). Any web page open while `declick ui` runs can remove adapters or fire `repair`, which spawns a Claude Code session that drives the desktop. DNS rebinding upgrades it to read. Fix: reject unless Host is 127.0.0.1:<port> and Origin equals own origin; require content-type application/json. Add the 403 test.
- src/engines/openapi.mjs:21 the env key name is derived from spec-controlled fields (info.title + scheme key) and sent to a spec-controlled host. An untrusted spec titled "anthropic" with an apiKey scheme reads ANTHROPIC_<X> from env or the vault and posts it to its own server. Fix: require --name for remote specs, scope keys to the adapter name, warn when baseUrl host differs from the spec host.
- src/skill.mjs writes untrusted spec text unescaped into ~/.claude/skills (frontmatter breakout = persistent prompt injection) and overwrites any existing skill of the same name with no marker check. Fix: sanitize, quote, refuse to clobber a file without the "Generated by declick" marker.
- src/manifest.mjs manifestDir(name) has no kebab check on the read path: `declick remove ../../x` deletes any directory holding a manifest.json; run.mjs mkdirs at arbitrary paths. Fix: kebab guard inside manifestDir and loadRecipe.
- src/launcher.mjs spec-chosen names can shadow git/node/npm/claude on PATH. Fix: refuse names that resolve on PATH, require --name for remote specs.
- src/author.mjs child inherits the whole env minus ANTHROPIC_API_KEY; live-window text is interpolated unfenced into the repair prompt; the authoring replay bypasses the guard entirely. Fix: env allowlist, untrusted-data fence, shared src/guard.mjs used by both run.mjs and author.mjs.
- bin/run.mjs:13 DASHCLAW_URL defaults to a personal Vercel host that receives the bearer token. Fix: no default; require DASHCLAW_URL when the key is set.
- last-error.json stores the full live accessible-name tree (account numbers, field text) and /api/adapters serves it. Store missing selectors only.

## 4. Recommended design (ship in this order)

Principle: one runtime (bin/run.mjs) and one management CLI (bin/declick.mjs) share parseFlags and emit, every command returns the same envelope and exit codes, and every ui button maps 1:1 to a command.

Command surface to add or change:

| Command | Purpose | Output |
|---|---|---|
| `declick run <n> <verb> [args] [--flags]` | invoke without PATH | adapter envelope, adapter exit code |
| `declick list [--json]` | inventory | `data:[{name,engine,source,verbs[],auth[],lastRun,lastError}]` |
| `declick describe <n> [--full] [--json]` and `<n> describe --json` | surface as data | `data:{name,engine,source,baseUrl|window,auth,verbs[{name,description,mutating,args,flags}]}` |
| `declick manifest <n> [--verb v]` | full compiled contract | manifest.json through emit, --fields works |
| `declick status [<n>]` | last run, last error + diff, proposals | adapterRows() |
| `declick doctor` | preconditions | `{node,home,bin,onPath,skills[],vault,desk:{path,exists,armed},claude,engines[]}`, exit 1 if any required check fails |
| `declick auth <n>` | key presence without side effects | `{vault,keys:[{name,present,source}]}`, exit 4 if missing |
| `declick proposals <n>`, `proposal accept <n> <verb>` | see and promote rejected recipes | list / rebuild |
| `declick recipes <n>`, `--recipes <dir|file|->` | inspect and import | list / validated import |
| `declick remove <n> [<verb>]` | full cleanup or one verb | removes manifest, launcher, skill (or one recipe + rebuild) |
| `declick skill <n>` | regenerate SKILL.md offline | paths written |
| `declick desk status|arm [min]` | deskclaw through declick | forwards to DESK() |
| `declick engines`, `declick version`, `declick help` (exit 0) | discovery | envelope |
| `declick add ... --verbs a,b --tag t --engine e` | subset and override | as today |
| `declick export <n>` / `import -` | move adapters | JSON bundle |
| `declick ui` | prints `{ok,data:{url,port}}` on stdout; POST /api/add | unchanged page + add form |

File-by-file, shipping order (estimated lines):
1. src/output.mjs (+25): `--k=v`, boolean set, true/false coercion, limit validation, error envelope keeps `data`, `--` terminator. Export `camel`.
2. bin/run.mjs (+15): guard result flows through emit; `process.exitCode`; skip last-run on load failure; describe --json; guard timeout 3s, check r.ok, print warn.
3. src/engines/openapi.mjs (+40): resolve server URL against source, local `$ref` deref, param dedupe, both flag spellings, oauth2/oidc/cookie branches, 204 handling, resolve() file sources, operationId collision suffix, body media type.
4. src/manifest.mjs (+10): grouped/anchored SECRETISH, kebab guard in manifestDir, atomic write, `manifestVersion: 1`.
5. bin/declick.mjs (+120): route every case through emit; add run, status, doctor, auth, manifest, proposals, recipes, skill, desk, engines, version, help; remove cleans launcher + skill; arg guards; `--verbs/--tag/--engine`.
6. src/skill.mjs (+20): quoted frontmatter, sanitized one-line values, marker check before overwrite, engine-aware tail, `declick run` fallback line, uppercase arg tokens, `--full` mention; ship `skills/declick/SKILL.md` and write it on first add.
7. src/describe.mjs (+8): base/window line, `--full` in common line, `describeJson()`.
8. src/ui.mjs (+25): Host + Origin + content-type check, try/catch in handler, envelope on /api/adapters, /api/add, reuse `declick status` data.
9. src/engines/desktop.mjs and desktop-tree.mjs (+30): closed-window message, clear last-error on success, undeclared `{{var}}` is exit 1, backtracking findByPath, validateRecipe on import.
10. src/author.mjs (+25): shared guard before live replay, keepProposal on BLOCKED, arm pre-flight, lenient fence + raw output kept, ETIMEDOUT message, `mutating !== false`, env allowlist, untrusted fence.
11. src/launcher.mjs (+5): path.delimiter, mode 0o755, remove function, name-shadow refusal.
12. src/lint.mjs (+10): reserved verb `describe`, reserved flags, absolute baseUrl, `{` in path, recipe returns/ids.

## 5. Docs and tests in the same change

- README: fix `calc` vs `calculator` at line 45; exit-4 vs 3 wording at line 64; narrow the "lint enforces all of it" claim or make it true; document the error envelope, `--k=v`, flag ordering, Node 24, DASHCLAW_URL, OPENCLAW_SKILLS, DECLICK_AUTHOR, --recipes, the manifest schema, and every new command. site/llms.txt gets a Commands section. site/og.html gets noindex.
- Tests: contract table test spawning bin/run.mjs (`--limit=10`, `--limit abc`, `--dry-run 7`, `--dry-run=true` must dry-run, `describe --json`, blocked guard via local server yields exit 3 with JSON on stdout, 401 guard prints a warning, hung guard times out); fixture with `servers:[{url:"/api/v3"}]`; `$ref` param fixture; hyphen query fixture; ui 403 on foreign Origin/Host; manifestDir traversal; mid-string secret and 32-char kebab name; remove deletes all three artifacts; runtime bare `<name>` describe; findByPath backtracking. Drop `--dry-run` from the governance test so it observes the warning.

## 6. Left out, with reasons

- mcp and web engines: on the roadmap as 0.2; only the exit code and message change now.
- YAML parsing: zero-dep policy; reject with a convert hint instead.
- MCP server for declick itself: cheaper to ship the declick SKILL.md plus `--json` everywhere; revisit after.
- Response-path `--limit` for `{items:[...]}` envelopes: needs schema-driven rows path; document the limitation now.
- The libuv exit-127 claim: not reproduced on this machine; `process.exitCode` fixes the related lost-stderr bug anyway.
