import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Two machines: A builds and pushes, B pulls. Each has its own home, skills dir and launcher bin.
const mk = tag => ({ home: mkdtempSync(join(tmpdir(), `declick-store-${tag}-`)), skills: mkdtempSync(join(tmpdir(), `skills-store-${tag}-`)) });
const A = mk('a'), B = mk('b');
const store = mkdtempSync(join(tmpdir(), 'declick-teamstore-'));
const envOf = (m, extra = {}) => ({ ...process.env, DECLICK_HOME: m.home, DECLICK_SKILLS: m.skills, DECLICK_STORE: '', CREDS_VAULT: join(m.home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(m.home, 'no-desk'), ...extra });
const run = (m, args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: envOf(m, extra), encoding: 'utf8' });
const runAsync = (m, args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/declick.mjs', ...args], { env: envOf(m, extra) }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const idx = () => JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));

test('no store set is exit 2 with the fix, on every action', () => {
  for (const args of [['store'], ['store', 'pull'], ['store', 'push', 'x']]) {
    const r = run(A, args); assert.equal(r.status, 2, args.join(' ')); assert.match(J(r).error, /declick store set/);
  }
  assert.equal(run(A, ['store', 'bogus']).status, 1);
});

test('store set remembers a directory, creates it, and DECLICK_STORE overrides the file', () => {
  const j = J(run(A, ['store', 'set', store]));
  assert.equal(j.data.kind, 'dir'); assert.equal(j.data.git, false);
  assert.deepEqual(JSON.parse(readFileSync(join(A.home, 'store.json'), 'utf8')), { path: j.data.path });
  const fresh = join(store, 'sub', 'deeper');
  assert.equal(J(run(A, ['store', 'set', fresh])).data.path.endsWith('deeper'), true); assert.ok(existsSync(fresh));
  rmSync(join(store, 'sub'), { recursive: true, force: true });
  run(A, ['store', 'set', store]);
  // PowerShell passes a literal ~ to a native exe; the store must land in the home dir either way.
  assert.equal(J(run(A, ['store'], { DECLICK_STORE: '~/declick-store-tilde-test' })).meta.store, join(homedir(), 'declick-store-tilde-test'));
  const other = mkdtempSync(join(tmpdir(), 'declick-other-store-'));
  assert.equal(J(run(A, ['store'], { DECLICK_STORE: other })).meta.store, other);
  const d = J(run(A, ['doctor'])).data.store; assert.equal(d.kind, 'dir'); assert.equal(d.exists, true);
});

test('push writes the bundle and the index; a second push is unchanged; the bundle carries defaults but no key values', () => {
  assert.equal(run(A, ['add', 'fixtures/petstore.json', '--name', 'petstore', '--verbs', 'get-pet-by-id,add-pet']).status, 0);
  assert.equal(run(A, ['defaults', 'petstore', '--set', 'limit=5']).status, 0);
  const j = J(run(A, ['store', 'push', 'petstore']));
  assert.deepEqual(j.data.map(r => r.state), ['pushed']); assert.equal(j.meta.pushed, 1); assert.equal(j.meta.git, 'none');
  const bundle = JSON.parse(readFileSync(join(store, 'petstore.json'), 'utf8'));
  assert.equal(bundle.manifest.name, 'petstore'); assert.deepEqual(bundle.defaults, { '*': { limit: 5 } });
  assert.deepEqual(bundle.manifest.auth.env, ['PETSTORE_API_KEY']);
  assert.ok(!JSON.stringify(bundle).includes('sk-'), 'a bundle carries key names, never values');
  const e = idx().adapters[0];
  assert.equal(e.name, 'petstore'); assert.equal(e.verbs, 2); assert.equal(e.hash, j.data[0].hash); assert.match(e.by, /@/);
  const again = J(run(A, ['store', 'push', 'petstore']));
  assert.equal(again.data[0].state, 'unchanged'); assert.equal(again.meta.unchanged, 1);
  assert.equal(run(A, ['store', 'push']).status, 1, 'push needs a name or --all');
});

test('status: in-sync after a push, new on a fresh machine, local-only for what was never pushed', () => {
  assert.equal(J(run(A, ['store'])).data[0].state, 'in-sync');
  assert.equal(run(A, ['add', 'fixtures/petstore.json', '--name', 'private', '--verbs', 'get-pet-by-id']).status, 0);
  const s = J(run(A, ['store']));
  assert.deepEqual(Object.fromEntries(s.data.map(r => [r.name, r.state])), { petstore: 'in-sync', private: 'local-only' });
  assert.equal(s.meta['local-only'], 1);
  const b = J(run(B, ['store'], { DECLICK_STORE: store }));
  assert.deepEqual(b.data.map(r => [r.name, r.state]), [['petstore', 'new']]);
});

test('pull --dry-run writes nothing; pull installs manifest, launcher, skill and defaults; a second pull is unchanged', () => {
  const dry = J(run(B, ['store', 'pull', '--dry-run'], { DECLICK_STORE: store }));
  assert.equal(dry.meta.dryRun, true); assert.equal(dry.meta.wouldChange, 1); assert.ok(!existsSync(join(B.home, 'petstore')));
  const j = J(run(B, ['store', 'pull'], { DECLICK_STORE: store }));
  assert.equal(j.ok, true); assert.equal(j.data[0].state, 'installed'); assert.equal(j.data[0].source, JSON.parse(readFileSync(join(store, 'petstore.json'), 'utf8')).manifest.source);
  assert.equal(j.meta.installed, 1);
  assert.ok(existsSync(join(B.home, 'petstore', 'manifest.json')));
  assert.ok(existsSync(join(B.home, 'bin', 'petstore')), 'launcher');
  assert.ok(readFileSync(join(B.skills, 'petstore', 'SKILL.md'), 'utf8').includes('Generated by declick'), 'skill');
  assert.deepEqual(JSON.parse(readFileSync(join(B.home, 'petstore', 'defaults.json'), 'utf8')), { '*': { limit: 5 } });
  assert.equal(J(run(B, ['store', 'pull'], { DECLICK_STORE: store })).data[0].state, 'unchanged');
  assert.equal(J(run(B, ['describe', 'petstore'])).data.verbs.length, 2);
});

test('a rebuilt adapter pushes as changed and pulls as updated; local defaults are kept, the cache is cleared', () => {
  assert.equal(run(A, ['build', 'petstore', '--verbs', 'get-pet-by-id,add-pet,delete-pet']).status, 0);
  assert.equal(J(run(A, ['store', 'push', 'petstore'])).data[0].state, 'pushed');
  assert.equal(J(run(B, ['store'], { DECLICK_STORE: store })).data[0].state, 'update');
  writeFileSync(join(B.home, 'petstore', 'defaults.json'), JSON.stringify({ '*': { limit: '9' } }));
  mkdirSync(join(B.home, 'petstore', 'cache'), { recursive: true }); writeFileSync(join(B.home, 'petstore', 'cache', 'x.json'), '{}');
  const j = J(run(B, ['store', 'pull'], { DECLICK_STORE: store }));
  assert.equal(j.data[0].state, 'updated'); assert.equal(j.data[0].verbs, 3); assert.equal(j.meta.updated, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(B.home, 'petstore', 'defaults.json'), 'utf8')), { '*': { limit: '9' } }, 'a default the user set stays');
  assert.ok(!existsSync(join(B.home, 'petstore', 'cache', 'x.json')), 'stored answers belong to the old verbs');
});

