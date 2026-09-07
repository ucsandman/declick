# Errors

What broke, why, and what fixed it. One entry per incident, newest first.

## 2026-09-07 — a second `web` launch in one process died with `browser exited 21`

**Symptom.** CI (Windows) failed `snapshot --grep` and `pageText --grep` in `test/web.test.mjs`: `chrome.exe did not start: browser exited 21 ... Lock file can not be created ... Failed to create a ProcessSingleton`. The same tests passed locally most of the time, so it read as a CI flake.

**Root cause.** `launch()` in `src/cdp.mjs` retried across two profile directories, `~/.declick/.web-profile` and `.web-profile-<pid>`. Both are constant inside one process. Chrome holds the `ProcessSingleton` lock on a profile for a moment after it is killed, so the first launch in a test file could already have fallen back to `.web-profile-<pid>`; the next launch then found both directories locked and had nowhere left to go.

**Fix.** Every retry now gets its own `mkdtemp` profile under the OS temp dir, removed when that browser exits or the attempt fails. The base profile is still tried first, so the common single-run case keeps its warm cache.

**Lesson.** A fallback that resolves to the same path every time is not a fallback. Retry paths that exist to escape a lock must be unique per attempt, not per process.
