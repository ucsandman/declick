import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
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
const reply = (status, ct, text) => async () => ({ ok: status < 300, status, headers: new Headers({ 'content-type': ct }), text: async () => text });
const tmp = mkdtempSync(join(tmpdir(), 'declick-req-'));

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
  assert.match(r.error, /run: declick describe petstore --verb get-pet-by-id/);
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
  const fakeFetch = async (url, init) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ id: 7, name: 'Rex', hdr: init.headers.api_key }) });
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
  assert.equal(r.error, 'list needs --status; run: declick describe edge --verb list');
});
test('a valueless flag on a non boolean param is an error', async () => {
  const r = await execute(edge, 'list', [], { dryRun: true, status: 'open', pageSize: true });
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'flag --page-size needs a value; run: declick describe edge --verb list');
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
  assert.deepEqual(no, { ok: true, data: { status: 204 }, meta: { status: 204 } });
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
  const r = await execute(a, 'get-p', [], {}, { fetch: async (u, init) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(init.headers) }) });
  assert.equal(r.data.authorization, 'Bearer tok'); assert.equal(r.data.api_key, undefined);
  delete process.env.ALT_OAUTH;
  const open = await execute(a, 'get-open', [], {}, { fetch: async (u, init) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(init.headers) }) });
  assert.equal(open.ok, true, open.error); assert.equal(open.data.authorization, undefined);
});

