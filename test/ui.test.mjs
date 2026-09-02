import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-ui-'));
process.env.DECLICK_SKILLS = join(process.env.DECLICK_HOME, 'skills');
process.env.CREDS_VAULT = join(process.env.DECLICK_HOME, 'none.env');
const { startUi, adapterRows } = await import('../src/ui.mjs');
const { manifestDir } = await import('../src/manifest.mjs');
const cli = a => spawnSync(process.execPath, ['bin/declick.mjs', ...a], { env: process.env, encoding: 'utf8' });
const runtime = a => spawnSync(process.execPath, ['bin/run.mjs', ...a], { env: process.env, encoding: 'utf8' });

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
test('GET / renders the adapter with three buttons', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>declick/); assert.match(html, /petstore/);
  for (const b of ['build', 'repair', 'remove']) assert.match(html, new RegExp(`data-action="${b}"`));
});
test('GET /api/adapters is the JSON rows', async () => {
  const j = await (await fetch(base + '/api/adapters')).json();
  assert.equal(j[0].name, 'petstore'); assert.equal(j[0].lastRun.exit, 0);
});
test('POST build reruns the CLI and reports exit 0', async () => {
  const r = await fetch(base + '/api/petstore/build', { method: 'POST' });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.exit, 0); assert.match(j.stdout, /petstore \(openapi\)/);
});
test('POST repair without a recorded failure is 400', async () => {
  const r = await fetch(base + '/api/petstore/repair', { method: 'POST' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /no recorded failure/);
});
test('POST remove deletes the adapter; unknown route is 404', async () => {
  const r = await fetch(base + '/api/petstore/remove', { method: 'POST' });
  assert.equal((await r.json()).ok, true);
  assert.ok(!existsSync(join(manifestDir('petstore'), 'manifest.json')));
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/adapters')).json(), []);
});
test('teardown', () => new Promise(res => server.close(res)));
