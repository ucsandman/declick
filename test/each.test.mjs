import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-each-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-each-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// input is how `--each -` gets its items: the runtime reads fd 0 when the value is a dash.
const runtime = (args, extra = {}, input) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
// Async twin for tests that also run a server in this process: spawnSync would block the server's event loop.
const runtimeAsync = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
// A string line goes in verbatim, so a test can write a line that is not JSON at a known number.
const items = (file, lines) => { const p = join(home, file); writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); return p; };
const auditLines = () => readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0, 'fixture adapter');

test('an NDJSON file runs one item per line, in order, as one envelope', () => {
  const p = items('pets.ndjson', [{ petId: 7 }, '', { petId: 8 }]);
  const r = runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = J(r);
  assert.equal(j.ok, true); assert.equal(j.meta.each, true); assert.equal(j.meta.count, 2); assert.equal(j.meta.failed, 0);
  assert.deepEqual(j.data.map(e => e.input), [{ petId: 7 }, { petId: 8 }], 'a blank line is skipped, order is the input order');
  assert.ok(j.data.every(e => e.ok === true && e.exit === 0), r.stdout);
  assert.deepEqual(j.data.map(e => e.data.url), ['https://petstore3.swagger.io/api/v3/pet/7', 'https://petstore3.swagger.io/api/v3/pet/8']);
});
test('a JSON array file and - for stdin carry the same items', () => {
  const p = join(home, 'pets.json'); writeFileSync(p, JSON.stringify([{ petId: 1 }, { petId: 2 }]));
  const a = J(runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']));
  const s = J(runtime(['petstore', 'get-pet-by-id', '--each', '-', '--dry-run'], {}, '{"petId":1}\n{"petId":2}\n'));
  assert.equal(a.meta.count, 2); assert.equal(s.meta.count, 2);
  assert.deepEqual(s.data.map(e => e.data.url), a.data.map(e => e.data.url));
});
test('the command line is the default for every item; shorthand and {args, flags} both override it', () => {
  const p = items('mix.ndjson', [{}, { petId: 9 }, { args: ['11'] }]);
  const q = J(runtime(['petstore', 'get-pet-by-id', '5', '--each', p, '--dry-run']));
  assert.deepEqual(q.data.map(e => e.data.url.split('/pet/')[1]), ['5', '9', '11']);
  const b = items('add.ndjson', [{ name: 'Rex' }, { name: 'Sam', status: 'sold' }, { flags: { name: 'Ada', status: 'pending' } }]);
  const j = J(runtime(['petstore', 'add-pet', '--each', b, '--dry-run', '--status', 'available']));
  assert.deepEqual(j.data.map(e => JSON.parse(e.data.body)), [{ name: 'Rex', status: 'available' }, { name: 'Sam', status: 'sold' }, { name: 'Ada', status: 'pending' }]);
  // A JSON value becomes the token a shell would have carried, so an array is the repeatable flag typed twice.
  const h = items('hdr.ndjson', [{ args: ['7'], flags: { header: ['x-a: 1', 'x-b: 2'] } }]);
  const hj = J(runtime(['petstore', 'get-pet-by-id', '--each', h, '--dry-run']));
  assert.equal(hj.data[0].data.headers['x-a'], '1'); assert.equal(hj.data[0].data.headers['x-b'], '2');
});
test('an item carries its own --dry-run, and a batch that is all previews sends nothing', () => {
  const p = items('dry.ndjson', [{ args: ['7'], flags: { 'dry-run': true } }]);
  const j = J(runtime(['petstore', 'get-pet-by-id', '--each', p]));
  assert.equal(j.data[0].ok, true, JSON.stringify(j.data[0]));
  assert.equal(j.data[0].data.headers.api_key, '<PETSTORE_API_KEY>', 'the key is masked, so nothing was sent');
});
test('the batch exits with the first failing item and keeps running the rest', () => {
  const p = items('bad.ndjson', [{ petId: 7 }, { petId: 'nope' }, { petId: 9 }]);
  const r = runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']);
  assert.equal(r.status, 1, r.stdout);
  const j = J(r);
  assert.equal(j.ok, true, 'the batch ran; the item is what failed');
  assert.equal(j.meta.count, 3); assert.equal(j.meta.failed, 1);
  assert.equal(j.data[1].ok, false); assert.equal(j.data[1].exit, 1); assert.match(j.data[1].error, /must be integer/);
  assert.equal(j.data[2].ok, true, 'a failing item does not stop the ones after it');
  assert.match(JSON.parse(readFileSync(join(home, 'petstore', 'last-run.json'), 'utf8')).error, /^1 of 3 items failed/);
});
test('a line that is not JSON, a missing file, a bare --each and a half-shaped item all stop before anything runs', () => {
  const bad = items('broken.ndjson', [{ petId: 1 }, 'not json', { petId: 2 }]);
  const r = runtime(['petstore', 'get-pet-by-id', '--each', bad, '--dry-run']);
  assert.equal(r.status, 1); assert.match(J(r).error, /line 2 is not JSON/); assert.match(J(r).error, /broken\.ndjson/);
  const gone = runtime(['petstore', 'get-pet-by-id', '--each', join(home, 'nothing.ndjson'), '--dry-run']);
  assert.equal(gone.status, 1); assert.match(J(gone).error, /^no such file: .*nothing\.ndjson/);
  assert.match(J(runtime(['petstore', 'get-pet-by-id', '--each', '--dry-run'])).error, /^--each needs a file of items/);
  assert.match(J(runtime(['petstore', '--each', bad])).error, /^--each needs a verb: petstore <verb>/);
  const half = items('half.ndjson', [{ petId: 1, flags: { fields: 'id' } }]);
  assert.match(J(runtime(['petstore', 'get-pet-by-id', '--each', half, '--dry-run'])).error, /line 1: an item is either \{args, flags\}/);
  const scalar = items('scalar.ndjson', [{ petId: 1 }, 7]);
  assert.match(J(runtime(['petstore', 'get-pet-by-id', '--each', scalar, '--dry-run'])).error, /line 2: an item must be a JSON object/);
});
test('an item may turn --dry-run on, never off', () => {
  const p = items('nodry.ndjson', [{ args: ['7'], flags: { 'dry-run': false } }]);
  const j = J(runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']));
  assert.equal(j.data[0].ok, true, JSON.stringify(j.data[0]));
  assert.equal(j.data[0].data.headers.api_key, '<PETSTORE_API_KEY>', 'the preview the caller asked for held');
});
test('a value the parser rejects fails its own item, like a flag name it does not know', () => {
  const p = items('badval.ndjson', [{ petId: 1 }, { args: ['2'], flags: { limit: 0 } }, { petId: 3 }]);
  const j = J(runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']));
  assert.equal(j.meta.count, 3); assert.equal(j.meta.failed, 1);
  assert.match(j.data[1].error, /line 2: --limit must be a positive integer, got 0/);
  assert.ok(j.data[0].ok && j.data[2].ok, 'the items around it still ran');
});
test('a blocked item stops the batch, and every input still gets an entry', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/api/guard') ? JSON.stringify({ decision: 'block', reason: 'policy says no' }) : '{"deleted":true}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const spec = join(home, 'gov.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Gov' }, servers: [{ url: base }],
      paths: { '/pet/{id}': { delete: { operationId: 'deletePet', summary: 'Delete a pet', parameters: [{ name: 'id', in: 'path', required: true }] } } } }));
    assert.equal(run(['add', spec, '--name', 'gov']).status, 0);
    const p = items('gov.ndjson', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await runtimeAsync(['gov', 'delete-pet', '--each', p], { DASHCLAW_API_KEY: 'key', DASHCLAW_URL: `${base}/api/guard`, DASHCLAW_TIMEOUT_MS: '2000' });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const j = J(r);
    assert.equal(j.meta.count, 3); assert.equal(j.meta.failed, 3);
    assert.match(j.data[0].error, /blocked by governance: policy says no/);
    assert.deepEqual(j.data.slice(1).map(e => e.error), ['not run: item 1 was blocked', 'not run: item 1 was blocked']);
    assert.equal(j.meta.governance.decision, 'block');
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
test('an unknown flag on the command line is one error, not one failure per item', () => {
  const p = items('flag.ndjson', [{ petId: 1 }, { petId: 2 }]);
  const r = runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run', '--fieldz', 'id']);
  assert.equal(r.status, 1); assert.match(J(r).error, /^unknown flag --fieldz for get-pet-by-id/);
  const one = items('flag2.ndjson', [{ petId: 1 }, { flags: { fieldz: 'id' } }]);
  const j = J(runtime(['petstore', 'get-pet-by-id', '1', '--each', one, '--dry-run']));
  assert.equal(j.meta.failed, 1, 'an unknown key in one item fails that item only');
  assert.match(j.data[1].error, /^unknown flag --fieldz for get-pet-by-id/);
});
test('one audit line for the whole batch, carrying the item count', () => {
  const before = auditLines().length;
  const p = items('audit.ndjson', [{ petId: 1 }, { petId: 2 }]);
  assert.equal(runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']).status, 0);
  const after = auditLines();
  assert.equal(after.length - before, 1, 'one line for the batch, not one per item');
  assert.deepEqual(after.at(-1).each, { count: 2, failed: 0 });
  assert.equal(after.at(-1).verb, 'get-pet-by-id'); assert.equal(after.at(-1).ok, true);
});
test('a batch longer than the default page keeps every item', () => {
  const p = items('many.ndjson', Array.from({ length: 60 }, (_, i) => ({ petId: i + 1 })));
  const j = J(runtime(['petstore', 'get-pet-by-id', '--each', p, '--dry-run']));
  assert.equal(j.data.length, 60); assert.equal(j.meta.count, 60); assert.equal(j.meta.truncated, false);
});
test('each item is shaped by its own --fields, exactly as a single run of it would be', async () => {
  const srv = createServer((req, res) => {
    const id = req.url.split('/').pop();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: Number(id), name: `pet-${id}`, status: 'sold' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const spec = join(home, 'shop.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: base }],
      paths: { '/pet/{petId}': { get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }] } } } }));
    assert.equal(run(['add', spec, '--name', 'shop']).status, 0);
    const p = items('shape.ndjson', [{ petId: 1 }, { args: ['2'], flags: { fields: 'name' } }]);
    const j = J(await runtimeAsync(['shop', 'get-pet', '--each', p, '--fields', 'id,name']));
    assert.equal(j.meta.failed, 0, JSON.stringify(j.data));
    assert.deepEqual(j.data.map(e => e.data), [{ id: 1, name: 'pet-1' }, { name: 'pet-2' }]);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
