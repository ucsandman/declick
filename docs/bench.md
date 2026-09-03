# Token cost: raw MCP vs declick

Measured 2026-09-03 on Windows with `node scripts/bench-tokens.mjs`, one real run against every stdio `mcp`
adapter already compiled in `~/.declick`.

## Method

For each adapter whose manifest has `engine: "mcp"` and a stdio `command` (an `mcp` adapter that talks HTTP
instead, like `c7`, is skipped and named below — it never speaks the stdio JSON-RPC framing this measures), the
script spawns the real server once and counts two things in bytes: **raw** is `JSON.stringify` of the server's
`initialize` result plus its full (paginated) `tools/list` response — the payload a plain MCP client puts
straight into a model's context; **declick** is the stdout of `declick describe <adapter>` and of
`declick describe <adapter> --verb <first verb>`, run as separate processes against the adapter's already-compiled
manifest, with no live connection to the server. Tokens are never counted directly; they are approximated as
`bytes / 4`, marked `~Nt` in every cell. The ratio column is raw bytes divided by `declick describe` bytes.
Non-`mcp` engines (`openapi`, `cli`, `graphql`, `sqlite`) are out of scope for this script entirely, not counted
as skipped. This run did not pass `--call`, which would additionally invoke one real read-only, zero-argument
tool on each live server (network calls, and for `playwright-mcp` / `chrome-devtools`, a real browser launch);
it was verified once instead, against the local `fs` adapter only (`--adapter fs --call`, no network, no side
effects on the other servers): `list-allowed-directories` came back 160 raw bytes vs 191 for
`declick run fs list-allowed-directories --limit 5` — declick costs *more* per single call there, because it
wraps the tool's result in `{ok, data, meta, governance}`. `--call` measures a different thing than the table
below: declick's win is paying once for the tool surface, not shrinking every individual call.
Each server gets a 15s budget to spawn, connect and answer `tools/list` in full; a server that misses it is a
row with the error, not a crash (a first, uncached `npx` install can miss this budget once and then pass on a
second run, once the package is cached — that happened here for `agentcash-mcp` on the first pass).

## Results

| Adapter | Tools | Raw init+tools/list | `declick describe` | `declick describe --verb` | Ratio raw/describe |
|---|---:|---:|---:|---:|---:|
| agentcash-mcp | 12 | 22,420 (~5,605t) | 3,334 (~834t) | 1,111 (~278t) | 6.7x |
| chrome-devtools | 29 | 25,992 (~6,498t) | 6,290 (~1,573t) | 1,098 (~275t) | 4.1x |
| context7-mcp | 2 | 5,954 (~1,489t) | 1,300 (~325t) | 1,086 (~272t) | 4.6x |
| dashclaw-mcp | 19 | 22,030 (~5,508t) | 4,560 (~1,140t) | 1,183 (~296t) | 4.8x |
| fs | 14 | 13,128 (~3,282t) | 4,506 (~1,127t) | 1,299 (~325t) | 2.9x |
| offlocal | 124 | 94,525 (~23,631t) | 25,680 (~6,420t) | 1,216 (~304t) | 3.7x |
| playwright-mcp | 24 | 18,643 (~4,661t) | 4,757 (~1,189t) | 1,031 (~258t) | 3.9x |
| repowise-mcp | 9 | 18,329 (~4,582t) | 2,448 (~612t) | 1,114 (~279t) | 7.5x |
| xapi | 25 | 15,797 (~3,949t) | 5,434 (~1,359t) | 1,181 (~295t) | 2.9x |
| **TOTAL** | **258** | **236,818 (~59,205t)** | **58,309 (~14,577t)** | **10,319 (~2,580t)** | **4.1x** |

`scanned=10 measured=9 skipped=1 failed=0`

`c7` is `engine: "mcp"` over HTTP (Streamable HTTP, not stdio) and is skipped by design; it never faces the
stdio JSON-RPC framing this script measures. Non-`mcp` adapters present on this machine (`countries`, `crm`,
`ghcli`, `github`, `ov`, `wx`) are outside this script's scope and are not counted in `scanned`.
`agentcash-mcp`'s raw bytes are real, not a framing bug — its `initialize` result alone is ~7,000 bytes because
`serverInfo.description` carries a long, static usage guide for the model; verified by dumping that field
directly, and reproduced across two separate runs.

The `declick describe <adapter> --verb <verb>` column is the real, generalizing number: it holds to
1,031-1,299 bytes (~258-325 tokens) across servers with anywhere from 2 to 124 tools, because reading one
tool's full detail costs the same regardless of how many others exist. The whole-adapter `describe` column
(and the ratio against it) instead grows with the server's tool count, the same as `tools/list` does — declick
still wins there, but by a smaller and less constant margin.

## Reproduce

```
node scripts/bench-tokens.mjs [--adapter n,n2] [--limit N] [--json] [--call]
```