test('a bundle whose adapter answers to a different service is a conflict: exit 1, nothing written, --force replaces', () => {
  const spec = join(B.home, 'other.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Other' }, servers: [{ url: 'https://other.example' }], paths: { '/x': { get: { operationId: 'getX', responses: { 200: { description: 'ok' } } } } } }));
  assert.equal(run(B, ['add', spec, '--name', 'clash']).status, 0);
  assert.equal(run(A, ['add', 'fixtures/petstore.json', '--name', 'clash', '--verbs', 'get-pet-by-id']).status, 0);
  assert.equal(J(run(A, ['store', 'push', 'clash'])).data[0].state, 'pushed');
  const r = run(B, ['store', 'pull'], { DECLICK_STORE: store });
  assert.equal(r.status, 1); const j = J(r);
  assert.match(j.error, /clash: differs in source, baseUrl/); assert.equal(j.meta.conflicts, 1);
  assert.equal(j.data.find(x => x.name === 'clash').hint, 'declick store pull clash --force replaces it');
  assert.equal(J(run(B, ['manifest', 'clash'])).data.baseUrl, 'https://other.example', 'untouched');
  const f = J(run(B, ['store', 'pull', 'clash', '--force'], { DECLICK_STORE: store }));
  assert.equal(f.data[0].state, 'updated'); assert.match(J(run(B, ['manifest', 'clash'])).data.baseUrl, /petstore3/);
});

