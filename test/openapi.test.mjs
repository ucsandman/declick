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
  // A spec url is read as text now, because the same url may serve yaml.
  globalThis.fetch = async () => ({ ok: true, json: async () => spec, text: async () => JSON.stringify(spec) });
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

test('a $ref path parameter and a $ref query parameter resolve with no stderr', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'declick-')), 'refs.json');
  writeFileSync(p, JSON.stringify({
    openapi: '3.0.0', info: { title: 'Refs' }, servers: [{ url: 'https://refs.test' }],
    paths: { '/providers/{provider}': {
      parameters: [{ $ref: '#/components/parameters/Provider' }],
      get: { operationId: 'getProvider', parameters: [{ $ref: '#/components/parameters/Limit' }], responses: {} },
    } },
    components: { parameters: {
      Provider: { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } },
    } },
  }));
  const seen = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = s => { seen.push(s); return true; };
  let m;
  try { m = await compile(p, { name: 'refs' }); } finally { process.stderr.write = real; }
  assert.deepEqual(m.verbs[0].args, [{ name: 'provider', required: true, type: 'string' }]);
  assert.ok(m.verbs[0].flags.some(f => f.wire === 'limit'));
  assert.deepEqual(seen, []);
  assert.deepEqual(lint(m), []);
});

test('a $ref parameter that does not resolve is dropped silently and counted, never printed as undefined', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'declick-')), 'dangling.json');
  writeFileSync(p, JSON.stringify({
    openapi: '3.0.0', info: { title: 'Dangling' }, servers: [{ url: 'https://dangling.test' }],
    paths: { '/items': { get: { operationId: 'listItems', parameters: [{ $ref: '#/components/parameters/Missing' }], responses: {} } } },
    components: { parameters: {} },
  }));
  const seen = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = s => { seen.push(s); return true; };
  let m;
  try { m = await compile(p, { name: 'dangling' }); } finally { process.stderr.write = real; }
  assert.deepEqual(m.verbs[0].args, []);
  assert.deepEqual(m.verbs[0].flags, []);
  assert.ok(!seen.some(s => /undefined/.test(s)), seen.join(''));
  assert.ok(seen.some(s => /list-items: skipping 1 parameter that could not be resolved/.test(s)), seen.join(''));
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
  assert.deepEqual(edge.verbs.map(v => v.name), ['list', 'describe-op', 'list-users', 'list-2', 'get-items-id', 'post-2fa-setup', 'get-report', 'upload', 'create-order']);
});

test('every server is recorded, the first one is the base and alternates keep their description', () => {
  assert.deepEqual(edge.servers, [{ url: 'https://edge.example.com/v2' }, { url: 'https://sandbox.edge.example.com/v2', description: 'sandbox' }]);
  assert.equal(edge.baseUrl, edge.servers[0].url);
});

test('header and cookie parameters compile with their location and an unhandled one warns', () => {
  const r = edge.verbs.find(v => v.name === 'get-report');
  assert.deepEqual(r.flags.map(f => f.name), ['format', 'page', 'x-trace-id', 'region']);
  assert.deepEqual(r.flags.find(f => f.name === 'x-trace-id'), { name: 'x-trace-id', description: 'trace id', required: false, type: 'string', in: 'header', wire: 'X-Trace-Id' });
  assert.deepEqual(r.flags.find(f => f.name === 'region'), { name: 'region', description: 'data region', required: false, type: 'string', in: 'cookie' });
  assert.ok(warnings.includes('get-report: skipping parameter shard in matrix; declick sends path, query, header and cookie\n'), warnings.join(''));
  assert.ok(!r.flags.some(f => /accept/i.test(f.name)), 'accept, content-type and authorization are not parameters');
});

test('enum, default and example survive onto flags', () => {
  const fmt = edge.verbs.find(v => v.name === 'get-report').flags.find(f => f.name === 'format');
  assert.deepEqual(fmt, { name: 'format', description: '', required: false, type: 'string', enum: ['pdf', 'csv'], default: 'pdf', example: 'csv' });
});