test('the runtime unwraps a paged body end to end and keeps the cursor in meta', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'declick-'));
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], next: 'c2' })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const row = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } };
  const spec = join(home, 'pager.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Pager' }, servers: [{ url: `http://127.0.0.1:${srv.address().port}` }], paths: { '/rows': { get: { operationId: 'listRows', summary: 'List rows',
    responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: row }, next: { type: 'string' } } } } } } } } } } }));
  const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills'), OPENCLAW_SKILLS: '', DECLICK_GUARD: '', DASHCLAW_API_KEY: '', DASHCLAW_URL: '' };
  const go = (bin, args) => new Promise(done => { const c = spawn(process.execPath, [bin, ...args], { env }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => done({ status, stdout, stderr })); });
  try {
    const add = await go('bin/declick.mjs', ['add', spec, '--name', 'pagedrows']);
    assert.equal(add.status, 0, add.stderr);
    const r = await go('bin/run.mjs', ['pagedrows', 'list-rows', '--limit', '1', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.data, [{ id: 'a', name: 'A' }]);
    assert.equal(j.meta.rows, 'items'); assert.equal(j.meta.count, 2); assert.equal(j.meta.truncated, true);
    assert.deepEqual(j.meta.extra, { next: 'c2' });
    const whole = JSON.parse((await go('bin/run.mjs', ['pagedrows', 'list-rows', '--rows', 'next', '--json'])).stdout);
    assert.equal(whole.ok, false); assert.equal(whole.exit, 1); assert.match(whole.error, /no rows array at next; available: items, next/);
    const desc = await go('bin/run.mjs', ['pagedrows', 'describe', '--full', '--rows', 'items']);
    assert.equal(desc.status, 0, desc.stderr);
    assert.match(JSON.parse(desc.stdout).data.verbs[0].returns.rowsPath, /^items$/);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('body values are coerced from their declared types and dotted flags nest', async () => {
  const r = await execute(edge, 'create-order', [], { dryRun: true, qty: '3', paid: 'true', tags: '["a","b"]', 'address.city': 'Oslo', 'address.zip': '0150' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.data.body), { qty: 3, paid: true, tags: ['a', 'b'], address: { city: 'Oslo', zip: '0150' } });
});
test('a body value that is not its declared type never leaves the machine', async () => {
  const bad = await execute(edge, 'create-order', [], { dryRun: true, qty: 'lots', 'address.city': 'Oslo' });
  assert.equal(bad.exit, 1);
  assert.equal(bad.error, '--qty must be integer, got "lots"; run: declick describe edge --verb create-order');
  const json = await execute(edge, 'create-order', [], { dryRun: true, qty: '1', tags: 'a,b', 'address.city': 'Oslo' });
  assert.equal(json.exit, 1);
  assert.match(json.error, /^--tags must be array JSON/);
  assert.match(json.error, /run: declick describe edge --verb create-order$/);
});
test('--body reads a file with @, --body-file is the alias, and bad json is exit 1', async () => {
  const p = join(tmp, 'body.json');
  writeFileSync(p, '{"qty":9}');
  assert.equal((await execute(edge, 'create-order', [], { dryRun: true, body: `@${p}` })).data.body, '{"qty":9}');
  assert.equal((await execute(edge, 'create-order', [], { dryRun: true, bodyFile: p })).data.body, '{"qty":9}');
  writeFileSync(p, 'not json');
  const bad = await execute(edge, 'create-order', [], { dryRun: true, body: `@${p}` });
  assert.equal(bad.exit, 1); assert.match(bad.error, /--body is not valid application\/json/);
  const gone = await execute(edge, 'create-order', [], { dryRun: true, body: '@no-such-file.json' });
  assert.equal(gone.exit, 1); assert.match(gone.error, /cannot read no-such-file\.json/);
});
test('multipart attaches the file part under its basename with a real boundary', async () => {
  const p = join(tmp, 'up.txt');
  writeFileSync(p, 'hello bytes');
  const r = await execute(edge, 'upload', [], { dryRun: true, file: `@${p}`, label: 'first' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.data.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(r.data.body, new RegExp(`name="file"; filename="${basename(p)}"`));
  assert.match(r.data.body, /hello bytes/);
  assert.match(r.data.body, /name="label"[\s\S]*first/);
});
test('--content-type picks among the declared body types and rejects an undeclared one', async () => {
  const form = await execute(edge, 'create-order', [], { dryRun: true, contentType: 'application/x-www-form-urlencoded', qty: '2', 'address.city': 'Oslo' });
  assert.equal(form.data.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(form.data.body, 'qty=2&address=%7B%22city%22%3A%22Oslo%22%7D');
  const nope = await execute(edge, 'create-order', [], { dryRun: true, contentType: 'application/xml', qty: '2' });
  assert.equal(nope.exit, 1); assert.match(nope.error, /application\/xml is not declared/);
});
test('header and cookie parameters are sent and --header works on every verb', async () => {
  const r = await execute(edge, 'get-report', ['r1'], { dryRun: true, xTraceId: 'tr-1', region: 'eu', header: ['X-One: 1', 'X-Two: 2'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.url, 'https://edge.example.com/v2/reports/r1');
  assert.equal(r.data.headers['x-trace-id'], 'tr-1');
  assert.equal(r.data.headers.cookie, 'region=eu');
  assert.equal(r.data.headers['x-one'], '1'); assert.equal(r.data.headers['x-two'], '2');
  const secret = await execute(edge, 'get-report', ['r1'], { dryRun: true, header: 'X-Api-Key: shhh' });
  assert.equal(secret.data.headers['x-api-key'], '***');
  const bad = await execute(edge, 'get-report', ['r1'], { dryRun: true, header: 'nope' });
  assert.equal(bad.exit, 1); assert.match(bad.error, /--header must be 'Name: value'/);
});
test('positionals and query values are checked locally, on dry runs too', async () => {
  const e1 = await execute(edge, 'get-report', ['r1'], { dryRun: true, format: 'xml' });
  assert.equal(e1.exit, 1);
  assert.equal(e1.error, '--format must be one of pdf|csv, got xml; run: declick describe edge --verb get-report');
  const e2 = await execute(edge, 'get-report', ['r1'], { dryRun: true, page: 'two' });
  assert.equal(e2.error, '--page must be integer, got "two"; run: declick describe edge --verb get-report');
  const e3 = await execute(m, 'get-pet-by-id', ['abc'], { dryRun: true });
  assert.equal(e3.exit, 1);
  assert.equal(e3.error, '<petId> must be integer, got "abc"; run: declick describe petstore --verb get-pet-by-id');
  assert.equal((await execute(edge, 'get-report', ['r1'], { dryRun: true, format: 'csv', page: '2' })).ok, true);
});
test('--base-url, --server and the env override replace the compiled base', async () => {
  const b = await execute(edge, 'list', [], { dryRun: true, status: 'open', baseUrl: 'http://127.0.0.1:9999/api' });
  assert.equal(b.data.url, 'http://127.0.0.1:9999/api/items?status=open');
  assert.equal((await execute(edge, 'list', [], { dryRun: true, status: 'open', server: 'sandbox' })).data.url, 'https://sandbox.edge.example.com/v2/items?status=open');
  assert.equal((await execute(edge, 'list', [], { dryRun: true, status: 'open', server: '1' })).data.url, 'https://sandbox.edge.example.com/v2/items?status=open');
  const nope = await execute(edge, 'list', [], { dryRun: true, status: 'open', server: '7' });
  assert.equal(nope.exit, 1); assert.match(nope.error, /no server 7 for edge/);
  process.env.DECLICK_EDGE_BASE_URL = 'https://env.example.com/v9';
  try { assert.equal((await execute(edge, 'list', [], { dryRun: true, status: 'open' })).data.url, 'https://env.example.com/v9/items?status=open'); }
  finally { delete process.env.DECLICK_EDGE_BASE_URL; }
});
test('--curl returns a runnable line with the secret masked as its env name', async () => {
  const g = await execute(m, 'get-pet-by-id', ['7'], { dryRun: true, curl: true });
  assert.match(g.data.curl, /^curl -X GET /);
  assert.match(g.data.curl, /-H 'api_key: <PETSTORE_API_KEY>'/);
  assert.ok(!g.data.curl.includes('abc123'), g.data.curl);
  assert.match(g.data.curl, /'https:\/\/petstore3\.swagger\.io\/api\/v3\/pet\/7'$/);
  const p = await execute(m, 'add-pet', [], { dryRun: true, curl: true, name: 'Rex' });
  assert.match(p.data.curl, /--data '\{"name":"Rex"\}'/);
});

test('retries, timeouts, verbose meta and binary downloads run against a real server', async () => {
  const { createServer } = await import('node:http');
  let hits = 0, mutHits = 0;
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/flaky') {
      hits++;
      if (hits === 1) { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return res.end('{"error":"slow down"}'); }
      if (hits === 2) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"restarting"}'); }
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-9', 'x-ratelimit-remaining': '4' });
      return res.end('{"id":"ok"}');
    }
    if (path === '/mutate') { mutHits++; res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"nope"}'); }
    if (path === '/slow') return;
    if (path === '/blob') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.4 bytes')); }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const spec = join(tmp, 'flaky.json');
  const json = { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Flaky' }, servers: [{ url: base }], paths: {
    '/flaky': { get: { operationId: 'flaky', summary: 'Flaky', responses: { 200: json } } },
    '/mutate': { post: { operationId: 'mutate', summary: 'Mutate', responses: { 200: json } } },
    '/slow': { get: { operationId: 'slow', summary: 'Slow' } },
    '/blob': { get: { operationId: 'blob', summary: 'Blob' } },
  } }));
  const fm = await compile(spec, { name: 'flaky' });
  try {
    const r = await execute(fm, 'flaky', [], {});
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { id: 'ok' });
    assert.equal(r.meta.retries, 2); assert.equal(r.meta.retryAfter, '0'); assert.equal(r.meta.status, 200);

    const vb = await execute(fm, 'flaky', [], { verbose: true, curl: true });
    assert.equal(vb.meta.request.method, 'GET');
    assert.equal(vb.meta.request.url, `${base}/flaky`);
    assert.equal(vb.meta.response.status, 200);
    assert.equal(vb.meta.response.headers['x-request-id'], 'req-9');
    assert.equal(vb.meta.response.headers['x-ratelimit-remaining'], '4');
    assert.match(vb.meta.curl, /^curl -X GET /);

    const mu = await execute(fm, 'mutate', [], {});
    assert.equal(mu.exit, 1); assert.equal(mu.meta.status, 503);
    assert.equal(mu.meta.retries, undefined, 'a mutating verb never retries by itself');
    assert.equal(mutHits, 1);
    const forced = await execute(fm, 'mutate', [], { retry: '1' });
    assert.equal(forced.exit, 1); assert.equal(forced.meta.retries, 1); assert.equal(mutHits, 3);

    const t = await execute(fm, 'slow', [], { timeout: '200' });
    assert.equal(t.exit, 1);
    assert.match(t.error, /timed out after 200ms/);
    assert.match(t.error, /--timeout/); assert.match(t.error, /DECLICK_TIMEOUT_MS/);

    const noOut = await execute(fm, 'blob', [], {});
    assert.equal(noOut.exit, 1);
    assert.match(noOut.error, /application\/pdf/); assert.match(noOut.error, /--output/);
    const out = join(tmp, 'report.pdf');
    const saved = await execute(fm, 'blob', [], { output: out });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.data.bytes, 14); assert.equal(saved.data.contentType, 'application/pdf');
    assert.equal(saved.meta.status, 200);
    assert.ok(existsSync(out)); assert.equal(readFileSync(out, 'utf8'), '%PDF-1.4 bytes');
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('the CLI pipes a body in on stdin, merges engine meta and suggests near misses', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'declick-'));
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: raw, type: req.headers['content-type'] ?? null })); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const spec = join(home, 'echo.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Echo' }, servers: [{ url: `http://127.0.0.1:${srv.address().port}` }], paths: {
    '/echo': { post: { operationId: 'postEcho', summary: 'Echo a body', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'integer' } } } } } } } },
  } }));
  const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills'), OPENCLAW_SKILLS: '', DECLICK_GUARD: '', DASHCLAW_API_KEY: '', DASHCLAW_URL: '' };
  const go = (bin, args, stdin) => new Promise(done => {
    const c = spawn(process.execPath, [bin, ...args], { env });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
    c.on('close', status => done({ status, stdout, stderr }));
    c.stdin.end(stdin ?? '');
  });
  try {
    const add = await go('bin/declick.mjs', ['add', spec, '--name', 'echoapi']);
    assert.equal(add.status, 0, add.stderr);
    const r = await go('bin/run.mjs', ['echoapi', 'post-echo', '--body', '-', '--json', '--verbose'], '{"a":1}');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.data.got, '{"a":1}');
    assert.equal(j.data.type, 'application/json');
    assert.equal(j.meta.status, 200);
    assert.equal(j.meta.request.method, 'POST');
    const bogus = await go('bin/run.mjs', ['echoapi', 'post-eco', '--json']);
    assert.equal(bogus.status, 2);
    assert.match(JSON.parse(bogus.stdout).error, /unknown verb post-eco.*did you mean post-echo/);
    const flag = await go('bin/run.mjs', ['echoapi', 'post-echo', '--dry-runn', 'x', '--json']);
    assert.equal(flag.status, 1);
    const fe = JSON.parse(flag.stdout).error;
    assert.match(fe, /unknown flag --dry-runn/);
    assert.match(fe, /did you mean --dry-run/);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

