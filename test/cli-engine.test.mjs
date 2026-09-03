import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { compile, execute, parseCommands, parseOptions, parseUsage } = await import('../src/engines/cli.mjs');
const { validateManifest } = await import('../src/manifest.mjs');

const TOOL = join(process.cwd(), 'fixtures', 'fake-tool.mjs');
const SOURCE = `cli:node ${TOOL}`;
const helpFixture = n => readFileSync(join(process.cwd(), 'fixtures', `help-${n}.txt`), 'utf8');
const verb = (m, n) => m.verbs.filter(v => v.name === n)[0];
const flag = (v, n) => v.cli.flags.filter(f => f.name === n)[0];
const m = await compile(SOURCE);

test('compile names the adapter after the binary and finds every subcommand', () => {
  assert.equal(m.name, 'fake-tool');
  assert.equal(m.engine, 'cli');
  assert.deepEqual(m.verbs.map(v => v.name), ['list', 'get', 'create', 'delete']);
  assert.equal(verb(m, 'list').description, 'List widgets, newest first');
  assert.deepEqual(m.auth, { env: [] });
});
test('mutating comes from the verb name', () => {
  assert.deepEqual(m.verbs.map(v => v.mutating), [false, false, true, true]);
});
test('positionals come from the Usage line', () => {
  assert.deepEqual(verb(m, 'get').args, [{ name: 'id', required: true, type: 'string' }]);
  assert.deepEqual(verb(m, 'list').args, [{ name: 'prefix', required: false, type: 'string' }]);
  assert.deepEqual(verb(m, 'create').args, []);
});
test('options keep their short alias, value-ness and default', () => {
  const create = verb(m, 'create');
  assert.deepEqual(create.flags.map(f => f.name), ['name', 'tags', 'param-json']);
  assert.deepEqual(flag(create, 'name'), { name: 'name', short: 'n', takesValue: true });
  assert.equal(flag(create, 'tags').takesValue, true);
  assert.equal(create.flags.filter(f => f.name === 'tags')[0].example, 'none');
  assert.equal(create.flags.filter(f => f.name === 'name')[0].description, 'Name for the new widget');
  assert.deepEqual(flag(verb(m, 'delete'), 'force'), { name: 'force', short: 'f', takesValue: false });
});
test('an option named like a contract flag is renamed and keeps its wire name', () => {
  assert.deepEqual(flag(verb(m, 'list'), 'param-json'), { name: 'param-json', short: 'j', takesValue: false, wire: 'json' });
  assert.equal(verb(m, 'list').flags.some(f => f.name === 'json'), false);
});
test('the manifest passes validation apart from the engine registration', () => {
  assert.deepEqual(validateManifest(m).filter(e => !e.startsWith('engine must be')), []);
});
test('--verbs subsets the commands', async () => {
  const few = await compile(SOURCE, { verbs: 'get,delete' });
  assert.deepEqual(few.verbs.map(v => v.name), ['get', 'delete']);
  await assert.rejects(() => compile(SOURCE, { verbs: 'nope' }), /no command matches nope; available: list, get, create, delete/);
});
test('a tool with no Commands block gets one run verb', async () => {
  process.env.FAKE_TOOL_BARE = '1';
  const bare = await compile(SOURCE, { name: 'bare-tool' });
  assert.deepEqual(bare.verbs.map(v => v.name), ['run']);
  assert.equal(bare.verbs[0].description, 'Print every widget as one line.');
  assert.equal(bare.verbs[0].mutating, true);
  assert.deepEqual(bare.verbs[0].args, [{ name: 'prefix', required: false, type: 'string' }]);
  assert.deepEqual(bare.verbs[0].flags.map(f => f.name), ['param-json', 'tag']);
  const r = await execute(bare, 'run', [], { paramJson: true });
  delete process.env.FAKE_TOOL_BARE;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.length, 2);
});
test('help falls back to -h when --help prints nothing', async () => {
  process.env.FAKE_TOOL_NOHELP = '1';
  const fell = await compile(SOURCE);
  delete process.env.FAKE_TOOL_NOHELP;
  assert.deepEqual(fell.verbs.map(v => v.name), ['list', 'get', 'create', 'delete']);
});

