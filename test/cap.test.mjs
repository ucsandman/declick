import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-cap-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-cap-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin: this file runs the fake server in-process, and spawnSync would block its event loop.
const runtime = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const bytes = x => Buffer.byteLength(JSON.stringify(x));

// 200 rows of about 260 bytes each: roughly 50 KB, six times the 8192 default cap.
const BIG = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `pet-${i + 1}`, status: 'sold', note: 'x'.repeat(200) }));
const ONE = { id: 1, name: 'Rex', blob: 'y'.repeat(40000), status: 'sold' };
const srv = createServer((req, res) => {
  const path = req.url.split('?')[0];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(path === '/big' ? BIG : ONE));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });

const base = `http://127.0.0.1:${srv.address().port}`;
const spec = join(home, 'shop.json');
writeFileSync(spec, JSON.stringify({
  openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: base }],
  paths: {
    '/big': { get: { operationId: 'listBig', summary: 'A wide list' } },
    '/one': { get: { operationId: 'getOne', summary: 'One fat object' } },
    '/pets': { post: { operationId: 'addPet', summary: 'Add a pet', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string' } } } } } } } },
  },
}));
assert.equal(run(['add', spec, '--name', 'shop']).status, 0, 'fixture adapter');

test('a 50 KB list is capped to 8192 bytes by default, and says so without failing', async () => {
  const r = await runtime(['shop', 'list-big', '--limit', '500']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = J(r);
  assert.ok(bytes(j.data) <= 8192, `data is ${bytes(j.data)} bytes`);
  assert.ok(j.data.length > 1 && j.data.length < 200, `kept ${j.data.length} of 200 rows`);
  assert.equal(j.meta.truncated, true);
  assert.equal(j.meta.capped.max, 8192);
  assert.ok(j.meta.capped.bytes > 40000, `original was ${j.meta.capped.bytes} bytes`);
  assert.equal(j.meta.capped.hint, 'add --fields or --limit; declick describe <name> --verb <verb> shows the shape');
  assert.deepEqual(j.data[0], BIG[0], 'the rows that fit are whole rows, not sliced ones');
});
test('--max-bytes 0 turns the cap off and DECLICK_MAX_BYTES moves it', async () => {
  const off = J(await runtime(['shop', 'list-big', '--limit', '500', '--max-bytes', '0']));
  assert.equal(off.data.length, 200);
  assert.equal(off.meta.capped, undefined);
  assert.equal(off.meta.truncated, false);
  const tight = J(await runtime(['shop', 'list-big', '--limit', '500'], { DECLICK_MAX_BYTES: '2000' }));
  assert.ok(bytes(tight.data) <= 2000, `data is ${bytes(tight.data)} bytes`);
  assert.equal(tight.meta.capped.max, 2000);
  const flag = J(await runtime(['shop', 'list-big', '--limit', '500', '--max-bytes', '4000'], { DECLICK_MAX_BYTES: '2000' }));
  assert.equal(flag.meta.capped.max, 4000, 'the flag wins over the variable');
  assert.ok(flag.data.length > tight.data.length);
});
test('an object payload keeps every key and names the size of what it dropped', async () => {
  const j = J(await runtime(['shop', 'get-one']));
  assert.deepEqual(Object.keys(j.data), ['id', 'name', 'blob', 'status']);
  assert.equal(j.data.id, 1); assert.equal(j.data.name, 'Rex'); assert.equal(j.data.status, 'sold');
  assert.match(j.data.blob, /^<400\d\d bytes; add --fields or --limit>$/);
  assert.ok(bytes(j.data) <= 8192);
  assert.equal(j.meta.capped.max, 8192);
});
test('a bare --max-bytes and a value that is not a whole count are exit 1', async () => {
  for (const args of [['--max-bytes'], ['--max-bytes', 'lots'], ['--max-bytes', '-1'], ['--max-bytes', '1.5']]) {
    const r = await runtime(['shop', 'get-one', ...args]);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
    assert.match(J(r).error, /--max-bytes needs a byte count: 0 or a positive integer/);
  }
  const bad = await runtime(['shop', 'get-one'], { DECLICK_MAX_BYTES: 'lots' });
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(J(bad).error, /DECLICK_MAX_BYTES must be 0 or a positive integer, got lots/);
});
test('the cap never touches a preview, however big the preview is', async () => {
  const name = 'z'.repeat(9000);
  const j = J(await runtime(['shop', 'add-pet', '--name', name, '--dry-run', '--max-bytes', '200']));
  assert.equal(j.meta.dryRun, true);
  assert.equal(j.meta.capped, undefined);
  assert.equal(JSON.parse(j.data.body).name.length, 9000, 'the preview is whole even under a 200 byte cap');
});
test('describe and --help are never capped', async () => {
  const d = await runtime(['shop', 'describe', '--full'], { DECLICK_MAX_BYTES: '10' });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.equal(J(d).meta.capped, undefined);
  assert.equal(J(d).data.verbs.length, 3);
  const h = await runtime(['shop', 'get-one', '--help'], { DECLICK_MAX_BYTES: '10' });
  assert.equal(h.status, 0, h.stdout + h.stderr);
  assert.equal(J(h).meta.capped, undefined);
});
test('a defaults file can set the cap per verb', async () => {
  writeFileSync(join(home, 'shop', 'defaults.json'), JSON.stringify({ 'get-one': { 'max-bytes': 300 } }));
  try {
    const j = J(await runtime(['shop', 'get-one']));
    assert.deepEqual(j.meta.defaults, ['maxBytes']);
    assert.equal(j.meta.capped.max, 300);
    assert.ok(bytes(j.data) <= 300, `data is ${bytes(j.data)} bytes`);
    assert.equal(J(await runtime(['shop', 'get-one', '--max-bytes', '0'])).meta.capped, undefined, 'the command line still wins');
  } finally { writeFileSync(join(home, 'shop', 'defaults.json'), '{}'); }
});
test('a batch caps each item and never the whole envelope: every entry is a record of what ran', async () => {
  const p = join(home, 'each.ndjson');
  writeFileSync(p, JSON.stringify({}) + '\n' + JSON.stringify({}) + '\n' + JSON.stringify({}) + '\n');
  const j = J(await runtime(['shop', 'get-one', '--each', p, '--max-bytes', '600']));
  assert.equal(j.meta.count, 3);
  for (const e of j.data) {
    assert.equal(e.capped.max, 600, JSON.stringify(e).slice(0, 200));
    assert.match(e.data.blob, /bytes; add --fields or --limit>$/);
  }
  assert.equal(j.meta.capped, undefined, 'the batch envelope is never capped');
  assert.equal(j.data.length, 3, 'no entry is dropped');
  assert.ok(bytes(j.data) > 600, `three capped entries exceed one cap: ${bytes(j.data)} bytes`);
});
