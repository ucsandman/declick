import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cmdQuote } from '../src/shared/windows-cmd-quote.mjs';

const WIN = process.platform === 'win32';

// Adversarial argument corpus, adapted from stablyai/orca's WINDOWS_ARGUMENT_CORPUS (MIT; see NOTICE.md).
// The %, & and " cases are the ones that shipped as bugs: an argument containing & was truncated AND its
// remainder executed as a command; a backslash right before a % or a " silently flipped cmd's quote parity.
const CORPUS = [
  { name: 'plain', value: 'hello' },
  { name: 'space', value: 'hello world' },
  { name: 'double-quote', value: 'say "hi" ok' },
  { name: 'quote-only', value: '"' },
  { name: 'ampersand', value: 'a&b' },
  { name: 'pipe', value: 'a|b' },
  { name: 'redirect', value: 'a<b>c' },
  { name: 'percent-pair', value: 'e%F%g' },
  // The shape that broke: a backslash immediately before a percent. Quoting inserts a quote there, and a
  // quote after a single backslash is an escaped quote to CommandLineToArgvW.
  { name: 'percent-after-backslash', value: 'C:\\Users\\%F%\\x' },
  { name: 'percent-after-two-backslashes', value: 'C:\\\\%F%' },
  { name: 'trailing-backslash', value: 'C:\\dir\\' },
  { name: 'backslash-quote', value: 'a\\"b' },
  { name: 'double-backslash-quote', value: 'a\\\\"b' },
  { name: 'only-backslashes', value: '\\\\\\' },
  { name: 'combined', value: 'x"y&z%F%' },
];

/**
 * Decode a command line the way CommandLineToArgvW does, so the encoder is checked against the parser it
 * targets rather than against itself. "" inside a quoted run yields a literal quote, which is the property
 * the cmd hop needs.
 */
function parseCommandLineToArgv(line) {
  const argv = [];
  let current = '', quoted = false, started = false, index = 0;
  while (index < line.length) {
    const char = line[index];
    if (!started && /\s/.test(char)) { index += 1; continue; }
    started = true;
    if (char === '\\') {
      let backslashes = 0;
      while (line[index] === '\\') { backslashes += 1; index += 1; }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) { current += '"'; index += 1; }
      } else current += '\\'.repeat(backslashes);
      continue;
    }
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 2; continue; }
      quoted = !quoted; index += 1; continue;
    }
    if (!quoted && /\s/.test(char)) { argv.push(current); current = ''; started = false; index += 1; continue; }
    current += char; index += 1;
  }
  if (started) argv.push(current);
  return argv;
}

