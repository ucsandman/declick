import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-def-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-def-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const runtime = (args, extra = {}) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin for tests that also run a server in this process: spawnSync would block the server's event loop.
const runtimeAsync = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const file = (name = 'petstore') => join(home, name, 'defaults.json');
// Written by hand on purpose: the file is a supported surface, not only what the command produces.
const setFile = (obj, name = 'petstore') => writeFileSync(file(name), JSON.stringify(obj, null, 2) + '\n');
const clearFile = (name = 'petstore') => rmSync(file(name), { force: true });

assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0, 'fixture adapter');

test('defaults sit under the command line and meta says which keys came from the file', () => {
  setFile({ '*': { limit: 20, fields: 'id,name' }, 'find-pets-by-status': { status: 'sold' } });
  const j = J(runtime(['petstore', 'find-pets-by-status', '--dry-run']));
  assert.match(j.data.url, /\?status=sold$/);
  assert.deepEqual(j.meta.defaults, ['limit', 'fields', 'status']);
  const e = J(runtime(['petstore', 'find-pets-by-status', '--status', 'pending', '--dry-run']));
  assert.match(e.data.url, /\?status=pending$/, 'an explicit flag always wins');
  assert.deepEqual(e.meta.defaults, ['limit', 'fields']);
});
test('the verb scope wins over *, and * reaches every verb', () => {
  setFile({ '*': { status: 'available' }, 'find-pets-by-status': { status: 'sold' } });
  assert.match(J(runtime(['petstore', 'find-pets-by-status', '--dry-run'])).data.url, /\?status=sold$/);
  assert.deepEqual(JSON.parse(J(runtime(['petstore', 'add-pet', '--dry-run'])).data.body), { status: 'available' });
});
test('--no-defaults and DECLICK_DEFAULTS=off skip the file', () => {
  setFile({ 'find-pets-by-status': { status: 'sold' } });
  assert.match(J(runtime(['petstore', 'find-pets-by-status', '--dry-run'])).data.url, /\?status=sold$/);
  const off = J(runtime(['petstore', 'find-pets-by-status', '--dry-run', '--no-defaults']));
  assert.equal(off.data.url, 'https://petstore3.swagger.io/api/v3/pet/findByStatus');
  assert.equal(off.meta.defaults, undefined);
  const env0 = J(runtime(['petstore', 'find-pets-by-status', '--dry-run'], { DECLICK_DEFAULTS: 'off' }));
  assert.equal(env0.data.url, 'https://petstore3.swagger.io/api/v3/pet/findByStatus');
});
test('a key the verb does not accept, or a value it cannot use, names the file', () => {
  setFile({ '*': { limit: 5 }, 'get-pet-by-id': { status: 'sold' } });
  const r = runtime(['petstore', 'get-pet-by-id', '7', '--dry-run']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(J(r).error, /defaults\.json sets --status for get-pet-by-id, which get-pet-by-id does not accept/);
  assert.match(J(r).error, /declick defaults petstore --verb get-pet-by-id --unset status/);
  setFile({ '*': { limit: 0 } });
  const bad = runtime(['petstore', 'get-pet-by-id', '7', '--dry-run']);
  assert.equal(bad.status, 1); assert.match(J(bad).error, /defaults\.json: --limit must be a positive integer, got 0/);
});
test('declick defaults shows, sets, unsets and clears, and previews with --dry-run', () => {
  clearFile();
  assert.deepEqual(J(run(['defaults', 'petstore'])).data, {});
  assert.match(run(['defaults', 'petstore', '--json', 'false']).stdout, /^no defaults for petstore/);
  assert.deepEqual(J(run(['defaults', 'petstore', '--set', 'limit=20', '--set', 'fields=id,name'])).data, { '*': { limit: 20, fields: 'id,name' } });
  assert.equal(existsSync(file()), true);
  assert.deepEqual(J(run(['defaults', 'petstore', '--verb', 'find-pets-by-status', '--set', 'status=sold'])).data['find-pets-by-status'], { status: 'sold' });
  assert.equal(run(['defaults', 'petstore', '--json', 'false']).stdout.trim(), '*: limit=20 fields=id,name\nfind-pets-by-status: status=sold');
  const dry = J(run(['defaults', 'petstore', '--set', 'limit=5', '--dry-run']));
  assert.equal(dry.data['*'].limit, 5); assert.equal(dry.meta.dryRun, true);
  assert.equal(J(run(['defaults', 'petstore'])).data['*'].limit, 20, '--dry-run wrote nothing');
  assert.deepEqual(J(run(['defaults', 'petstore', '--unset', 'fields'])).data['*'], { limit: 20 });
  assert.deepEqual(J(run(['defaults', 'petstore', '--verb', 'find-pets-by-status', '--clear'])).data, { '*': { limit: 20 } });
  assert.deepEqual(J(run(['defaults', 'petstore', '--clear'])).data, {});
  assert.equal(existsSync(file()), false, 'an empty file is no file');
});
test('an edit is checked against the flags the scope has', () => {
  clearFile();
  const r = run(['defaults', 'petstore', '--set', 'nope=1']);
  assert.equal(r.status, 1); assert.match(J(r).error, /^petstore has no --nope flag/);
  assert.match(J(run(['defaults', 'petstore', '--verb', 'get-pet-by-id', '--set', 'status=sold'])).error, /^petstore get-pet-by-id has no --status flag/);
  assert.equal(J(run(['defaults', 'petstore', '--set', 'status=sold'])).data['*'].status, 'sold', '* takes any verb flag');
  assert.equal(run(['defaults', 'petstore', '--verb', 'ghost', '--set', 'limit=1']).status, 2);
  assert.match(J(run(['defaults', 'petstore', '--set', 'limit'])).error, /^--set takes k=v/);
  // A key the manifest lost is exactly what --unset is for, so unset is never checked against the flags.
  setFile({ '*': { nope: 1 } });
  assert.deepEqual(J(run(['defaults', 'petstore', '--unset', 'nope'])).data, {});
  clearFile();
});
test('a value the runtime would reject is refused at set time, and a broken file is repairable', () => {
  clearFile();
  const r = run(['defaults', 'petstore', '--set', 'limit=0']);
  assert.equal(r.status, 1); assert.match(J(r).error, /--limit must be a positive integer, got 0; nothing written/);
  assert.equal(existsSync(file()), false);
  // A file edited by hand into nonsense must not take describe, lint or build down with it.
  writeFileSync(file(), '{not json');
  assert.match(run(['describe', 'petstore', '--json', 'false']).stdout, /^defaults: unreadable, run: declick defaults petstore --clear$/m);
  assert.equal(run(['lint', 'petstore']).status, 0);
  assert.equal(run(['build', 'petstore']).status, 0);
  assert.match(J(runtime(['petstore', 'get-pet-by-id', '7', '--dry-run'])).error, /is not valid JSON.*declick defaults petstore --clear/);
  assert.equal(run(['defaults', 'petstore', '--clear']).status, 0, 'the fix the message names works on a file it cannot read');
  assert.equal(existsSync(file()), false);
});
test('a rebuild does not clobber the file, and describe says the defaults are there', () => {
  assert.equal(run(['defaults', 'petstore', '--set', 'limit=20']).status, 0);
  assert.equal(run(['build', 'petstore']).status, 0);
  assert.deepEqual(J(run(['defaults', 'petstore'])).data, { '*': { limit: 20 } });
  assert.match(run(['describe', 'petstore', '--json', 'false']).stdout, /^defaults: \*: limit=20$/m);
  assert.deepEqual(J(run(['describe', 'petstore'])).data.defaults, { '*': { limit: 20 } });
  assert.match(runtime(['petstore', 'describe', '--json', 'false']).stdout, /^defaults: \*: limit=20$/m);
  clearFile();
  assert.equal(J(run(['describe', 'petstore'])).data.defaults, undefined, 'no file, no line');
});
test('a default --fields is parsed like the flag it stands for and really shapes the answer', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 1, name: 'pet-1', status: 'sold' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const spec = join(home, 'shop.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: base }],
      paths: { '/pet/{petId}': { get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }] } } } }));
    assert.equal(run(['add', spec, '--name', 'shop']).status, 0);
    setFile({ '*': { fields: 'name,status' } }, 'shop');
    const j = J(await runtimeAsync(['shop', 'get-pet', '1']));
    assert.deepEqual(j.data, { name: 'pet-1', status: 'sold' }, 'the string is split into fields, not passed whole');
    assert.deepEqual(j.meta.defaults, ['fields']);
    const own = J(await runtimeAsync(['shop', 'get-pet', '1', '--fields', 'id']));
    assert.deepEqual(own.data, { id: 1 }); assert.equal(own.meta.defaults, undefined);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
test('defaults reach every item of a batch, and an item still overrides them', () => {
  setFile({ 'find-pets-by-status': { status: 'sold' } });
  const p = join(home, 'each.ndjson'); writeFileSync(p, '{}\n{"status":"pending"}\n');
  const j = J(runtime(['petstore', 'find-pets-by-status', '--each', p, '--dry-run']));
  assert.equal(j.meta.failed, 0, JSON.stringify(j.data));
  assert.deepEqual(j.data.map(e => e.data.url.split('?')[1]), ['status=sold', 'status=pending']);
  assert.deepEqual(j.meta.defaults, ['status']);
  clearFile();
});
test('the audit line records the flags the run actually used', () => {
  setFile({ '*': { limit: 20 } });
  assert.equal(runtime(['petstore', 'get-pet-by-id', '7', '--dry-run']).status, 0);
  const last = JSON.parse(readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(last.flags.limit, 20); assert.equal(last.verb, 'get-pet-by-id');
  clearFile();
});
