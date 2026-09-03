import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This suite measures real Windows argument-passing through the generated shims (a batch file needs
// cmd.exe as its interpreter; there is no way to exercise that mechanism except by actually going
// through cmd.exe). It is meaningless off Windows, where the shims themselves are never generated for.
const WIN = process.platform === 'win32';
const BASH = [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files\Git\usr\bin\bash.exe`].find(existsSync);

const home = mkdtempSync(join(tmpdir(), 'declick-launcher-'));
const skills = mkdtempSync(join(tmpdir(), 'declick-launcher-skills-'));
// BASH_ENV/ENV are cleared too: a non-interactive bash sources whatever they point at before the shim runs,
// and a developer machine that loads its secrets that way would put DASHCLAW_API_KEY back after this override.
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk'), BASH_ENV: '', ENV: '' };
const declick = args => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env, encoding: 'utf8' });

if (WIN) {
  const add = declick(['add', 'fixtures/petstore.json', '--name', 'petstore']);
  assert.equal(add.status, 0, add.stderr); // fixture setup, not itself the test
  var cmdShim = join(home, 'bin', 'petstore.cmd'), bashShim = join(home, 'bin', 'petstore');
  assert.ok(existsSync(cmdShim) && existsSync(bashShim), 'writeLauncher must have produced both shims');
}

// canonical: what `declick run petstore <verb> <args...>` itself prints -- bin/declick.mjs's run case
// spawns bin/run.mjs with stdio: 'inherit', so this is byte-for-byte the runtime's own output.
const declickRun = args => declick(['run', 'petstore', ...args]);
// argv array, not a hand-joined string: Node applies its own correct per-argument Windows quoting when
// spawning a plain .exe (cmd.exe) from an array, which is what any real caller (an agent's shell tool,
// or a human at a prompt) effectively gets. A hand-joined single string gets re-quoted by Node because
// it contains spaces, corrupting already-quoted args -- that is a bug in the *caller*, not the shim.
const viaCmdShim = args => spawnSync('cmd.exe', ['/c', cmdShim, ...args], { env, encoding: 'utf8' });
const viaBashShim = args => spawnSync(BASH, [bashShim, ...args], { env, encoding: 'utf8' });

// find-pets-by-status --status <value> carries the tricky value through a plain string query flag, not
// a typed positional (petId is declared `integer` and a concurrent engine change now rejects a
// non-numeric petId before it ever reaches the URL -- unrelated to what this suite measures).
const withStatus = val => ['find-pets-by-status', '--status', val, '--dry-run'];

test('a space inside an argument reaches node byte-identical through both shims', { skip: !WIN && 'windows-only' }, () => {
  const args = withStatus('a b');
  const want = declickRun(args);
  assert.equal(viaCmdShim(args).stdout, want.stdout);
  assert.equal(viaBashShim(args).stdout, want.stdout);
});

test('a literal % that is not an environment-variable reference reaches node byte-identical through both shims', { skip: !WIN && 'windows-only' }, () => {
  for (const val of ['50%off', '%', '100%', '%%', 'end%', '%1', '% %']) {
    const args = withStatus(val);
    const want = declickRun(args);
    assert.equal(viaCmdShim(args).stdout, want.stdout, `cmd shim, arg ${JSON.stringify(val)}`);
    assert.equal(viaBashShim(args).stdout, want.stdout, `bash shim, arg ${JSON.stringify(val)}`);
  }
});

test('an unknown verb produces the same error envelope and exit code through both shims', { skip: !WIN && 'windows-only' }, () => {
  const args = ['nope-verb', '--dry-run'];
  const want = declickRun(args);
  assert.equal(want.status, 2, want.stdout);
  const c = viaCmdShim(args), b = viaBashShim(args);
  assert.equal(c.status, 2); assert.equal(c.stdout, want.stdout);
  assert.equal(b.status, 2); assert.equal(b.stdout, want.stdout);
});

// The one input class that is genuinely impossible to preserve: cmd.exe expands any %VAR% that matches
// a real environment variable while it parses ITS OWN command line -- before the .cmd file even starts,
// and for ANY command run under it, batch file or not. No shim content can intercept that. Prove the
// root cause is cmd.exe itself (not declick's shim) by showing a bare `cmd /c echo` on the same text
// is mangled identically, then document the shim's actual, narrower behavior: PATH does get substituted
// (the naive "always byte-identical" claim is false and would fail here), while the bash shim -- which
// never goes through cmd.exe -- stays byte-exact.
test('cmd.exe pre-expands a defined %VAR% on the caller line -- a documented, unavoidable limitation; the bash shim is unaffected', { skip: !WIN && 'windows-only' }, () => {
  const args = withStatus('a%PATH%b');
  const want = declickRun(args);
  const viaShim = viaCmdShim(args);
  // RED evidence: a naive "shim must always match declick run" assertion fails here.
  assert.notEqual(viaShim.stdout, want.stdout, 'this argument class is expected to diverge -- if it stops diverging, cmd.exe changed, not declick');
  assert.match(viaShim.stdout, /C%3A%5C/, 'a drive letter from PATH (URL-encoded "C:\\") was substituted into the URL, proving expansion happened');
  // same corruption from bare cmd.exe with zero batch file involved -- proves it is not the shim's doing.
  const bareEcho = spawnSync('cmd.exe', ['/c', 'echo', 'a%PATH%b'], { env, encoding: 'utf8' });
  assert.notEqual(bareEcho.stdout.trim(), 'a%PATH%b', 'cmd.exe itself, with no batch file at all, already expands %PATH%');
  // the bash shim never goes through cmd.exe, so it stays byte-exact for this same input.
  assert.equal(viaBashShim(args).stdout, want.stdout);
});

test('writeLauncher documents the cmd.exe %VAR% pre-expansion limitation in a comment', () => {
  const src = readFileSync('src/launcher.mjs', 'utf8');
  assert.match(src, /cmd\.exe expands/i);
  assert.match(src, /%VAR%/);
});

// Node's own fs.statSync on Windows never reflects a requested POSIX mode (NTFS has no such bit), so
// that is not a real check; Git Bash's MSYS layer tracks it independently and is what actually decides
// whether `./petstore` runs without an explicit `bash petstore`, so ask it, not Node.
test('the bash shim keeps mode 0o755 (checked through Git Bash, the tool that actually reads it)', { skip: !WIN && 'windows-only' }, () => {
  const r = spawnSync(BASH, ['-c', `stat -c '%a' "${bashShim}"`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '755', r.stderr);
});