// cmd.exe tracks quote state by counting ": an odd count on the line leaves it mid-quote, and every later
// operator character is then read as live cmd syntax instead of data.
const quoteParity = line => (line.match(/"/g) ?? []).length % 2;

// cmdQuote always escapes % as "^%" for the cmd.exe hop (all three call sites go through one): cmd.exe
// itself strips the ^ during its own line scan before the child ever starts, a step CommandLineToArgvW
// knows nothing about. Decoded through CommandLineToArgvW alone, a % therefore still reads back as ^%;
// this is what the model can prove, and the real-spawn tests below prove the ^ is gone by the time the
// child sees it.
const argvModelExpected = value => value.replace(/%/g, '^%');

for (const { name, value } of CORPUS) {
  test(`cmdQuote round-trips ${name} through CommandLineToArgvW`, () => {
    assert.deepEqual(parseCommandLineToArgv(cmdQuote(value)), [argvModelExpected(value)]);
  });
}
test(`cmdQuote keeps cmd.exe quote parity even for every corpus entry (scanned=${CORPUS.length})`, () => {
  for (const { name, value } of CORPUS) assert.equal(quoteParity(cmdQuote(value)), 0, `${name} leaves cmd mid-quote`);
});
test('the whole corpus round-trips as a single multi-argument line', () => {
  const values = CORPUS.map(c => c.value);
  const line = values.map(cmdQuote).join(' ');
  assert.deepEqual(parseCommandLineToArgv(line), values.map(argvModelExpected));
});

test('an embedded quote is written as "" (not \\"), the spelling that keeps cmd quote parity even', () => {
  assert.equal(cmdQuote('c"d'), '"c""d"');
});
test('a backslash immediately before an embedded quote is doubled, not left bare', () => {
  // Before the fix: cmdQuote('a\\"b') === '"a\\""b"' -- one backslash survives instead of two, which
  // CommandLineToArgvW reads as an escaped quote (odd count), corrupting everything after it.
  assert.equal(cmdQuote('a\\"b'), '"a\\\\""b"');
  assert.deepEqual(parseCommandLineToArgv(cmdQuote('a\\"b')), ['a\\"b']);
});
test('a trailing backslash run is doubled so the closing quote is not swallowed', () => {
  assert.equal(cmdQuote('C:\\dir\\'), '"C:\\dir\\\\"');
});
test('a percent is broken out of the quoted run so cmd.exe never sees a matched %VAR% pair', () => {
  const line = cmdQuote('e%F%g');
  assert.match(line, /"\^%"/);
  assert.doesNotMatch(line, /%F%/);
});
test('a backslash immediately before a percent is doubled before the quote break, not left bare', () => {
  const line = cmdQuote('C:\\Users\\%F%\\x');
  assert.match(line, /\\\\"\^%"/);
});

test('none of the three former copies re-declare cmdQuote locally; each imports the shared module', () => {
  for (const file of ['src/engines/cli.mjs', 'src/mcp-client.mjs', 'scripts/bench-tokens.mjs']) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /const cmdQuote\s*=/, `${file} must not re-declare cmdQuote`);
    assert.match(src, /import\s*\{\s*cmdQuote\s*\}\s*from\s*['"].*shared\/windows-cmd-quote\.mjs['"]/, `${file} must import cmdQuote from the shared module`);
  }
});

// The other half of the encoding proof: the model above is checked against a decoder written to spec, and
// this spawns a real .cmd shim on a real Windows box exactly the way declick's own call sites do, so a
// mismatch between the two parsers (CommandLineToArgvW vs. cmd.exe's own line scan) cannot hide. Runs only
// on win32; skipped elsewhere.
function decode(stdout) {
  return [...stdout.matchAll(/ARG<([\s\S]*?)>(?=\nARG<|$)/g)].map(m => m[1]);
}
function runViaCmdExe(shim, args, vflag = '/v:off') {
  // src/mcp-client.mjs's and scripts/bench-tokens.mjs's exact spawn shape (including /v:off; vflag is
  // overridable only so the delayed-expansion test below can force '/v:on' to prove /v:off is load-bearing).
  return new Promise(resolve => {
    const inner = [shim, ...args.map(cmdQuote)].join(' ');
    // F and VAR are live here on purpose: %F%/%VAR% must have something to expand to, or the percent
    // cases pass by accident against an undefined name (see the "^%" test above and NOTICE.md's source).
    const child = spawn('cmd.exe', ['/d', '/s', vflag, '/c', `"${inner}"`], { stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true, env: { ...process.env, F: 'EXPANDED_F', VAR: 'EXPANDED_VAR' } });
    let out = ''; child.stdout.on('data', d => out += d);
    child.on('close', code => resolve({ code, out }));
  });
}
function runViaShellTrue(shim, args) {
  // src/engines/cli.mjs's exact spawn shape: shell: true, args pre-quoted by cmdQuote.
  return new Promise(resolve => {
    // Same reason as runViaCmdExe: F and VAR must be live or the percent cases pass by accident.
    const child = spawn(shim, args.map(cmdQuote), { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, F: 'EXPANDED_F', VAR: 'EXPANDED_VAR' } });
    let out = ''; child.stdout.on('data', d => out += d);
    child.on('close', code => resolve({ code, out }));
  });
}

test('a real .cmd shim receives the whole corpus unchanged through both declick spawn shapes', { skip: !WIN && 'windows-only', timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-cmdquote-'));
  const shim = join(dir, 'echoargs.cmd');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n');
  writeFileSync(join(dir, 'echoargs.js'), 'process.stdout.write(process.argv.slice(2).map(a => `ARG<${a}>`).join("\\n"))\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const values = CORPUS.map(c => c.value);
  const viaCmd = await runViaCmdExe(shim, values);
  assert.equal(viaCmd.code, 0, viaCmd.out);
  assert.deepEqual(decode(viaCmd.out), values, `scanned=${values.length} arguments via cmd.exe /d /s /c`);

  const viaShell = await runViaShellTrue(shim, values);
  assert.equal(viaShell.code, 0, viaShell.out);
  assert.deepEqual(decode(viaShell.out), values, `scanned=${values.length} arguments via shell: true`);
});

test('an ampersand in an argument does not truncate it or execute the remainder as a command', { skip: !WIN && 'windows-only', timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-cmdquote-'));
  const shim = join(dir, 'echoargs.cmd');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n');
  writeFileSync(join(dir, 'echoargs.js'), 'process.stdout.write(process.argv.slice(2).map(a => `ARG<${a}>`).join("\\n"))\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const marker = join(dir, 'pwned.txt');
  const payload = `a& echo PWNED> "${marker}" &b`;
  const r = await runViaCmdExe(shim, [payload]);
  assert.deepEqual(decode(r.out), [payload]);
  assert.equal(existsSync(marker), false, 'the tail of the argument must never run as a command');
});

test('a %VAR% pair set in the environment is delivered literally, not expanded, through both spawn shapes', { skip: !WIN && 'windows-only', timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-cmdquote-'));
  const shim = join(dir, 'echoargs.cmd');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n');
  writeFileSync(join(dir, 'echoargs.js'), 'process.stdout.write(process.argv.slice(2).map(a => `ARG<${a}>`).join("\\n"))\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const value = 'C:\\Users\\%F%\\x';
  const viaCmd = await runViaCmdExe(shim, [value]);
  assert.deepEqual(decode(viaCmd.out), [value]);
  const viaShell = await runViaShellTrue(shim, [value]);
  assert.deepEqual(decode(viaShell.out), [value]);
});

// cmdQuote never guards '!': delayed expansion is off by default, so a bang pair only stays literal
// because mcp-client.mjs and bench-tokens.mjs both pin cmd.exe to /v:off. This proves that pin is load-
// bearing rather than an accident of this box's registry default, by forcing delayed expansion ON for
// one comparison spawn -- no registry write involved, /v:on is a per-invocation cmd.exe switch.
test('a !VAR! pair is delivered literally through cmd.exe /d /s /c because /v:off is pinned, not by luck', { skip: !WIN && 'windows-only', timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-cmdquote-'));
  const shim = join(dir, 'echoargs.cmd');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n');
  writeFileSync(join(dir, 'echoargs.js'), 'process.stdout.write(process.argv.slice(2).map(a => `ARG<${a}>`).join("\\n"))\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const value = 'q!VAR!r';
  const withOff = await runViaCmdExe(shim, [value]); // the real declick spawn shape (default vflag)
  assert.deepEqual(decode(withOff.out), [value], 'mcp-client.mjs/bench-tokens.mjs shape must not expand !VAR!');

  const withOn = await runViaCmdExe(shim, [value], '/v:on');
  assert.deepEqual(decode(withOn.out), ['qEXPANDED_VARr'], 'forcing delayed expansion on shows the pair DOES expand without /v:off -- the pin is load-bearing');
});