test('nested body properties become dotted flags and binary parts keep their format', () => {
  const order = edge.verbs.find(v => v.name === 'create-order');
  assert.deepEqual(order.flags.map(f => f.name), ['body', 'qty', 'paid', 'tags', 'address.city', 'address.zip']);
  assert.deepEqual(order.flags.find(f => f.name === 'qty'), { name: 'qty', description: 'how many', required: true, type: 'integer', default: 1 });
  assert.equal(order.flags.find(f => f.name === 'address.city').required, true);
  assert.equal(order.flags.find(f => f.name === 'address.zip').required, false);
  assert.equal(order.http.bodyType, 'application/json');
  assert.deepEqual(order.http.bodyTypes, ['application/json', 'application/x-www-form-urlencoded']);
  const up = edge.verbs.find(v => v.name === 'upload');
  assert.equal(up.http.bodyType, 'multipart/form-data');
  assert.equal(up.http.bodyTypes, undefined, 'one declared type needs no list');
  assert.deepEqual(up.flags.find(f => f.name === 'file'), { name: 'file', description: '', required: true, type: 'string', format: 'binary' });
});

test('a swagger 2.0 spec converts to openapi 3 and compiles', async () => {
  const m = await compile('fixtures/swagger2.json', { name: 'legacy' });
  assert.equal(m.baseUrl, 'https://legacy.example.com/v1');
  assert.deepEqual(m.servers.map(s => s.url), ['https://legacy.example.com/v1', 'http://legacy.example.com/v1']);
  assert.deepEqual(m.auth.env, ['LEGACY_API_KEY']);
  assert.deepEqual(m.auth.schemes.api_key, { type: 'apiKey', in: 'header', name: 'X-Api-Key', env: 'LEGACY_API_KEY' });
  const list = m.verbs.find(v => v.name === 'list-things');
  assert.deepEqual(list.args, []);
  assert.deepEqual(list.flags, [{ name: 'status', description: 'filter', required: false, type: 'string', enum: ['open', 'done'], default: 'open' }]);
  assert.deepEqual(list.returns, { shape: 'array', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }] });
  const add = m.verbs.find(v => v.name === 'add-thing');
  assert.equal(add.http.bodyType, 'application/json');
  assert.deepEqual(add.flags.map(f => f.name), ['body', 'name', 'note']);
  assert.equal(add.flags.find(f => f.name === 'name').required, true);
  const up = m.verbs.find(v => v.name === 'upload-thing');
  assert.equal(up.http.bodyType, 'multipart/form-data');
  assert.deepEqual(up.args, [{ name: 'id', required: true, type: 'string' }]);
  assert.deepEqual(up.flags.find(f => f.name === 'file'), { name: 'file', description: 'the file', required: true, type: 'string', format: 'binary' });
  assert.deepEqual(lint(m), []);
});

test('an unmappable swagger 2.0 construct names the construct', async () => {
  const { toOpenApi3 } = await import('../src/engines/swagger2.mjs');
  assert.throws(() => toOpenApi3({ swagger: '2.0', info: { title: 'x' }, host: 'h', securityDefinitions: { weird: { type: 'oauth2', flow: 'magic' } }, paths: {} }, 'x.json'),
    e => e.exit === 1 && /oauth2 flow magic/.test(e.message));
  assert.throws(() => toOpenApi3({ swagger: '2.0', info: { title: 'x' }, host: 'h', paths: { '/p': { get: { operationId: 'p', parameters: [{ name: 'm', in: 'matrix' }] } } } }, 'x.json'),
    e => e.exit === 1 && /matrix/.test(e.message));
  assert.throws(() => toOpenApi3({ openapi: '3.0.0' }, 'x.json'), e => e.exit === 1 && /is not 2\.x/.test(e.message));
});

test('verbs and tag filters narrow the manifest', async () => {
  const byVerb = await compile('fixtures/openapi-edge.json', { name: 'edge', verbs: 'list, get-items-id' });
  assert.deepEqual(byVerb.verbs.map(v => v.name), ['list', 'get-items-id']);
  const byTag = await compile('fixtures/openapi-edge.json', { name: 'edge', tag: 'users' });
  assert.deepEqual(byTag.verbs.map(v => v.name), ['list-users', 'list-2']);
  await assert.rejects(() => compile('fixtures/openapi-edge.json', { name: 'edge', verbs: ['nope'] }),
    e => e.exit === 1 && /available: list, describe-op/.test(e.message));
});

