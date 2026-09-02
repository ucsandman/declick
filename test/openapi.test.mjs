import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile } from '../src/engines/openapi.mjs';
import { lint } from '../src/lint.mjs';

const warnings = [];
const stderr = process.stderr.write.bind(process.stderr);
process.stderr.write = s => { warnings.push(s); return true; };
const edge = await compile('fixtures/openapi-edge.json', { name: 'edge' });
process.stderr.write = stderr;

test('compile petstore', async () => {
  const m = await compile('fixtures/petstore.json', { name: 'petstore' });
  assert.equal(m.engine, 'openapi');
  assert.equal(m.baseUrl, 'https://petstore3.swagger.io/api/v3');
  assert.equal(m.source, resolve('fixtures/petstore.json'));
  const names = m.verbs.map(v => v.name);
  assert.deepEqual(names, ['find-pets-by-status', 'get-pet-by-id', 'delete-pet', 'add-pet']);
  const get = m.verbs.find(v => v.name === 'get-pet-by-id');
  assert.deepEqual(get.args, [{ name: 'petId', required: true, type: 'integer' }]);
  assert.equal(get.mutating, false);
  assert.deepEqual(get.http, { method: 'get', path: '/pet/{petId}', query: [], bodyProps: [], security: [['api_key']] });
  const del = m.verbs.find(v => v.name === 'delete-pet');
  assert.equal(del.mutating, true);
  const add = m.verbs.find(v => v.name === 'add-pet');
  assert.deepEqual(add.flags.map(f => f.name), ['body', 'name', 'status']);
  assert.equal(add.http.bodyType, 'application/json');
  const find = m.verbs.find(v => v.name === 'find-pets-by-status');
  assert.deepEqual(find.flags[0], { name: 'status', description: 'available|pending|sold', required: false, type: 'string' });
  assert.deepEqual(m.auth.env, ['PETSTORE_API_KEY']);
  assert.deepEqual(lint(m), []);
});

test('server variables substitute and the trailing slash goes', () => {
  assert.equal(edge.baseUrl, 'https://edge.example.com/v2');
  assert.deepEqual(lint(edge), []);
});

test('a relative server url resolves against a url source', async () => {
  const spec = { openapi: '3.0.0', info: { title: 'Rel' }, servers: [{ url: '/api/v3' }], paths: { '/ping': { get: { operationId: 'ping', summary: 'Ping' } } } };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => spec });
  try {
    const m = await compile('https://petstore3.swagger.io/api/v3/openapi.json', { name: 'rel' });
    assert.equal(m.baseUrl, 'https://petstore3.swagger.io/api/v3');
    assert.equal(m.source, 'https://petstore3.swagger.io/api/v3/openapi.json');
  } finally { globalThis.fetch = real; }
});

test('a relative server url in a spec file fails at compile', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'declick-')), 'rel.json');
  writeFileSync(p, JSON.stringify({ info: { title: 'Rel' }, servers: [{ url: '/api/v3' }], paths: { '/ping': { get: { operationId: 'ping', summary: 'Ping' } } } }));
  await assert.rejects(() => compile(p, { name: 'rel' }), e => e.exit === 1 && /relative/.test(e.message));
});

test('$ref params resolve and path level params lose to the operation', () => {
  const list = edge.verbs.find(v => v.name === 'list');
  assert.deepEqual(list.flags.map(f => f.name), ['page-size', 'param-limit', 'status']);
  assert.deepEqual(list.flags[0], { name: 'page-size', description: 'rows per page', required: false, type: 'integer' });
  assert.deepEqual(list.flags[1], { name: 'param-limit', description: 'max rows', required: false, type: 'integer', wire: 'limit' });
  assert.deepEqual(list.flags[2], { name: 'status', description: 'one or more states', required: true, type: 'array' });
  assert.deepEqual(edge.verbs.find(v => v.name === 'get-items-id').args, [{ name: 'id', required: true, type: 'string' }]);
});

test('unsupported schemes are dropped with a warning', () => {
  assert.deepEqual(edge.auth.env, ['EDGE_OAUTH', 'EDGE_SESSION']);
  assert.equal(edge.auth.schemes.mtls, undefined);
  assert.ok(warnings.includes('skipping unsupported security scheme mtls (mutualTLS)\n'), warnings.join(''));
});

test('a body schema with properties but no type still yields flags', () => {
  const post = edge.verbs.find(v => v.name === 'describe-op');
  assert.equal(post.http.bodyType, 'application/x-www-form-urlencoded');
  assert.deepEqual(post.flags.map(f => f.name), ['page-size', 'param-limit', 'body', 'title', 'note']);
  assert.deepEqual(post.http.bodyProps, ['title', 'note']);
  assert.deepEqual(post.flags.find(f => f.name === 'title'), { name: 'title', description: 'item title', required: true, type: 'string' });
});

test('names are derived, deduped and never collide with describe', () => {
  assert.deepEqual(edge.verbs.map(v => v.name), ['list', 'describe-op', 'list-users', 'list-2', 'get-items-id', 'post-2fa-setup']);
});

test('verbs and tag filters narrow the manifest', async () => {
  const byVerb = await compile('fixtures/openapi-edge.json', { name: 'edge', verbs: 'list, get-items-id' });
  assert.deepEqual(byVerb.verbs.map(v => v.name), ['list', 'get-items-id']);
  const byTag = await compile('fixtures/openapi-edge.json', { name: 'edge', tag: 'users' });
  assert.deepEqual(byTag.verbs.map(v => v.name), ['list-users', 'list-2']);
  await assert.rejects(() => compile('fixtures/openapi-edge.json', { name: 'edge', verbs: ['nope'] }),
    e => e.exit === 1 && /available: list, describe-op/.test(e.message));
});
