import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const vault = join(mkdtempSync(join(tmpdir(), 'creds-')), 'vault.env');
writeFileSync(vault, 'PETSTORE_API_KEY=abc123\nEDGE_OAUTH=tok\nEDGE_SESSION=sess\n');
process.env.CREDS_VAULT = vault;
const { compile, execute } = await import('../src/engines/openapi.mjs');
const m = await compile('fixtures/petstore.json', { name: 'petstore' });
const stderr = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
const edge = await compile('fixtures/openapi-edge.json', { name: 'edge' });
process.stderr.write = stderr;
const clone = () => JSON.parse(JSON.stringify(edge));
const reply = (status, ct, text) => async () => ({ ok: status < 300, status, headers: { get: () => ct }, text: async () => text });

test('dry-run builds request and masks secret', async () => {
  const r = await execute(m, 'get-pet-by-id', ['7'], { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.url, 'https://petstore3.swagger.io/api/v3/pet/7');
  assert.equal(r.data.headers.api_key, '<PETSTORE_API_KEY>');
});
test('query flags become querystring', async () => {
  const r = await execute(m, 'find-pets-by-status', [], { dryRun: true, status: 'sold' });
  assert.equal(r.data.url, 'https://petstore3.swagger.io/api/v3/pet/findByStatus?status=sold');
});
test('body props assemble a JSON body', async () => {
  const r = await execute(m, 'add-pet', [], { dryRun: true, name: 'Rex', status: 'available' });
  assert.deepEqual(JSON.parse(r.data.body), { name: 'Rex', status: 'available' });
  assert.equal(r.data.method, 'POST');
});
test('missing arg is an error', async () => {
  const r = await execute(m, 'get-pet-by-id', [], { dryRun: true });
  assert.equal(r.ok, false); assert.equal(r.exit, 1);
  assert.match(r.error, /petstore describe --full/);
});
test('unknown verb is not found', async () => {
  const r = await execute(m, 'nope', [], {});
  assert.equal(r.exit, 2);
  assert.match(r.error, /run: declick describe petstore/);
});
test('missing auth is exit 4', async () => {
  process.env.CREDS_VAULT = join(tmpdir(), 'nonexistent.env');
  const r = await execute(m, 'get-pet-by-id', ['7'], {});
  assert.equal(r.exit, 4); assert.match(r.error, /PETSTORE_API_KEY/);
  process.env.CREDS_VAULT = vault;
});
test('live call uses injected fetch and unwraps json', async () => {
  const fakeFetch = async (url, init) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ id: 7, name: 'Rex', hdr: init.headers.api_key }) });
  const r = await execute(m, 'get-pet-by-id', ['7'], {}, { fetch: fakeFetch });
  assert.deepEqual(r.data, { id: 7, name: 'Rex', hdr: 'abc123' });
});