test('compiled returns carry the response shape, its rows path and its fields', () => {
  const fields = [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'status', type: 'string' }];
  assert.deepEqual(edge.verbs.find(v => v.name === 'list').returns, { shape: 'object', rowsPath: 'items', fields });
  assert.deepEqual(edge.verbs.find(v => v.name === 'list-users').returns, { shape: 'array', fields });
  assert.deepEqual(edge.verbs.find(v => v.name === 'get-items-id').returns, { shape: 'object', fields });
  assert.deepEqual(edge.verbs.find(v => v.name === 'post-2fa-setup').returns, { shape: 'none', fields: [] });
});

test('a wide response caps its fields at 30 and a scalar body has none', async () => {
  const props = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: 'string' }]));
  const json = schema => ({ '200': { content: { 'application/json': { schema } } } });
  const p = join(mkdtempSync(join(tmpdir(), 'declick-')), 'wide.json');
  writeFileSync(p, JSON.stringify({ openapi: '3.0.0', info: { title: 'Wide' }, servers: [{ url: 'https://wide.test' }], paths: {
    '/wide': { get: { operationId: 'wide', summary: 'Wide', responses: json({ type: 'object', properties: props }) } },
    '/count': { get: { operationId: 'count', summary: 'Count', responses: json({ type: 'integer' }) } },
    '/blob': { get: { operationId: 'blob', summary: 'Blob', responses: { '200': { content: { 'application/octet-stream': {} } } } } },
  } }));
  const m = await compile(p, { name: 'wide' });
  const wide = m.verbs.find(v => v.name === 'wide').returns;
  assert.equal(wide.fields.length, 30); assert.equal(wide.truncated, true); assert.equal(wide.rowsPath, undefined);
  assert.deepEqual(m.verbs.find(v => v.name === 'count').returns, { shape: 'scalar', fields: [] });
  assert.deepEqual(m.verbs.find(v => v.name === 'blob').returns, { shape: 'none', fields: [] });
  assert.deepEqual(lint(m), []);
});

test('a spec parameter named rows is renamed like every other contract flag', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'declick-')), 'rows.json');
  writeFileSync(p, JSON.stringify({ openapi: '3.0.0', info: { title: 'Rows' }, servers: [{ url: 'https://rows.test' }],
    paths: { '/r': { get: { operationId: 'listR', summary: 'List r', parameters: [{ name: 'rows', in: 'query', schema: { type: 'integer' } }] } } } }));
  const m = await compile(p, { name: 'rows' });
  assert.deepEqual(m.verbs[0].flags, [{ name: 'param-rows', description: '', required: false, type: 'integer', wire: 'rows' }]);
  assert.deepEqual(lint(m), []);
  assert.ok(lint({ ...m, verbs: [{ ...m.verbs[0], flags: [{ name: 'rows' }] }] }).some(e => /--rows collides/.test(e)));
});

test('a yaml spec compiles to the same adapter as the json one, keeping its own path', async () => {
  const y = await compile('fixtures/petstore.yaml', { name: 'petstore' });
  const j = await compile('fixtures/petstore.json', { name: 'petstore' });
  assert.equal(y.source, resolve('fixtures/petstore.yaml'));
  assert.deepEqual({ ...y, source: null, builtAt: null }, { ...j, source: null, builtAt: null });
  assert.deepEqual(lint(y), []);
});

test('mutating comes from the method, and lint refuses a manifest that lowered it', async () => {
  const m = await compile('fixtures/petstore.json', { name: 'petstore' });
  assert.deepEqual(m.verbs.map(v => [v.name, v.mutating]),
    [['find-pets-by-status', false], ['get-pet-by-id', false], ['delete-pet', true], ['add-pet', true]]);
  const lowered = { ...m, verbs: m.verbs.map(v => (v.name === 'delete-pet' ? { ...v, mutating: false } : v)) };
  assert.ok(lint(lowered).some(e => /delete-pet: mutating false, but DELETE changes state/.test(e)), JSON.stringify(lint(lowered)));
  const alsoLowered = { ...m, verbs: m.verbs.map(v => (v.name === 'add-pet' ? { ...v, mutating: false } : v)) };
  assert.ok(lint(alsoLowered).some(e => /add-pet: mutating false, but POST changes state/.test(e)));
  // Raising is always allowed: a read that costs money or rate limit may declare itself mutating.
  const raised = { ...m, verbs: m.verbs.map(v => (v.name === 'get-pet-by-id' ? { ...v, mutating: true } : v)) };
  assert.deepEqual(lint(raised), []);
});
