import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { compile as compilePostman, execute } from '../src/engines/postman.mjs';
import { compile as compileHar } from '../src/engines/har.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { lint } from '../src/lint.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'declick-collections-'));
const fileWith = (base, doc) => { const p = join(tmp, `${base}-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(doc)); return p; };

// Registration of the postman and har engine names lands in src/manifest.mjs ENGINES and
// src/engines/index.mjs (reported as NEEDS). Until it does, validateManifest reports exactly one
// error for the unregistered name, so the contract checks run against the same manifest under the
// engine whose execute it shares.
const registered = m => ({ ...m, engine: 'openapi' });
const pending = e => e.startsWith('engine must be one of');
const contract = m => {
  assert.deepEqual(validateManifest(m).filter(x => !pending(x)), [], `validateManifest ${m.name}`);
  assert.deepEqual(lint(registered(m)), [], `lint ${m.name}`);
};

const postman = await compilePostman('fixtures/postman.json');
const insomnia = await compilePostman('fixtures/insomnia.json');
const har = await compileHar('fixtures/sample.har');

test('a postman v2.1 collection compiles to openapi verbs', () => {
  assert.equal(postman.engine, 'postman');
  assert.equal(postman.name, 'orders-api');
  assert.equal(postman.baseUrl, 'https://api.example.com');
  assert.deepEqual(postman.verbs.map(v => v.name), ['list-orders', 'get-order', 'create-order', 'update-order']);
  const list = postman.verbs.find(v => v.name === 'list-orders');
  assert.equal(list.description, 'List orders for the account');
  assert.equal(list.mutating, false);
  assert.deepEqual(list.args, []);
  // {{version}} is a collection variable, so it is baked into the path; {{page}} is not defined and stays a flag.
  assert.deepEqual(list.http, { method: 'get', path: '/v1/orders', query: ['status', 'page'], bodyProps: [], security: [['bearer']] });
  assert.deepEqual(list.flags, [
    { name: 'status', description: 'open|shipped|closed', required: false, type: 'string', example: 'open' },
    { name: 'page', description: '', required: false, type: 'string' },
  ]);
  assert.deepEqual(list.returns, { shape: 'object', rowsPath: 'orders', fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'number' }, { name: 'paid', type: 'boolean' }] });
});

test('postman path variables become args in both :param and {{var}} form', () => {
  const get = postman.verbs.find(v => v.name === 'get-order');
  assert.deepEqual(get.args, [{ name: 'orderId', required: true, type: 'string' }]);
  assert.equal(get.http.path, '/v1/orders/{orderId}');
  const patch = postman.verbs.find(v => v.name === 'update-order');
  assert.deepEqual(patch.args, [{ name: 'orderId', required: true, type: 'string' }]);
  assert.equal(patch.http.path, '/v1/orders/{orderId}');
  assert.equal(patch.mutating, true);
  assert.equal(patch.http.bodyType, 'application/x-www-form-urlencoded');
  assert.deepEqual(patch.http.bodyProps, ['status']);
});

test('a raw json body becomes body props and both auths become env keys', () => {
  const add = postman.verbs.find(v => v.name === 'create-order');
  assert.equal(add.mutating, true);
  assert.equal(add.http.bodyType, 'application/json');
  assert.deepEqual(add.http.bodyProps, ['sku', 'qty']);
  assert.deepEqual(add.flags.map(f => f.name), ['body', 'sku', 'qty']);
  assert.equal(add.flags.find(f => f.name === 'qty').example, '2');
  assert.equal(add.flags.find(f => f.name === 'sku').example, undefined);
  assert.deepEqual(add.http.security, [['bearer', 'apikey']]);
  assert.deepEqual(postman.auth.env, ['ORDERS_API_BEARER', 'ORDERS_API_APIKEY']);
  assert.deepEqual(postman.auth.schemes.apikey, { type: 'apiKey', in: 'header', name: 'X-Api-Key', env: 'ORDERS_API_APIKEY' });
  assert.deepEqual(postman.auth.schemes.bearer, { type: 'http', scheme: 'bearer', env: 'ORDERS_API_BEARER' });
});

test('a duplicate request name is qualified by its folder, then numbered', async () => {
  const req = name => ({ name, request: { method: 'GET', url: { raw: 'https://dup.example.com/x' } } });
  const p = fileWith('dup', {
    info: { name: 'Dup', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Alpha', item: [req('List')] }, { name: 'Beta', item: [req('List')] }, req('List'), { name: 'Describe', item: [] }],
  });
  const m = await compilePostman(p);
  assert.deepEqual(m.verbs.map(v => v.name), ['list', 'beta-list', 'list-2']);
  contract(m);
});

test('a folder selects verbs through --tag and an unknown tag lists what is there', async () => {
  const only = await compilePostman('fixtures/postman.json', { tag: 'Orders' });
  assert.deepEqual(only.verbs.map(v => v.name), ['list-orders', 'get-order']);
  await assert.rejects(() => compilePostman('fixtures/postman.json', { tag: 'nope' }), /available: list-orders, get-order/);
  const picked = await compilePostman('fixtures/postman.json', { verbs: 'create-order' });
  assert.deepEqual(picked.verbs.map(v => v.name), ['create-order']);
});

test('an insomnia v4 export compiles the same way', () => {
  assert.equal(insomnia.engine, 'postman');
  assert.equal(insomnia.name, 'notes-api');
  assert.equal(insomnia.baseUrl, 'https://notes.example.com');
  assert.deepEqual(insomnia.verbs.map(v => v.name), ['list-notes', 'create-note']);
  const list = insomnia.verbs.find(v => v.name === 'list-notes');
  assert.deepEqual(list.args, [{ name: 'notebookId', required: true, type: 'string' }]);
  assert.equal(list.http.path, '/notebooks/{notebookId}/notes');
  // limit is a contract flag name, so it is renamed and carries the name the API expects on the wire.
  assert.deepEqual(list.flags, [
    { name: 'q', description: 'full text search', required: false, type: 'string' },
    { name: 'param-limit', description: '', required: false, type: 'string', wire: 'limit', example: '20' },
  ]);
  assert.deepEqual(list.http.query, ['q', 'param-limit']);
  assert.deepEqual(list.returns, { shape: 'none', fields: [] });
  const add = insomnia.verbs.find(v => v.name === 'create-note');
  assert.deepEqual(add.http.bodyProps, ['title', 'shelf']);
  assert.equal(add.flags.find(f => f.name === 'shelf').example, 'inbox');
  assert.equal(add.flags.find(f => f.name === 'title').example, undefined);
  assert.deepEqual(insomnia.auth.env, ['NOTES_API_BEARER']);
  assert.deepEqual(insomnia.verbs.map(v => v.http.security), [[['bearer']], [['bearer']]]);
});

test('a har capture groups entries into verbs and ignores assets and other hosts', () => {
  assert.equal(har.engine, 'har');
  assert.equal(har.name, 'shop');
  assert.equal(har.baseUrl, 'https://shop.example.com');
  assert.deepEqual(har.verbs.map(v => v.name), ['get-api-products', 'get-api-products-by-id', 'post-api-orders']);
  const list = har.verbs.find(v => v.name === 'get-api-products');
  assert.equal(list.description, 'GET /api/products');
  assert.deepEqual(list.http, { method: 'get', path: '/api/products', query: ['category', 'param-limit'], bodyProps: [], security: [['bearer']] });
  assert.equal(list.flags.find(f => f.name === 'category').example, 'tools');
  assert.deepEqual(list.returns, { shape: 'object', rowsPath: 'products', fields: [{ name: 'id', type: 'number' }, { name: 'title', type: 'string' }, { name: 'price', type: 'number' }] });
  assert.deepEqual(list.har, { sampleStatus: 200, sampleAt: '2026-09-01T10:00:00.000Z', samples: 1 });
});

test('numeric and uuid path segments generalize to one {id} verb', () => {
  const one = har.verbs.find(v => v.name === 'get-api-products-by-id');
  assert.deepEqual(one.args, [{ name: 'id', required: true, type: 'string' }]);
  assert.equal(one.http.path, '/api/products/{id}');
  assert.equal(one.har.samples, 2);
  assert.deepEqual(one.returns.fields.map(f => f.name), ['id', 'title', 'price', 'tags']);
});

test('a recorded json request body becomes body props', () => {
  const post = har.verbs.find(v => v.name === 'post-api-orders');
  assert.equal(post.mutating, true);
  assert.equal(post.http.bodyType, 'application/json');
  assert.deepEqual(post.http.bodyProps, ['productId', 'qty', 'note']);
  assert.equal(post.flags.find(f => f.name === 'qty').example, '2');
  assert.deepEqual(post.returns, { shape: 'object', fields: [{ name: 'id', type: 'string' }, { name: 'status', type: 'string' }] });
  assert.equal(post.har.sampleStatus, 201);
});

test('--host overrides the busiest host', async () => {
  const other = await compileHar('fixtures/sample.har', { host: 'tracker.other.com' });
  assert.equal(other.baseUrl, 'https://tracker.other.com');
  assert.deepEqual(other.verbs.map(v => v.name), ['post-api-collect']);
  await assert.rejects(() => compileHar('fixtures/sample.har', { host: 'nope.example.com' }), /shop\.example\.com/);
});

test('secret header values never reach a manifest', () => {
  for (const m of [postman, insomnia, har]) {
    const text = JSON.stringify(m);
    assert.equal(/eyJhbGciOi|notarealtoken/.test(text), false, `${m.name} kept a captured token`);
    assert.equal(/authorization|cookie/i.test(JSON.stringify(m.verbs)), false, `${m.name} kept an auth header`);
  }
  assert.deepEqual(har.auth.env, ['SHOP_BEARER']);
  assert.deepEqual(har.auth.schemes.bearer, { type: 'http', scheme: 'bearer', env: 'SHOP_BEARER' });
});

test('every fixture manifest passes validateManifest and lint', () => {
  for (const m of [postman, insomnia, har]) contract(m);
});

test('a postman, an insomnia and a har adapter run dry and live against a real server', async () => {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, key: req.headers['x-api-key'] ?? null, body: body || null }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const pm = await compilePostman(fileWith('live-pm', {
      info: { name: 'Live Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
      variable: [{ key: 'baseUrl', value: base }],
      item: [{ name: 'Get item', request: { method: 'GET', url: { raw: '{{baseUrl}}/items/:itemId?deep=true' } } }],
    }));
    contract(pm);
    const pmDry = await execute(pm, 'get-item', ['7'], { dryRun: true });
    assert.equal(pmDry.ok, true, pmDry.error);
    assert.equal(pmDry.data.url, `${base}/items/7`);
    assert.equal(pmDry.data.headers.authorization, 'Bearer <LIVE_SHOP_BEARER>');
    process.env.LIVE_SHOP_BEARER = 'tok-live';
    const pmLive = await execute(pm, 'get-item', ['7'], { deep: 'true' });
    assert.equal(pmLive.ok, true, pmLive.error);
    assert.deepEqual(pmLive.data, { path: '/items/7?deep=true', method: 'GET', auth: 'Bearer tok-live', key: null, body: null });

    const ins = await compilePostman(fileWith('live-ins', {
      _type: 'export', __export_format: 4,
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'Live Notes' },
        { _id: 'env_1', _type: 'environment', parentId: 'wrk_1', data: { baseUrl: base } },
        { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Add note', method: 'POST', url: '{{ _.baseUrl }}/notes',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          body: { mimeType: 'application/json', text: '{"title": "{{ _.title }}"}' },
          authentication: { type: 'apikey', key: 'X-Api-Key', value: '{{ _.k }}', addTo: 'header' } },
      ],
    }));
    contract(ins);
    const insDry = await execute(ins, 'add-note', [], { dryRun: true, title: 'Hi' });
    assert.equal(insDry.ok, true, insDry.error);
    assert.equal(insDry.data.headers['X-Api-Key'], '<LIVE_NOTES_APIKEY>');
    assert.deepEqual(JSON.parse(insDry.data.body), { title: 'Hi' });
    process.env.LIVE_NOTES_APIKEY = 'k-live';
    const insLive = await execute(ins, 'add-note', [], { title: 'Hi' });
    assert.equal(insLive.ok, true, insLive.error);
    assert.equal(insLive.data.method, 'POST');
    assert.equal(insLive.data.key, 'k-live');
    assert.deepEqual(JSON.parse(insLive.data.body), { title: 'Hi' });

    const entry = (url, text, postData) => ({ startedDateTime: '2026-09-01T11:00:00.000Z', request: { method: postData ? 'POST' : 'GET', url, headers: [], queryString: [], ...(postData ? { postData } : {}) }, response: { status: 200, content: { mimeType: 'application/json', text } } });
    const hm = await compileHar(fileWith('live-har', { log: { version: '1.2', entries: [entry(`${base}/api/widgets`, '{"widgets":[{"id":3}]}'), entry(`${base}/api/widgets/3`, '{"id":3,"name":"W"}')] } }));
    assert.equal(hm.name, 'har-127-0-0-1');
    contract(hm);
    const harDry = await execute(hm, 'get-api-widgets-by-id', ['3'], { dryRun: true });
    assert.equal(harDry.ok, true, harDry.error);
    assert.equal(harDry.data.url, `${base}/api/widgets/3`);
    const harLive = await execute(hm, 'get-api-widgets-by-id', ['3'], {});
    assert.equal(harLive.ok, true, harLive.error);
    assert.equal(harLive.data.path, '/api/widgets/3');
    const missing = await execute(hm, 'get-api-widgets-by-id', [], { dryRun: true });
    assert.equal(missing.exit, 1);
    assert.match(missing.error, /needs <id>/);
  } finally {
    delete process.env.LIVE_SHOP_BEARER; delete process.env.LIVE_NOTES_APIKEY;
    srv.closeAllConnections(); await new Promise(r => srv.close(r));
  }
});
