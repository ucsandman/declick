import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const runtime = (args, extra = {}) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin for tests that also run a server in this process: spawnSync would block the server's event loop.
const runtimeAsync = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };

test('add compiles, lints, writes launcher, skill and the declick self skill; piped output is the envelope', () => {
  const r = run(['add', 'fixtures/petstore.json', '--name', 'petstore']);
  assert.equal(r.status, 0, r.stderr);
  const j = J(r);
  assert.equal(j.ok, true); assert.equal(j.data.name, 'petstore'); assert.equal(j.data.engine, 'openapi'); assert.equal(j.meta.count, 1);
  assert.ok(existsSync(join(home, 'petstore', 'manifest.json')));
  assert.ok(existsSync(join(home, 'bin', 'petstore.cmd')));
  const skill = readFileSync(join(skills, 'petstore', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: petstore\ndescription: "/); assert.match(skill, /petstore describe/); assert.match(skill, /declick run petstore/);
  assert.match(skill, /petstore get-pet-by-id PETID/);
  assert.match(readFileSync(join(skills, 'declick', 'SKILL.md'), 'utf8'), /declick doctor/);
});
test('--json false gives the human text', () => {
  const r = run(['describe', 'petstore', '--json', 'false']);
  assert.match(r.stdout, /^petstore \(openapi\)/); assert.match(r.stdout, /find-pets-by-status/);
});
test('list and describe are data', () => {
  const l = J(run(['list']));
  assert.equal(l.data[0].name, 'petstore'); assert.ok(l.data[0].verbs.includes('get-pet-by-id')); assert.deepEqual(l.data[0].auth, ['PETSTORE_API_KEY']);
  const d = J(run(['describe', 'petstore', '--full']));
  assert.ok(d.data.verbs.find(v => v.name === 'add-pet').flags.some(f => f.name === 'status'));
  assert.deepEqual(J(run(['describe', 'petstore', '--verb', 'add-pet'])).data.verbs.map(v => v.name), ['add-pet']);
  assert.equal(J(run(['manifest', 'petstore', '--verb', 'delete-pet'])).data.verbs[0].http.method, 'delete');
});
test('errors are envelopes on stdout with the contract exit code', () => {
  const r = run(['describe', 'ghost']);
  assert.equal(r.status, 2); const j = J(r); assert.equal(j.ok, false); assert.match(j.error, /declick list/);
  assert.equal(run(['add']).status, 1); assert.match(J(run(['add'])).error, /usage: declick add/);
  assert.equal(run(['add', 'x.yaml']).status, 1); assert.match(J(run(['add', 'x.yaml'])).error, /YAML/);
  assert.equal(run(['add', 'mcp:foo', '--name', 'foo']).status, 1); assert.match(J(run(['add', 'mcp:foo', '--name', 'foo'])).error, /0\.2/);
  assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'Bad_Name']).status, 1); assert.match(J(run(['add', 'fixtures/petstore.json', '--name', 'Bad_Name'])).error, /--name bad-name/);
  assert.equal(run(['remove', '../escape']).status, 1);
});
test('help, version, engines, path, doctor', () => {
  assert.equal(run(['help']).status, 0); assert.equal(run([]).status, 0); assert.equal(run(['--help']).status, 0);
  assert.match(J(run(['version'])).data.version, /^\d+\.\d+\.\d+$/); assert.equal(run(['--version']).status, 0);
  assert.equal(run(['nope']).status, 1);
  assert.ok(J(run(['engines'])).data.some(e => e.name === 'openapi' && e.ready));
  const p = J(run(['path'])).data; assert.equal(p.bin, join(home, 'bin')); assert.equal(typeof p.onPath, 'boolean');
  const d = run(['doctor']); const dj = J(d);
  assert.equal(dj.data.node.ok, true); assert.equal(dj.data.home.adapters, 1); assert.equal(dj.data.bin.onPath, false); assert.match(dj.data.problems[0], /PATH/);
  assert.equal(dj.data.desk.exists, false); assert.equal(d.status, 0, 'PATH is a problem, not a failure');
});
test('run forwards to the runtime with the same output and exit code', () => {
  const r = run(['run', 'petstore', 'get-pet-by-id', '7', '--dry-run']);
  assert.equal(r.status, 0, r.stderr); const j = J(r);
  assert.equal(j.data.headers.api_key, '<PETSTORE_API_KEY>'); assert.equal(j.meta.dryRun, true);
  assert.equal(run(['run', 'petstore', 'nope']).status, 2);
});
test('runtime describe honors --json and --help on a verb', () => {
  assert.equal(J(runtime(['petstore'])).data.verbs.length, 4);
  assert.equal(J(runtime(['petstore', 'describe'])).data.name, 'petstore');
  assert.match(runtime(['petstore', 'describe', '--json', 'false']).stdout, /common: --json/);
  const h = J(runtime(['petstore', 'add-pet', '--help'])); assert.deepEqual(h.data.verbs.map(v => v.name), ['add-pet']); assert.ok(h.data.verbs[0].flags.length);
});
test('runtime rejects unknown flags instead of running the verb', () => {
  const r = runtime(['petstore', 'get-pet-by-id', '7', '--nope', '1']);
  assert.equal(r.status, 1); assert.match(J(r).error, /unknown flag --nope/);
});
test('runtime flag order does not matter and =value works', () => {
  assert.equal(J(runtime(['petstore', 'get-pet-by-id', '--dry-run', '7'])).data.url, 'https://petstore3.swagger.io/api/v3/pet/7');
  assert.equal(J(runtime(['petstore', 'delete-pet', '7', '--dry-run=true'])).meta.dryRun, true);
});
test('runtime unknown verb exits 2, missing auth exits 4 and names the vault', () => {
  const r = runtime(['petstore', 'get-pet-by-id', '7']);
  assert.equal(runtime(['petstore', 'nope']).status, 2);
  assert.equal(r.status, 4); assert.match(J(r).error, /PETSTORE_API_KEY/);
  const a = run(['auth', 'petstore']); assert.equal(a.status, 4); assert.deepEqual(J(a).data.missing, ['PETSTORE_API_KEY']);
  const ok = run(['auth', 'petstore'], { PETSTORE_API_KEY: 'k' }); assert.equal(ok.status, 0); assert.equal(J(ok).data.keys[0].source, 'env');
});
test('mutating without governance warns on stderr and still returns the contract exit code', () => {
  const r = runtime(['petstore', 'delete-pet', '7'], { PETSTORE_API_KEY: 'k' });
  assert.match(r.stderr, /ungoverned mutating call/);
  assert.ok([0, 1, 2, 4].includes(r.status), `exit ${r.status}`);
});
test('governance: block is a JSON envelope with exit 3, 401 warns, a hung guard times out, strict blocks', async () => {
  let mode = 'block';
  const srv = createServer((req, res) => {
    if (!req.url.startsWith('/api/guard')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"deleted":true}'); }
    if (mode === 'hang') return;
    if (mode === '401') { res.writeHead(401); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ decision: mode, reason: 'policy says no' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const spec = join(home, 'gov.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Gov' }, servers: [{ url: base }], paths: { '/pet/{id}': { delete: { operationId: 'deletePet', summary: 'Delete', parameters: [{ name: 'id', in: 'path', required: true }] } } } }));
  assert.equal(run(['add', spec, '--name', 'gov']).status, 0);
  const g = { DASHCLAW_API_KEY: 'key', DASHCLAW_URL: base, DASHCLAW_TIMEOUT_MS: '300' };
  const b = await runtimeAsync(['gov', 'delete-pet', '7'], g);
  assert.equal(b.status, 3, b.stdout + b.stderr); const bj = J(b); assert.equal(bj.ok, false); assert.equal(bj.exit, 3); assert.match(bj.error, /policy says no/);
  assert.equal(JSON.parse(readFileSync(join(home, 'gov', 'last-run.json'), 'utf8')).exit, 3);
  mode = '401';
  const u = await runtimeAsync(['gov', 'delete-pet', '7'], g); assert.match(u.stderr, /governance responded 401; proceeding ungoverned/); assert.equal(u.status, 0, u.stdout); assert.equal(J(u).data.deleted, true);
  mode = 'hang';
  const h = await runtimeAsync(['gov', 'delete-pet', '7'], g); assert.match(h.stderr, /governance unreachable \(timeout\)/); assert.equal(h.status, 0);
  const s = await runtimeAsync(['gov', 'delete-pet', '7'], { ...g, DECLICK_GUARD: 'strict' }); assert.equal(s.status, 3); assert.match(J(s).error, /strict/);
  mode = 'warn';
  const w = await runtimeAsync(['gov', 'delete-pet', '7'], g); assert.match(w.stderr, /governance: policy says no/); assert.equal(w.status, 0);
  srv.closeAllConnections(); await new Promise(r => srv.close(r));
});
test('list survives a corrupt manifest and reports it as one broken row', () => {
  mkdirSync(join(home, 'broken'), { recursive: true }); writeFileSync(join(home, 'broken', 'manifest.json'), '{');
  const j = J(run(['list'])); assert.ok(j.data.length >= 2); assert.ok(j.data.find(r => r.name === 'broken').error); assert.ok(j.data.find(r => r.name === 'petstore').verbs.length);
  assert.equal(run(['remove', 'broken']).status, 1);
  writeFileSync(join(home, 'broken', 'manifest.json'), JSON.stringify(JSON.parse(readFileSync(join(home, 'petstore', 'manifest.json'), 'utf8'))).replace('"petstore"', '"broken"'));
  assert.equal(run(['remove', 'broken']).status, 0);
});
test('skill regenerates offline and refuses to clobber a foreign skill', () => {
  const j = J(run(['skill', 'petstore'])); assert.ok(j.data.written.some(p => p.endsWith(join('petstore', 'SKILL.md'))));
  mkdirSync(join(skills, 'mine'), { recursive: true }); writeFileSync(join(skills, 'mine', 'SKILL.md'), 'hand written');
  const r = run(['add', 'fixtures/petstore.json', '--name', 'mine']);
  assert.equal(r.status, 1); assert.match(J(r).error, /not written by declick/);
  assert.equal(readFileSync(join(skills, 'mine', 'SKILL.md'), 'utf8'), 'hand written');
  assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'mine', '--force']).status, 0);
  assert.equal(run(['remove', 'mine']).status, 0);
});
test('a colon in the first summary still yields loadable frontmatter', () => {
  const spec = join(home, 'colon.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Colony' }, servers: [{ url: 'https://x.test' }], paths: { '/a': { get: { operationId: 'listThings', summary: 'List things: rows and cursors' } } } }));
  assert.equal(run(['add', spec, '--name', 'colony']).status, 0);
  const head = readFileSync(join(skills, 'colony', 'SKILL.md'), 'utf8').split('\n').slice(0, 4);
  assert.match(head[2], /^description: "Use when you need to list things: rows and cursors/);
  assert.equal(run(['remove', 'colony']).status, 0);
});
test('export then import rebuilds an adapter', () => {
  const e = run(['export', 'petstore']); assert.equal(e.status, 0);
  const bundle = J(e).data; assert.equal(bundle.manifest.name, 'petstore');
  bundle.manifest.name = 'petstore-copy';
  writeFileSync(join(home, 'bundle.json'), JSON.stringify(bundle));
  assert.equal(run(['import', join(home, 'bundle.json')]).status, 0);
  assert.ok(existsSync(join(home, 'petstore-copy', 'manifest.json')));
  assert.equal(run(['remove', 'petstore-copy']).status, 0);
});
test('status carries last run and last error', () => {
  const s = J(run(['status', 'gov'])).data;
  assert.equal(s.name, 'gov'); assert.equal(s.lastRun.verb, 'delete-pet'); assert.equal(s.lastRun.exit, 0);
  assert.equal(run(['remove', 'gov']).status, 0);
  assert.equal(run(['status', 'ghost']).status, 2);
});
test('remove deletes adapter, launcher and skill', () => {
  const r = run(['remove', 'petstore']); assert.equal(r.status, 0);
  assert.ok(!existsSync(join(home, 'petstore')));
  assert.ok(!existsSync(join(home, 'bin', 'petstore.cmd'))); assert.ok(!existsSync(join(home, 'bin', 'petstore')));
  assert.ok(!existsSync(join(skills, 'petstore')));
  assert.equal(J(r).data.launcher.length, 2);
});
test('add desktop adapter from recipes dir, then recipes and recipe show it', () => {
  const r = run(['add', 'app:Calculator', '--name', 'calcx', '--recipes', 'fixtures/calculator']);
  assert.equal(r.status, 0, r.stderr); assert.equal(J(r).data.verbs[0].name, 'add');
  assert.deepEqual(J(run(['recipes', 'calcx'])).data.map(x => x.verb), ['add']);
  assert.equal(J(run(['recipe', 'calcx', 'add'])).data.returns, 'result');
  assert.match(readFileSync(join(skills, 'calcx', 'SKILL.md'), 'utf8'), /declick desk arm/);
});
test('remove one verb deletes the whole adapter when it was the last one', () => {
  assert.equal(run(['remove', 'calcx', 'add']).status, 0);
  assert.ok(!existsSync(join(home, 'calcx')));
});