test('push --all pushes every adapter; a name the store never saw is exit 2 on pull', () => {
  const j = J(run(A, ['store', 'push', '--all']));
  assert.deepEqual(j.data.map(r => r.name).sort(), ['clash', 'petstore', 'private']);
  assert.equal(idx().adapters.length, 3);
  const r = run(B, ['store', 'pull', 'nope'], { DECLICK_STORE: store }); assert.equal(r.status, 2); assert.match(J(r).error, /no bundle named nope/);
});

test('a folder with no index still lists from its bundles, and an index that lags a bundle is completed from disk', () => {
  const bare = mkdtempSync(join(tmpdir(), 'declick-noindex-'));
  writeFileSync(join(bare, 'petstore.json'), readFileSync(join(store, 'petstore.json')));
  const s = J(run(B, ['store'], { DECLICK_STORE: bare }));
  assert.deepEqual(s.data.map(r => [r.name, r.state]).filter(([n]) => n === 'petstore'), [['petstore', 'in-sync']]);
  writeFileSync(join(bare, 'private.json'), readFileSync(join(store, 'private.json')));
  writeFileSync(join(bare, 'index.json'), JSON.stringify({ adapters: idx().adapters.filter(a => a.name === 'petstore') }));
  assert.deepEqual(J(run(B, ['store'], { DECLICK_STORE: bare })).data.map(r => r.name).filter(n => n !== 'clash'), ['petstore', 'private'], 'the bundle the index forgot is still listed');
});

test('six pushes at the same instant all land in the index, and the lock is gone afterwards', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'declick-race-'));
  const homes = [];
  for (let i = 0; i < 6; i++) {
    const m = mk(`r${i}`); homes.push(m);
    assert.equal(run(m, ['add', 'fixtures/petstore.json', '--name', `racer-${i}`, '--verbs', 'get-pet-by-id']).status, 0);
  }
  const results = await Promise.all(homes.map((m, i) => runAsync(m, ['store', 'push', `racer-${i}`], { DECLICK_STORE: shared })));
  results.forEach((r, i) => assert.equal(r.status, 0, `push ${i}: ${r.stdout}${r.stderr}`));
  const names = JSON.parse(readFileSync(join(shared, 'index.json'), 'utf8')).adapters.map(a => a.name).sort();
  assert.deepEqual(names, [0, 1, 2, 3, 4, 5].map(i => `racer-${i}`), 'no push lost another push\'s index line');
  assert.ok(!existsSync(join(shared, 'index.lock')), 'lock released');
  // A lock left behind by a push that died is taken over once it is stale, and refused while it is fresh.
  mkdirSync(join(shared, 'index.lock'));
  assert.equal(run(homes[0], ['store', 'push', 'racer-0'], { DECLICK_STORE: shared }).status, 0, 'an unchanged push never needs the lock');
  assert.equal(run(homes[0], ['build', 'racer-0', '--verbs', 'get-pet-by-id,add-pet']).status, 0);
  const t0 = Date.now(); const blocked = run(homes[0], ['store', 'push', 'racer-0'], { DECLICK_STORE: shared });
  assert.equal(blocked.status, 1); assert.match(J(blocked).error, /index\.lock is held/); assert.ok(Date.now() - t0 >= 4500, 'waited for the lock before giving up');
  const past = new Date(Date.now() - 60000); (await import('node:fs')).utimesSync(join(shared, 'index.lock'), past, past);
  assert.equal(J(run(homes[0], ['store', 'push', 'racer-0'], { DECLICK_STORE: shared })).data[0].state, 'pushed', 'a stale lock is taken over');
  assert.ok(!existsSync(join(shared, 'index.lock')));
});

