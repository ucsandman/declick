# Errors

What broke, why, and what fixed it. One entry per incident, newest first.

## 2026-09-07 — the release gate failed on Openverse handing CI an empty result set

**Symptom.** `npm run qa` in the publish workflow failed `openverse search returns rows` with `no field matched title; available: ` and blocked the 0.7.2 publish. It failed identically on a re-run.

**Root cause.** Not declick. The same call, on the same commit, returned rows from a Windows workstation and from a Linux datacenter host on Node 24, so the empty `available:` list was Openverse answering the GitHub Actions runner with HTTP 200 and `results: []`. `--fields title` then had nothing to project and exited 1.

**Fix.** The check probes the call unprojected first. Rows present, it asserts the projection as before; no rows, it prints `skip` with the count the service returned and the raw envelope head, and the gate does not fail. The plain `--fields` contract stays covered by the weather and github checks.

**Lesson.** A release gate that asserts against a live third party must separate "our projection is wrong" from "the service gave this host nothing." Prove which one before touching the code: run the same call from a second host.

## 2026-09-07 — a second `web` launch in one process died with `browser exited 21`

**Symptom.** CI (Windows) failed `snapshot --grep` and `pageText --grep` in `test/web.test.mjs`: `chrome.exe did not start: browser exited 21 ... Lock file can not be created ... Failed to create a ProcessSingleton`. The same tests passed locally most of the time, so it read as a CI flake.

**Root cause.** `launch()` in `src/cdp.mjs` retried across two profile directories, `~/.declick/.web-profile` and `.web-profile-<pid>`. Both are constant inside one process. Chrome holds the `ProcessSingleton` lock on a profile for a moment after it is killed, so the first launch in a test file could already have fallen back to `.web-profile-<pid>`; the next launch then found both directories locked and had nowhere left to go.

**Fix.** Every retry now gets its own `mkdtemp` profile under the OS temp dir, removed when that browser exits or the attempt fails. The base profile is still tried first, so the common single-run case keeps its warm cache.

**Lesson.** A fallback that resolves to the same path every time is not a fallback. Retry paths that exist to escape a lock must be unique per attempt, not per process.