const fakeEnv = { ...env, DECLICK_DESK: join(process.cwd(), 'test', 'fake-desk.mjs'), DECLICK_AUTHOR: join(process.cwd(), 'test', 'fake-author.mjs'), FAKE_DESK_ARMED: '1', FAKE_DESK_DISPLAY: '14' };
const goodRecipe = { verb: 'add', description: 'Add two numbers', args: [{ name: 'a' }, { name: 'b' }], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:{{a}}'], as: 'a' }, { click: 'a' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }],
  returns: 'result', example: ['Seven', 'Seven'], expect: '14' };
const cli = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...fakeEnv, ...extra }, encoding: 'utf8' });

test('add app: with --goal authors and builds', () => {
  const r = cli(['add', 'app:Calculator', '--name', 'calc-auth', '--goal', 'add two numbers', '--verb', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify(goodRecipe) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(J(r).data.engine, 'desktop'); assert.equal(J(r).data.verbs[0].name, 'add');
  assert.ok(existsSync(join(home, 'calc-auth', 'recipes', 'add.json')));
  assert.ok(existsSync(join(home, 'bin', 'calc-auth.cmd')));
});
test('author adds a second verb to an existing adapter', () => {
  const r = cli(['author', 'calc-auth', '--goal', 'read the display', '--verb', 'show'], { FAKE_AUTHOR_RECIPE: JSON.stringify({ ...goodRecipe, verb: 'show', args: [], example: [], steps: [{ window: 'Calculator' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }] }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(J(run(['describe', 'calc-auth'])).data.verbs.some(v => v.name === 'show'));
});
test('failed replay exits 2, keeps a proposal, and proposals / accept see it', () => {
  const r = cli(['author', 'calc-auth', '--goal', 'nope', '--verb', 'nope'], { FAKE_AUTHOR_RECIPE: JSON.stringify({ ...goodRecipe, verb: 'nope', expect: '^never$' }) });
  assert.equal(r.status, 2, r.stdout); assert.match(J(r).error, /proposal kept at/);
  assert.ok(existsSync(join(home, 'calc-auth', 'proposals', 'nope.json')));
  const p = J(cli(['proposals', 'calc-auth'])).data; assert.equal(p[0].verb, 'nope'); assert.match(p[0].accept, /declick accept calc-auth nope/);
  assert.equal(J(cli(['status', 'calc-auth'])).data.proposals[0], 'nope');
  const a = cli(['accept', 'calc-auth', 'nope']); assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.ok(J(run(['describe', 'calc-auth'])).data.verbs.some(v => v.name === 'nope'));
  assert.ok(!existsSync(join(home, 'calc-auth', 'proposals', 'nope.json')));
});
test('repair seeds the author with the last diff and clears last-error', () => {
  const miss = spawnSync(process.execPath, ['bin/run.mjs', 'calc-auth', 'add', 'Nine', 'Seven', '--json'], { env: fakeEnv, encoding: 'utf8' });
  assert.equal(miss.status, 2, miss.stdout);
  assert.ok(Array.isArray(JSON.parse(miss.stdout).data.missing), 'diff reaches stdout');
  const le = JSON.parse(readFileSync(join(home, 'calc-auth', 'last-error.json'), 'utf8'));
  assert.equal(le.verb, 'add'); assert.match(le.error, /Button:Nine/);
  assert.equal(J(cli(['status', 'calc-auth'])).data.lastError.verb, 'add');
  const log = join(home, 'repair-prompt.txt');
  const r = cli(['repair', 'calc-auth', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify(goodRecipe), FAKE_AUTHOR_LOG: log });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const prompt = readFileSync(log, 'utf8');
  assert.match(prompt, /repairing/); assert.match(prompt, /Button:Nine/);
  assert.ok(!existsSync(join(home, 'calc-auth', 'last-error.json')));
});
test('remove one verb keeps the rest', () => {
  const r = cli(['remove', 'calc-auth', 'nope']); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!J(run(['describe', 'calc-auth'])).data.verbs.some(v => v.name === 'nope'));
});
test('desk status reads the deskclaw switches next to the launcher', () => {
  const j = J(cli(['desk', 'status'])).data; assert.equal(j.exists, true); assert.equal(j.armed, false); assert.equal(j.stop, false);
});
test('usage lists every command an agent needs', () => {
  const u = run([], { }).stdout;
  for (const c of ['run', 'status', 'doctor', 'auth', 'manifest', 'proposals', 'accept', 'author', 'repair', 'export', 'import', 'desk', 'path', 'engines']) assert.match(J({ stdout: u }).data.usage, new RegExp('\\b' + c + '\\b'));
});
test('a launcher never shadows an executable that is already on PATH', () => {
  const r = run(['add', 'fixtures/petstore.json', '--name', 'node']);
  assert.equal(r.status, 1); assert.match(J(r).error, /node already resolves to/);
  assert.ok(!existsSync(join(home, 'bin', 'node.cmd')));
});
