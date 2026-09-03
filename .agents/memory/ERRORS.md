# Errors

## 2026-09-02

- Subagents wrote adapters into the real `~/.claude/skills` when `DECLICK_SKILLS` was set in a separate shell call instead of on the same command line as the `declick` invocation (fix: env prefix on the same command line, always; three leaked skill dirs deleted).
- Subagents left about 35 log files and scratch JSON in the repo root (fix: scratch dir rule, all deleted).
- The `.cmd` launcher test failed under Git Bash because `BASH_ENV` re-injected `DASHCLAW_API_KEY` into the child shell (fix in `test/launcher.test.mjs`).
- The `engines --source` sniffer kept a stale format table and reported postman collections as unreadable (fix: route detection through `pickEngine` instead of a second, drifted table).
- `doctor` returned `ok:false` with exit 0 when only warnings were present, contradicting its own exit code (fix: `ok:true` with `data.warnings` carrying the non-blocking issues).
- A query-string api key leaked into `--curl` output on live calls (fix: masked the same as header-based keys).
- The cli engine passed shell metacharacters to `cmd.exe` unquoted for `.cmd`/`.bat` tools (fix: quote every argument, not only ones containing a space).
- `add app:Calculator --name calc --recipes ...` refused on launcher shadowing but had already created `~/.declick/calc/recipes/`, and `remove calc` then reported no such adapter; the directory had to be deleted by hand (found 2026-09-03 while capturing site proof blocks; fix: the launcher and skill preflight now runs before the recipe import, and a fresh adapter directory is removed when compile or lint refuses).
