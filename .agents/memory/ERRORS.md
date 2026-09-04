# Errors

## 2026-09-03

- A reviewer in the second fix-findings workflow ran `git stash` on the shared working tree to prove a test failed without its fix; the `git stash pop` conflicted on a sibling agent's edit to `src/skill.mjs`, git kept the stash, and the whole first fix pass (25 files) sat reverted under six concurrent agents. Reconciled by classifying each stashed file against HEAD and the stash, restoring sixteen from the stash and three-way merging four (fix: `git-tree-guard` hook denies stash/checkout/restore/reset/clean in Bash, the fix-findings workflow injects a shared-tree block into every prompt, and the REVERT-TO-RED dispatch block now says baselines come from copies).
- Pre-launch QA on the published 0.3.0 found real-world failures the suite never saw: large specs sniffed as web pages, lint refusing spec descriptions and any surface over 2000 chars, the YAML parser dropping zero-indent sequences and multi-line scalars, a Node 18/20 stack trace before the version check, `export` output that `import` refused, and the launcher collision guard refusing declick's own launchers after `path --install` (fix: the two fix-findings passes recorded in CHANGELOG 0.3.1; lesson: QA the published package on Linux and macOS with real public sources before every release, not only the suite on Windows).

## 2026-09-02

- Subagents wrote adapters into the real `~/.claude/skills` when `DECLICK_SKILLS` was set in a separate shell call instead of on the same command line as the `declick` invocation (fix: env prefix on the same command line, always; three leaked skill dirs deleted).
- Subagents left about 35 log files and scratch JSON in the repo root (fix: scratch dir rule, all deleted).
- The `.cmd` launcher test failed under Git Bash because `BASH_ENV` re-injected `DASHCLAW_API_KEY` into the child shell (fix in `test/launcher.test.mjs`).
- The `engines --source` sniffer kept a stale format table and reported postman collections as unreadable (fix: route detection through `pickEngine` instead of a second, drifted table).
- `doctor` returned `ok:false` with exit 0 when only warnings were present, contradicting its own exit code (fix: `ok:true` with `data.warnings` carrying the non-blocking issues).
- A query-string api key leaked into `--curl` output on live calls (fix: masked the same as header-based keys).
- The cli engine passed shell metacharacters to `cmd.exe` unquoted for `.cmd`/`.bat` tools (fix: quote every argument, not only ones containing a space).
- `add app:Calculator --name calc --recipes ...` refused on launcher shadowing but had already created `~/.declick/calc/recipes/`, and `remove calc` then reported no such adapter; the directory had to be deleted by hand (found 2026-09-03 while capturing site proof blocks; fix: the launcher and skill preflight now runs before the recipe import, and a fresh adapter directory is removed when compile or lint refuses).
- A review of Grok's critique proposed nearest-verb suggestions on the exit 2 envelope as new work; bin/run.mjs already did it and only the site never showed it (2026-09-04; lesson: grep the repo for a feature before proposing it from a review, the site is the surface that was actually stale).
- The 0.6.2 publish job failed its qa gate once because https://api.openverse.org/v1/schema/ answered the GitHub runner with an HTML body, so add refused it as a web page; the same URL served the spec locally and the rerun passed (2026-09-04; lesson: a qa FAIL naming a third-party spec URL gets one rerun before any code is touched).
