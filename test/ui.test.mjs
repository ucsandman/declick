import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-ui-'));
process.env.DECLICK_SKILLS = join(process.env.DECLICK_HOME, 'skills');
process.env.CREDS_VAULT = join(process.env.DECLICK_HOME, 'none.env');
const { startUi, adapterRows } = await import('../src/ui.mjs');
const { manifestDir } = await import('../src/manifest.mjs');
const cli = a => spawnSync(process.execPath, ['bin/declick.mjs', ...a], { env: process.env, encoding: 'utf8' });
const runtime = a => spawnSync(process.execPath, ['bin/run.mjs', ...a], { env: process.env, encoding: 'utf8' });
const jsonHeaders = () => ({ origin: base, 'content-type': 'application/json' });
const rawRequest = (path, headers) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method: 'GET', headers }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject); req.end();
});

let server, base;
test('setup: one adapter with a recorded run', async () => {
  assert.equal(cli(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0);
  const r = runtime(['petstore', 'get-pet-by-id', '7', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const lr = JSON.parse(readFileSync(join(manifestDir('petstore'), 'last-run.json'), 'utf8'));
  assert.equal(lr.verb, 'get-pet-by-id'); assert.equal(lr.ok, true); assert.equal(lr.exit, 0); assert.ok(lr.at);
  server = await startUi({ port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
test('adapterRows carries engine, verb count and last run', () => {
  const rows = adapterRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'petstore'); assert.equal(rows[0].engine, 'openapi'); assert.ok(rows[0].verbs > 0);
  assert.equal(rows[0].lastRun.verb, 'get-pet-by-id'); assert.equal(rows[0].lastError, null);
});
test('adapterRows survives a corrupt manifest; page shows it with buttons disabled', async () => {
  const dir = join(process.env.DECLICK_HOME, 'broken-one');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{not json');
  const rows = adapterRows();
  const bad = rows.find(r => r.name === 'broken-one');
  assert.ok(bad, 'corrupt adapter still produces a row');
  assert.deepEqual(bad, { name: 'broken-one', error: bad.error, engine: null, verbs: 0, lastRun: null, lastError: null });
  assert.match(bad.error, /not valid JSON/);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /broken-one/);
  assert.match(html, /data-name="broken-one"[\s\S]*?data-action="build" disabled/);
  rmSync(dir, { recursive: true, force: true });
});
test('GET / renders the adapter with three buttons', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>declick/); assert.match(html, /petstore/);
  for (const b of ['build', 'repair', 'remove']) assert.match(html, new RegExp(`data-action="${b}"`));
  assert.match(html, /id="add"/);
});
test('bad Host header is refused with 403', async () => {
  const r = await rawRequest('/api/adapters', { Host: 'evil.example.com' });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).error, 'bad host');
});
test('POST without a matching Origin, or without JSON content-type, is refused', async () => {
  const noOrigin = await fetch(base + '/api/petstore/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error, 'cross-origin request refused');
  const wrongOrigin = await fetch(base + '/api/petstore/build', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403);
  const noContentType = await fetch(base + '/api/petstore/build', { method: 'POST', headers: { origin: base }, body: '{}' });
  assert.equal(noContentType.status, 403);
});
test('malformed JSON body answers 500 instead of crashing the server', async () => {
  const r = await fetch(base + '/api/add', { method: 'POST', headers: jsonHeaders(), body: 'not json' });
  assert.equal(r.status, 500);
  const j = await r.json();
  assert.equal(j.ok, false); assert.ok(j.error);
  assert.equal((await fetch(base + '/api/adapters')).status, 200);
});
test('GET /api/adapters is the {ok,data,meta} envelope', async () => {
  const j = await (await fetch(base + '/api/adapters')).json();
  assert.equal(j.ok, true);
  assert.equal(j.data[0].name, 'petstore'); assert.equal(j.data[0].lastRun.exit, 0);
  assert.deepEqual(j.meta, { count: 1, truncated: false });
});
test('POST /api/add validates source and name, then runs the CLI', async () => {
  const noSource = await fetch(base + '/api/add', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal(noSource.status, 400);
  assert.match((await noSource.json()).error, /source required/);
  const badName = await fetch(base + '/api/add', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source: 'fixtures/petstore.json', name: 'Not Kebab' }) });
  assert.equal(badName.status, 400);
  assert.match((await badName.json()).error, /kebab-case/);
  const r = await fetch(base + '/api/add', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source: 'fixtures/petstore.json', name: 'petstore2' }) });
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.exit, 0);
  assert.ok(adapterRows().some(row => row.name === 'petstore2'));
  cli(['remove', 'petstore2']);
});
test('POST repair without a recorded failure is 400', async () => {
  const r = await fetch(base + '/api/petstore/repair', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /no recorded failure/);
});
test('POST build reruns the CLI and reports exit 0', async () => {
  const r = await fetch(base + '/api/petstore/build', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.exit, 0);
});
test('POST remove deletes the adapter; unknown route is 404', async () => {
  const r = await fetch(base + '/api/petstore/remove', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal((await r.json()).ok, true);
  assert.ok(!existsSync(join(manifestDir('petstore'), 'manifest.json')));
  assert.equal((await fetch(base + '/nope')).status, 404);
  const j = await (await fetch(base + '/api/adapters')).json();
  assert.deepEqual(j, { ok: true, data: [], meta: { count: 0, truncated: false } });
});
test('teardown', () => new Promise(res => server.close(res)));