test('an https store is read-only: status and pull work over the index, push is refused, a missing index names itself', async () => {
  const srv = createServer((req, res) => {
    const p = join(store, decodeURIComponent(req.url.slice(1)));
    if (!existsSync(p) || req.url.includes('..')) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(readFileSync(p));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const C = mk('c');
  try {
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const set = J(await runAsync(C, ['store', 'set', base])); assert.equal(set.data.kind, 'http'); assert.equal(set.data.path, base.slice(0, -1), 'trailing slash dropped');
    const s = J(await runAsync(C, ['store'])); assert.equal(s.meta.kind, 'http'); assert.equal(s.data.length, 3);
    const j = J(await runAsync(C, ['store', 'pull', 'petstore'])); assert.equal(j.data[0].state, 'installed'); assert.ok(existsSync(join(C.home, 'petstore', 'manifest.json')));
    const p = await runAsync(C, ['store', 'push', 'petstore']); assert.equal(p.status, 1); assert.match(J(p).error, /read-only/);
    const empty = mkdtempSync(join(tmpdir(), 'declick-http-empty-'));
    const srv2 = createServer((req, res) => { res.writeHead(404); res.end(); }); await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    try { const m = await runAsync(C, ['store'], { DECLICK_STORE: `http://127.0.0.1:${srv2.address().port}` }); assert.equal(m.status, 2); assert.match(J(m).error, /index\.json is missing/); }
    finally { srv2.close(); rmSync(empty, { recursive: true, force: true }); }
  } finally { srv.close(); }
});

test('a git checkout as the store: push commits and pushes, a second clone pulls it, --no-git skips git', () => {
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const remote = mkdtempSync(join(tmpdir(), 'declick-remote-')); git(remote, 'init', '--bare', '-q', '-b', 'main');
  const one = mkdtempSync(join(tmpdir(), 'declick-clone1-')); git(one, 'clone', '-q', remote, '.'); git(one, 'commit', '-q', '--allow-empty', '-m', 'init'); git(one, 'push', '-q', '-u', 'origin', 'main');
  const two = mkdtempSync(join(tmpdir(), 'declick-clone2-')); git(two, 'clone', '-q', remote, '.');
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  assert.equal(J(run(A, ['store', 'set', one])).data.git, true);
  const p = J(run(A, ['store', 'push', 'petstore'], gitEnv)); assert.equal(p.meta.git, 'pushed');
  assert.match(git(one, 'log', '--oneline', '-1'), /declick: push petstore/);
  assert.match(git(remote, 'log', '--oneline', '-1'), /declick: push petstore/, 'landed on the remote');
  assert.equal(J(run(A, ['store', 'push', 'petstore'], gitEnv)).meta.git, 'none', 'nothing changed, nothing committed');
  const D = mk('d');
  const j = J(run(D, ['store', 'pull'], { DECLICK_STORE: two, ...gitEnv }));
  assert.equal(j.meta.git, 'pulled'); assert.equal(j.data[0].state, 'installed'); assert.ok(existsSync(join(two, 'petstore.json')), 'git pull brought the bundle in');
  assert.equal(J(run(D, ['store', 'pull', '--no-git'], { DECLICK_STORE: two })).meta.git, 'skipped');
  const local = J(run(A, ['store', 'push', 'private', '--no-git'], gitEnv)); assert.equal(local.meta.git, 'skipped');
  assert.match(git(one, 'status', '--porcelain'), /private\.json/, 'written but not committed');
});

test('export carries defaults and import round-trips them; the self skill documents store', () => {
  const out = run(A, ['export', 'petstore']); const b = J(out).data;
  assert.deepEqual(b.defaults, { '*': { limit: 5 } });
  const E = mk('e'); const f = join(E.home, 'b.json'); mkdirSync(E.home, { recursive: true }); writeFileSync(f, out.stdout);
  assert.equal(run(E, ['import', f]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(E.home, 'petstore', 'defaults.json'), 'utf8')), { '*': { limit: 5 } });
  assert.match(run(A, ['help', 'store']).stdout, /declick store \[action\] \[target\]/);
  assert.ok(readdirSync(A.skills).includes('declick') ? readFileSync(join(A.skills, 'declick', 'SKILL.md'), 'utf8').includes('store') : true);
});