// The three ways a live (non-dry-run) call can leak or misreport what it sent: a query-located api key echoed
// back in plain text, a multipart body missing from --curl, and a value-taking flag silently defaulting.
test('a live call masks a query api key, curl reproduces the multipart body, and a valueless --retry is an error', async () => {
  const { createServer } = await import('node:http');
  let sawKey = null, sawBody = '';
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/secure') {
      sawKey = u.searchParams.get('api_key');
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":"ok"}');
    }
    if (u.pathname === '/upload') {
      req.on('data', d => { sawBody += d; });
      return req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"up"}'); });
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const spec = join(tmp, 'liveq.json');
  const json = { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
  writeFileSync(spec, JSON.stringify({
    openapi: '3.0.0', info: { title: 'Live Q' }, servers: [{ url: base }],
    components: { securitySchemes: { qkey: { type: 'apiKey', in: 'query', name: 'api_key' } } },
    security: [{ qkey: [] }],
    paths: {
      '/secure': { get: { operationId: 'secure', summary: 'Secure', responses: { 200: json } } },
      '/upload': { post: { operationId: 'upload', summary: 'Upload', security: [], requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, label: { type: 'string' } } } } } }, responses: { 200: json } } },
    },
  }));
  const fm = await compile(spec, { name: 'live-q' });
  const key = fm.auth.schemes.qkey.env;
  process.env[key] = 'SUPERSECRETVALUE123';
  const p = join(tmp, 'live-up.txt');
  writeFileSync(p, 'hello multipart');
  try {
    const r = await execute(fm, 'secure', [], { curl: true, verbose: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(sawKey, 'SUPERSECRETVALUE123', 'the real key still has to reach the server');
    assert.ok(!JSON.stringify(r.meta).includes('SUPERSECRETVALUE123'), `the secret came back to the caller: ${JSON.stringify(r.meta)}`);
    assert.match(r.meta.curl, new RegExp(`api_key=%3C${key}%3E`));
    assert.match(r.meta.request.url, new RegExp(`api_key=%3C${key}%3E`));

    const up = await execute(fm, 'upload', [], { curl: true, file: `@${p}`, label: 'first' });
    assert.equal(up.ok, true, up.error);
    assert.match(sawBody, /name="file"; filename="live-up\.txt"/);
    assert.match(up.meta.curl, /-H 'content-type: multipart\/form-data; boundary=/);
    assert.match(up.meta.curl, /--data '/);
    assert.match(up.meta.curl, /hello multipart/);

    const noRetry = await execute(fm, 'secure', [], { retry: true });
    assert.equal(noRetry.exit, 1); assert.equal(noRetry.error, '--retry needs a value');
    const noTimeout = await execute(fm, 'secure', [], { timeout: true });
    assert.equal(noTimeout.exit, 1); assert.equal(noTimeout.error, '--timeout needs a value');
  } finally { delete process.env[key]; srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
