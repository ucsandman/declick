import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-where-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-where-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin: this file runs the fake server in-process, and spawnSync would block its event loop.
const runtime = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const ids = j => j.data.map(r => r.id);

// price is a number, done a bool, tag null on 1 and absent on 3, so every operator has a row that fails it.
const PETS = [
  { id: 1, name: 'Rex', status: 'sold', price: 10, done: true, tag: null },
  { id: 2, name: 'Ada', status: 'available', price: 25, done: false, tag: 'new' },
  { id: 3, name: 'Bo', status: 'pending', price: 7, done: true },
  { id: 4, name: 'Cleo', status: 'sold', price: 40, done: false, tag: 'vip', owner: { city: 'Oslo' } },
];
const srv = createServer((req, res) => {
  const path = req.url.split('?')[0];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(path === '/pets' ? PETS : path === '/page' ? { items: PETS, total: PETS.length } : PETS[0]));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });

const base = `http://127.0.0.1:${srv.address().port}`;
const spec = join(home, 'shop.json');
writeFileSync(spec, JSON.stringify({
  openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: base }],
  paths: {
    '/pets': { get: { operationId: 'listPets', summary: 'List pets' } },
    '/page': { get: { operationId: 'pagePets', summary: 'One page of pets' } },
    '/pet/{petId}': { get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }] } },
  },
}));
assert.equal(run(['add', spec, '--name', 'shop']).status, 0, 'fixture adapter');

test('k=v compares a number as a number, a bool as a bool and everything else as an exact string', async () => {
  const j = J(await runtime(['shop', 'list-pets', '--where', 'status=sold']));
  assert.deepEqual(ids(j), [1, 4]);
  assert.deepEqual(j.meta.where, { matched: 2, of: 4 });
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'id=2']))), [2]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'done=true']))), [1, 3]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'status=SOLD']))), [], 'a string match is exact, not case-folded');
});
test('k!=v keeps the rows that do not match, including the ones with no value there', async () => {
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'status!=sold']))), [2, 3]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'tag!=new']))), [1, 3, 4]);
});
test('k~re is a case-insensitive regex', async () => {
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'name~^a']))), [2]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'name~o$']))), [3, 4]);
  const bad = await runtime(['shop', 'list-pets', '--where', 'name~[']);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(J(bad).error, /--where name~\[ is not a valid regex/);
});
test('the four number operators compare values, and a row with nothing there never matches', async () => {
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'price>10']))), [2, 4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'price>=10']))), [1, 2, 4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'price<10']))), [3]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'price<=10']))), [1, 3]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'name>1']))), [], 'a value that is not a number fails a comparison instead of throwing');
});
test('k=* is present and not null, and a dotted path resolves per row', async () => {
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'tag=*']))), [2, 4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'owner.city=Oslo']))), [4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'owner.city=*']))), [4]);
});
test('conditions are repeatable and comma-separable, and every one of them has to hold', async () => {
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'status=sold', '--where', 'price>20']))), [4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'status=sold,price>20']))), [4]);
  assert.deepEqual(ids(J(await runtime(['shop', 'list-pets', '--where', 'status=sold,price>100']))), []);
});
test('--where runs before --fields and --limit, and meta.count is what matched', async () => {
  const j = J(await runtime(['shop', 'list-pets', '--where', 'price>=10', '--fields', 'name', '--limit', '2']));
  assert.deepEqual(j.data, [{ name: 'Rex' }, { name: 'Ada' }]);
  assert.equal(j.meta.count, 3); assert.equal(j.meta.truncated, true);
  assert.deepEqual(j.meta.where, { matched: 3, of: 4 });
});
test('--where alone unwraps the rows a response object carries', async () => {
  const j = J(await runtime(['shop', 'page-pets', '--where', 'status=sold']));
  assert.deepEqual(ids(j), [1, 4]);
  assert.equal(j.meta.rows, 'items');
  assert.deepEqual(j.meta.extra, { total: 4 });
});
test('a condition on a verb that answers with one object is exit 1 naming the verb', async () => {
  const r = await runtime(['shop', 'get-pet', '1', '--where', 'status=sold']);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(J(r).error, 'where applies to lists; get-pet returns an object');
  assert.equal((await runtime(['shop', 'get-pet', '1'])).status, 0, 'the same verb without a condition still answers');
});
test('a condition with no operator, and a bare --where, name the forms that work', async () => {
  const r = await runtime(['shop', 'list-pets', '--where', 'status']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(J(r).error, /--where status needs an operator: k=v, k!=v, k~re, k>n, k>=n, k<n, k<=n, or k=\* for present/);
  const bare = await runtime(['shop', 'list-pets', '--where']);
  assert.equal(bare.status, 1, bare.stdout);
  assert.match(J(bare).error, /--where needs a condition/);
});
test('every item of a batch is filtered by its own condition', async () => {
  const p = join(home, 'each.ndjson');
  writeFileSync(p, [{}, { where: 'price>20' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  const j = J(await runtime(['shop', 'list-pets', '--each', p, '--where', 'status=sold']));
  assert.equal(j.meta.failed, 0, JSON.stringify(j.data));
  assert.deepEqual(j.data.map(e => e.data.map(r => r.id)), [[1, 4], [2, 4]]);
});
