import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-cache-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-cache-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin: this file runs the fake server in-process, and spawnSync would block its event loop.
const runtime = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const dir = join(home, 'shop', 'cache');
const entries = () => (existsSync(dir) ? readdirSync(dir) : []);
const reset = () => { rmSync(dir, { recursive: true, force: true }); hits = 0; };
const lastAudit = () => { const l = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); };

// Every request the fake API actually serves: the whole point of the cache is that this stops going up.
let hits = 0;
const srv = createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.method === 'POST' ? '{"id":9,"name":"Rex"}' : JSON.stringify([{ id: 1, name: 'Rex', status: 'sold' }, { id: 2, name: 'Ada', status: 'new' }]));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });

const base = `http://127.0.0.1:${srv.address().port}`;
const spec = join(home, 'shop.json');
writeFileSync(spec, JSON.stringify({
  openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: base }],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }] },
      post: { operationId: 'addPet', summary: 'Add a pet', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } } },
    },
  },
}));
assert.equal(run(['add', spec, '--name', 'shop']).status, 0, 'fixture adapter');

test('the second call inside the TTL answers from the store and never reaches the server', async () => {
  reset();
  const miss = J(await runtime(['shop', 'list-pets', '--cache', '60']));
  assert.equal(hits, 1);
  assert.deepEqual(miss.meta.cache, { hit: false, stored: true });
  assert.equal(entries().length, 1, 'one file per key');
  const hit = J(await runtime(['shop', 'list-pets', '--cache', '60']));
  assert.equal(hits, 1, 'the server was not asked twice');
  assert.equal(hit.meta.cache.hit, true);
  assert.ok(Number.isInteger(hit.meta.cache.age) && hit.meta.cache.age >= 0, JSON.stringify(hit.meta.cache));
  assert.deepEqual(hit.data, miss.data, 'the stored answer is the answer');
});
test('the shaping flags are not part of the key, the verb flags are', async () => {
  reset();
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(hits, 1);
  const shaped = J(await runtime(['shop', 'list-pets', '--cache', '60', '--fields', 'name', '--limit', '1', '--where', 'status=sold']));
  assert.equal(hits, 1, '--fields, --limit and --where read the same stored response');
  assert.equal(shaped.meta.cache.hit, true);
  assert.deepEqual(shaped.data, [{ name: 'Rex' }]);
  assert.equal(entries().length, 1);
  await runtime(['shop', 'list-pets', '--status', 'sold', '--cache', '60']);
  assert.equal(hits, 2, 'a flag the verb owns changes the answer, so it changes the key');
  assert.equal(entries().length, 2);
});
test('an entry older than the TTL is fetched again', async () => {
  reset();
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(hits, 1);
  const p = join(dir, entries()[0]);
  const stored = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(stored.verb, 'list-pets');
  assert.ok(stored.result.ok, 'the raw engine result is what is stored');
  writeFileSync(p, JSON.stringify({ ...stored, at: new Date(Date.now() - 3600e3).toISOString() }) + '\n');
  const again = J(await runtime(['shop', 'list-pets', '--cache', '60']));
  assert.equal(hits, 2);
  assert.deepEqual(again.meta.cache, { hit: false, stored: true });
  const wide = J(await runtime(['shop', 'list-pets', '--cache', '7200']));
  assert.equal(hits, 2, 'a longer TTL accepts the entry the shorter one had already refreshed');
  assert.equal(wide.meta.cache.hit, true);
});
test('a mutating verb refuses the flag by name', async () => {
  reset();
  const r = await runtime(['shop', 'add-pet', '--name', 'Rex', '--cache', '60']);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(J(r).error, 'cache applies to read-only verbs; add-pet is mutating');
  assert.equal(hits, 0, 'nothing was sent');
  assert.deepEqual(entries(), []);
});
test('a preview stores nothing and reads nothing', async () => {
  reset();
  const j = J(await runtime(['shop', 'list-pets', '--cache', '60', '--dry-run']));
  assert.equal(j.meta.dryRun, true);
  assert.equal(j.meta.cache, undefined);
  assert.deepEqual(entries(), [], 'a preview never sent a request, so it has no answer to store');
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(hits, 1, 'and the preview left nothing behind for the real call to read');
});
test('--cache 0 and DECLICK_CACHE=off go to the wire and store nothing', async () => {
  reset();
  const zero = J(await runtime(['shop', 'list-pets', '--cache', '0']));
  assert.equal(hits, 1); assert.equal(zero.meta.cache, undefined); assert.deepEqual(entries(), []);
  const off = J(await runtime(['shop', 'list-pets', '--cache', '60'], { DECLICK_CACHE: 'off' }));
  assert.equal(hits, 2); assert.equal(off.meta.cache, undefined); assert.deepEqual(entries(), []);
  const bare = await runtime(['shop', 'list-pets', '--cache']);
  assert.equal(bare.status, 1, bare.stdout);
  assert.match(J(bare).error, /--cache needs a number of seconds: 0 or a positive integer/);
});
test('the run log says hit or miss', async () => {
  reset();
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(lastAudit().cache, 'miss');
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(lastAudit().cache, 'hit');
  await runtime(['shop', 'list-pets']);
  assert.equal(lastAudit().cache, undefined, 'a call that did not ask for a cache says nothing about one');
});
test('declick build clears the store, because it recompiles the verbs it belongs to', async () => {
  reset();
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(entries().length, 1);
  assert.equal(run(['build', 'shop', '--dry-run']).status, 0);
  assert.equal(entries().length, 1, 'a preview keeps it');
  assert.equal(run(['build', 'shop']).status, 0);
  assert.deepEqual(entries(), []);
  await runtime(['shop', 'list-pets', '--cache', '60']);
  assert.equal(hits, 2, 'the next call goes to the wire again');
});
test('a defaults file can set the TTL per verb', async () => {
  reset();
  writeFileSync(join(home, 'shop', 'defaults.json'), JSON.stringify({ 'list-pets': { cache: 300 } }));
  try {
    const miss = J(await runtime(['shop', 'list-pets']));
    assert.deepEqual(miss.meta.defaults, ['cache']);
    assert.deepEqual(miss.meta.cache, { hit: false, stored: true });
    assert.equal(hits, 1);
    assert.equal(J(await runtime(['shop', 'list-pets'])).meta.cache.hit, true);
    assert.equal(hits, 1);
    assert.equal(J(await runtime(['shop', 'list-pets', '--cache', '0'])).meta.cache, undefined, 'the command line still wins');
    assert.equal(hits, 2);
  } finally { writeFileSync(join(home, 'shop', 'defaults.json'), '{}'); }
});
test('declick remove takes the store with the adapter', async () => {
  reset();
  assert.equal(run(['add', spec, '--name', 'gone']).status, 0);
  await runtime(['gone', 'list-pets', '--cache', '60']);
  assert.equal(readdirSync(join(home, 'gone', 'cache')).length, 1);
  assert.equal(run(['remove', 'gone']).status, 0);
  assert.equal(existsSync(join(home, 'gone')), false);
});