test('a bad base url names the rebuild command', async () => {
  const bad = clone(); bad.baseUrl = '/api/v3';
  const r = await execute(bad, 'list', [], { dryRun: true, status: 'open' });
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'bad base url /api/v3 for edge; run: declick build edge');
});
test('an unfilled path parameter is an error', async () => {
  const broken = clone(); broken.verbs.find(v => v.name === 'list').http.path = '/tenants/{tenantId}/items';
  const r = await execute(broken, 'list', [], { dryRun: true, status: 'open' });
  assert.equal(r.exit, 1);
  assert.match(r.error, /unfilled path parameter/);
});
test('hyphenated and renamed flags reach the wire under their real names', async () => {
  const r = await execute(edge, 'list', [], { dryRun: true, status: 'open', pageSize: 25, paramLimit: 5 });
  assert.equal(r.data.url, 'https://edge.example.com/v2/items?page-size=25&limit=5&status=open');
});
test('array query values repeat the key', async () => {
  const r = await execute(edge, 'list', [], { dryRun: true, status: ['open', 'done'] });
  assert.equal(r.data.url, 'https://edge.example.com/v2/items?status=open&status=done');
});
test('a missing required query flag names the flag', async () => {
  const r = await execute(edge, 'list', [], { dryRun: true });
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'list needs --status; run: edge describe --full');
});
test('a valueless flag on a non boolean param is an error', async () => {
  const r = await execute(edge, 'list', [], { dryRun: true, status: 'open', pageSize: true });
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'flag --page-size needs a value');
});
test('oauth2 sends a bearer token and cookie schemes send a cookie', async () => {
  const oauth = await execute(edge, 'list', [], { dryRun: true, status: 'open' });
  assert.equal(oauth.data.headers.authorization, 'Bearer <EDGE_OAUTH>');
  const cookie = await execute(edge, 'describe-op', [], { dryRun: true, title: 'Hi' });
  assert.equal(cookie.data.headers.cookie, 'sid=<EDGE_SESSION>');
  const dropped = await execute(edge, 'post-2fa-setup', [], { dryRun: true });
  assert.equal(dropped.data.headers.authorization, undefined);
});
test('a form body is urlencoded with its own content type', async () => {
  const r = await execute(edge, 'describe-op', [], { dryRun: true, title: 'Hi there', note: 'x' });
  assert.equal(r.data.body, 'title=Hi+there&note=x');
  assert.equal(r.data.headers['content-type'], 'application/x-www-form-urlencoded');
});
test('204 and empty bodies report the status only', async () => {
  const no = await execute(m, 'delete-pet', ['7'], {}, { fetch: reply(204, 'application/json', '') });
  assert.deepEqual(no, { ok: true, data: { status: 204 } });
  const empty = await execute(m, 'get-pet-by-id', ['7'], {}, { fetch: reply(200, 'application/json', '') });
  assert.deepEqual(empty.data, { status: 200 });
});
test('a non json body stays text and a failure keeps its body', async () => {
  const txt = await execute(m, 'get-pet-by-id', ['7'], {}, { fetch: reply(200, 'text/plain', 'hello') });
  assert.equal(txt.data, 'hello');
  const err = await execute(m, 'get-pet-by-id', ['7'], {}, { fetch: reply(404, 'application/json', '{"message":"gone"}') });
  assert.equal(err.exit, 2);
  assert.deepEqual(err.data, { message: 'gone' });
});
test('security alternatives: any one satisfied alternative is enough, none names them all', async () => {
  const { writeFileSync: w } = await import('node:fs');
  const spec = join(tmpdir(), `alt-${process.pid}.json`);
  w(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Alt' }, servers: [{ url: 'https://alt.test' }],
    components: { securitySchemes: { api_key: { type: 'apiKey', in: 'header', name: 'api_key' }, oauth: { type: 'oauth2', flows: {} } } },
    paths: { '/p': { get: { operationId: 'getP', summary: 'p', security: [{ api_key: [] }, { oauth: [] }] } }, '/open': { get: { operationId: 'getOpen', summary: 'o', security: [{ api_key: [] }, {}] } } } }));
  const a = await compile(spec, { name: 'alt' });
  assert.deepEqual(a.verbs[0].http.security, [['api_key'], ['oauth']]);
  const none = await execute(a, 'get-p', [], {});
  assert.equal(none.exit, 4); assert.match(none.error, /ALT_API_KEY or ALT_OAUTH/); assert.match(none.error, /vault/);
  process.env.ALT_OAUTH = 'tok';
  const r = await execute(a, 'get-p', [], {}, { fetch: async (u, init) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(init.headers) }) });
  assert.equal(r.data.authorization, 'Bearer tok'); assert.equal(r.data.api_key, undefined);
  delete process.env.ALT_OAUTH;
  const open = await execute(a, 'get-open', [], {}, { fetch: async (u, init) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(init.headers) }) });
  assert.equal(open.ok, true, open.error); assert.equal(open.data.authorization, undefined);
});