test('dry-run returns the argv it would spawn', async () => {
  const r = await execute(m, 'create', [], { dryRun: true, name: 'Rex' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.argv.slice(-3), ['create', '--name', 'Rex']);
  assert.equal(r.data.argv[1], TOOL);
});
test('dry-run passes extra positionals straight through', async () => {
  const r = await execute(m, 'list', ['al', 'extra'], { dryRun: true });
  assert.deepEqual(r.data.argv.slice(-3), ['list', 'al', 'extra']);
});
test('json stdout comes back parsed', async () => {
  const r = await execute(m, 'list', [], { paramJson: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.map(w => w.name), ['gamma', 'alpha']);
});
test('a positional narrows the real run', async () => {
  const r = await execute(m, 'list', ['al'], { paramJson: true });
  assert.deepEqual(r.data, [{ id: 1, name: 'alpha', tags: ['a'] }]);
});
test('a flag with a value is passed to the tool', async () => {
  const r = await execute(m, 'list', [], { paramJson: true, tag: 'c' });
  assert.deepEqual(r.data.map(w => w.id), [7]);
});
test('get 7 returns the widget', async () => {
  const r = await execute(m, 'get', ['7'], { paramJson: true });
  assert.deepEqual(r.data, { id: 7, name: 'gamma', tags: ['b', 'c'] });
});
test('text stdout comes back as lines with the exit code', async () => {
  const r = await execute(m, 'list', [], {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.stdout, ['7  gamma  b,c', '1  alpha  a']);
  assert.equal(r.data.code, 0);
});
test('a mutating verb runs with its boolean flag', async () => {
  const r = await execute(m, 'create', [], { paramJson: true, name: 'Rex', tags: 'a,b' });
  assert.deepEqual(r.data, { id: 9, name: 'Rex', tags: ['a', 'b'] });
  const d = await execute(m, 'delete', ['7'], { force: true, paramJson: true });
  assert.deepEqual(d.data, { deleted: 7 });
});
test('unknown id maps to exit 2 and keeps the streams', async () => {
  const r = await execute(m, 'get', ['99'], { paramJson: true });
  assert.equal(r.ok, false);
  assert.equal(r.exit, 2);
  assert.equal(r.error, 'widget 99 not found');
  assert.equal(r.data.code, 2);
});
test('a tool that refuses is exit 1', async () => {
  const r = await execute(m, 'delete', ['7'], {});
  assert.equal(r.exit, 1);
  assert.match(r.error, /refusing to delete 7 without --force/);
});
test('an unknown flag is rejected before spawning', async () => {
  const r = await execute(m, 'get', ['7'], { nope: 'x' });
  assert.equal(r.exit, 1);
  assert.match(r.error, /unknown flag --nope for get; run: fake-tool describe --full/);
});
test('a value flag with no value is an error', async () => {
  const r = await execute(m, 'create', [], { name: true });
  assert.equal(r.exit, 1);
  assert.match(r.error, /--name needs a value/);
});
test('a missing positional names the args', async () => {
  const r = await execute(m, 'get', [], {});
  assert.equal(r.exit, 1);
  assert.match(r.error, /get needs <id>/);
});
test('an unknown verb is not found', async () => {
  const r = await execute(m, 'nope', [], {});
  assert.equal(r.exit, 2);
  assert.match(r.error, /run: declick describe fake-tool/);
});
test('contract flags are never passed to the tool', async () => {
  const r = await execute(m, 'list', [], { dryRun: true, json: true, fields: ['id'], limit: 5, rows: 'x', full: true });
  assert.deepEqual(r.data.argv.slice(-1), ['list']);
});

test('git help parses into commands', () => {
  const cmds = parseCommands(helpFixture('git'));
  const names = cmds.map(c => c.name);
  assert.ok(names.length >= 20, `expected 20+ git commands, got ${names.length}`);
  for (const n of ['clone', 'init', 'add', 'commit', 'status', 'push', 'rebase']) assert.ok(names.includes(n), `git help is missing ${n}`);
  assert.match(cmds.filter(c => c.name === 'clone')[0].summary, /^Clone a repository/);
  assert.equal(names.some(n => /\s|:/.test(n)), false);
});
test('gh help parses commands out of every COMMANDS section and skips help topics', () => {
  const names = parseCommands(helpFixture('gh')).map(c => c.name);
  assert.ok(names.length >= 25, `expected 25+ gh commands, got ${names.length}`);
  for (const n of ['auth', 'pr', 'issue', 'repo', 'run', 'workflow', 'api']) assert.ok(names.includes(n), `gh help is missing ${n}`);
  for (const n of ['exit-codes', 'accessibility', 'mintty']) assert.equal(names.includes(n), false, `${n} is a help topic, not a command`);
  assert.equal(parseCommands(helpFixture('gh')).filter(c => c.name === 'pr')[0].summary, 'Manage pull requests');
});
test('the npm comma list parses into commands', () => {
  const names = parseCommands(helpFixture('npm')).map(c => c.name);
  assert.ok(names.length >= 50, `expected 50+ npm commands, got ${names.length}`);
  for (const n of ['install', 'publish', 'dist-tag', 'whoami']) assert.ok(names.includes(n), `npm help is missing ${n}`);
});
test('real flag lines parse with shorts, values and defaults', () => {
  const opts = parseOptions(helpFixture('gh-pr-create'));
  const by = n => opts.filter(o => o.long === n)[0];
  assert.ok(opts.length >= 15, `expected 15+ gh pr create flags, got ${opts.length}`);
  assert.deepEqual({ ...by('title') }, { long: 'title', short: 't', takesValue: true, joined: false, description: 'Title for the pull request', def: null });
  assert.equal(by('web').takesValue, false);
  assert.equal(by('fill').takesValue, false);
  assert.equal(by('no-maintainer-edit').takesValue, false);
  assert.equal(by('head').def, '[current branch]');
  assert.equal(by('body-file').short, 'F');
});
test('git-style [no-] flags and wrapped descriptions parse', () => {
  const opts = parseOptions(helpFixture('git-status'));
  const by = n => opts.filter(o => o.long === n)[0];
  assert.deepEqual({ ...by('short') }, { long: 'short', short: 's', takesValue: false, joined: false, description: 'show status concisely', def: null });
  assert.equal(by('porcelain').takesValue, true);
  assert.equal(by('porcelain').description, 'machine-readable output');
  assert.equal(by('untracked-files').takesValue, true);
});
test('a flag whose help attaches its value with = is passed joined', async () => {
  assert.equal(parseOptions(helpFixture('git-status')).filter(o => o.long === 'porcelain')[0].joined, true);
  assert.equal(parseOptions(helpFixture('gh-pr-create')).filter(o => o.long === 'title')[0].joined, false);
  const hand = {
    name: 'joiner', engine: 'cli',
    verbs: [{ name: 'go', description: 'go', mutating: false, args: [], flags: [{ name: 'mode', description: '', required: false, type: 'string' }], cli: { argv: ['node', TOOL], flags: [{ name: 'mode', short: null, takesValue: true, joined: true }], passthrough: true } }],
  };
  const r = await execute(hand, 'go', [], { dryRun: true, mode: 'v1' });
  assert.deepEqual(r.data.argv.slice(-1), ['--mode=v1']);
});
test('flags spelled out in a usage line are not positionals', () => {
  assert.deepEqual(parseUsage(helpFixture('git-commit'), 'commit'), []);
  assert.deepEqual(parseUsage(helpFixture('git-status'), 'status'), [{ name: 'pathspec', required: false }]);
  assert.deepEqual(parseUsage('usage: git log [<options>] [<revision-range>] [[--] <path>...]\n', 'log'),
    [{ name: 'revision-range', required: false }, { name: 'path', required: false }]);
});
test('a usage line with only generic tokens has no positionals', () => {
  assert.deepEqual(parseUsage('USAGE\n  gh pr create [flags]\n', 'create'), []);
  assert.deepEqual(parseUsage('Usage: tool cp <src> [dest] [options]\n', 'cp'), [{ name: 'src', required: true }, { name: 'dest', required: false }]);
});

// node spawns a .cmd through cmd.exe (shell: true), which splits on & | > < ^ outside quotes. Every real
// npm-installed Windows tool is a .cmd, and every flag value here comes from the caller's command line.
test('a shell metacharacter in a flag value reaches a .cmd tool as data, not as a second command', async t => {
  if (process.platform !== 'win32') return t.skip('cmd.exe only');
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'declick-inj-'));
  assert.ok(!/\s/.test(dir), `this test writes a cmd redirect target: ${dir} must have no space`);
  const tool = join(dir, 'echoargs.cmd');
  writeFileSync(tool, '@echo off\r\necho GOT: %*\r\n');
  const pwned = join(dir, 'pwned.txt');
  const inj = {
    name: 'echoer', engine: 'cli', source: `cli:${tool}`, builtAt: new Date().toISOString(), auth: { env: [] },
    verbs: [{ name: 'run-it', description: 'echo its argv', mutating: false, args: [], flags: [{ name: 'value', description: 'a value', required: false, type: 'string' }], cli: { argv: [tool], flags: [{ name: 'value', takesValue: true }] } }],
  };
  const r = await execute(inj, 'run-it', [], { value: `a&echo.>${pwned}` });
  assert.equal(r.ok, true, r.error);
  assert.equal(existsSync(pwned), false, `the injected command ran: ${JSON.stringify(r.data)}`);
  assert.match(String(r.data.stdout), /a&echo/, 'the tool still has to receive the literal value');
  const q = await execute(inj, 'run-it', [], { value: `b"&echo.>${pwned}` });
  assert.equal(existsSync(pwned), false, `a quote reopened the shell: ${JSON.stringify(q.data)}`);
});
