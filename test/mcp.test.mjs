import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.CREDS_VAULT = join(tmpdir(), `declick-mcp-none-${process.pid}.env`); // never read the real vault
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-mcp-')); // and never the developer's own warm daemon
const { compile, execute } = await import('../src/engines/mcp.mjs');
import { validateManifest } from '../src/manifest.mjs';
import { lint } from '../src/lint.mjs';
import { mcpClient } from '../src/mcp-client.mjs';

const STDIO = 'mcp:node fixtures/mcp-server.mjs';
const flagOf = (v, name) => v.flags.find(f => f.name === name);
const verbOf = (m, name) => m.verbs.find(v => v.name === name);

// One compile against a real child process, reused by the read-only assertions below.
const m = await compile(STDIO);

test('compile turns a real stdio server into verbs with the source in baseUrl', () => {
  assert.equal(m.name, 'mcp-server');
  assert.equal(m.engine, 'mcp');
  assert.equal(m.baseUrl, 'mcp:node fixtures/mcp-server.mjs');
  assert.deepEqual(m.mcp, { transport: 'stdio', command: 'node', args: ['fixtures/mcp-server.mjs'], url: null });
  assert.deepEqual(m.verbs.map(v => v.name), ['list-notes', 'add-note', 'boom']);
  assert.deepEqual(m.auth, { env: [] });
});

test('readOnlyHint decides mutating and the description keeps one line under 80 chars', () => {
  assert.equal(verbOf(m, 'list-notes').mutating, false);
  assert.equal(verbOf(m, 'list-notes').description, 'List notes, newest first.');
  assert.equal(verbOf(m, 'add-note').mutating, true);
  assert.equal(verbOf(m, 'boom').mutating, true);
});

test('inputSchema properties become typed flags, reserved names are renamed, first required scalar is positional', () => {
  const list = verbOf(m, 'list-notes');
  assert.deepEqual(list.args, []);
  assert.deepEqual(flagOf(list, 'tag'), { name: 'tag', description: 'only notes carrying this tag', required: false, type: 'string' });
  const limit = flagOf(list, 'param-limit');
  assert.equal(limit.wire, 'limit');
  assert.equal(limit.type, 'integer');
  assert.equal(limit.default, 10);
  const add = verbOf(m, 'add-note');
  assert.deepEqual(add.args, [{ name: 'title', required: true, type: 'string' }]);
  assert.equal(flagOf(add, 'count').required, true);
  assert.equal(flagOf(add, 'count').type, 'integer');
  assert.deepEqual(flagOf(add, 'kind').enum, ['todo', 'memo']);
  assert.equal(flagOf(add, 'kind').example, 'todo');
  assert.equal(flagOf(add, 'tags').item, 'string');
  assert.equal(verbOf(m, 'add-note').mcp.tool, 'add_note');
});

test('outputSchema becomes returns with the rows path', () => {
  assert.deepEqual(verbOf(m, 'list-notes').returns, { shape: 'object', rowsPath: 'notes', fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }] });
  assert.equal(verbOf(m, 'add-note').returns, undefined);
});

test('the compiled manifest passes validateManifest and lint', () => {
  assert.deepEqual(validateManifest(m), []);
  assert.deepEqual(lint(m), []);
});

test('execute returns structuredContent from a real child process', async () => {
  const r = await execute(m, 'list-notes', [], { paramLimit: 3 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.notes, [{ id: 'n1', title: 'A' }, { id: 'n2', title: 'B' }]);
  assert.deepEqual(r.data.echo, { limit: 3 }, 'the renamed flag reaches the server under its wire name, coerced to an integer');
});

test('execute coerces every flag by schema type and parses a JSON text result', async () => {
  const r = await execute(m, 'add-note', ['Buy milk'], { count: '2', kind: 'memo', tags: ['a', 'b'], meta: '{"x":1}', pinned: 'true' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { id: 'n3', echo: { title: 'Buy milk', count: 2, kind: 'memo', tags: ['a', 'b'], meta: { x: 1 }, pinned: true } });
});

test('a positional and its flag together is an error, and a missing required arg names it', async () => {
  const both = await execute(m, 'add-note', ['Buy milk'], { title: 'Buy milk', count: '1' });
  assert.equal(both.exit, 1);
  assert.match(both.error, /give title as an argument or --title, not both/);
  const missing = await execute(m, 'add-note', [], { count: '1' });
  assert.equal(missing.exit, 1);
  assert.match(missing.error, /add-note needs <title>; run: mcp-server describe --full/);
});

test('a bad integer and a bad enum fail before the server is spawned', async () => {
  const unspawnable = { ...m, mcp: { ...m.mcp, command: 'declick-no-such-binary' } };
  const bad = await execute(unspawnable, 'add-note', ['x'], { count: 'many' });
  assert.equal(bad.exit, 1);
  assert.equal(bad.error, '--count must be an integer, got many');
  const enumErr = await execute(unspawnable, 'add-note', ['x'], { count: '1', kind: 'note' });
  assert.equal(enumErr.error, '--kind must be one of todo, memo, got note');
  const json = await execute(unspawnable, 'add-note', ['x'], { count: '1', meta: 'nope' });
  assert.equal(json.error, '--meta must be a JSON object, got nope');
});

test('a tool that reports isError is exit 1 and keeps its content', async () => {
  const r = await execute(m, 'boom', [], {});
  assert.equal(r.ok, false);
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'boom: the note book is on fire');
  assert.deepEqual(r.data, [{ type: 'text', text: 'boom: the note book is on fire' }]);
});

test('dry-run shows the would-call payload without starting the server', async () => {
  const unspawnable = { ...m, mcp: { ...m.mcp, command: 'declick-no-such-binary' } };
  const r = await execute(unspawnable, 'add-note', ['Buy milk'], { count: '2', dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { transport: 'stdio', server: 'declick-no-such-binary fixtures/mcp-server.mjs', tool: 'add_note', arguments: { title: 'Buy milk', count: 2 } });
});

test('an unknown verb is exit 2 and a server that will not start is exit 1 naming the command', async () => {
  assert.equal((await execute(m, 'nope', [], {})).exit, 2);
  const dead = { ...m, mcp: { ...m.mcp, command: 'declick-no-such-binary' } };
  const r = await execute(dead, 'boom', [], {});
  assert.equal(r.exit, 1);
  assert.match(r.error, /declick-no-such-binary/);
});

test('content-length framing from a real server is accepted', async () => {
  const framed = await compile('mcp:node fixtures/mcp-server.mjs --framing content-length', { name: 'framed', verbs: 'boom' });
  assert.deepEqual(framed.verbs.map(v => v.name), ['boom']);
  const r = await execute(framed, 'boom', [], {});
  assert.equal(r.error, 'boom: the note book is on fire');
});

const PING_TOOL = { name: 'ping', description: 'Ping the server', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { who: { type: 'string' } } } };

// A streamable-http MCP server: JSON for initialize and tools/list, an SSE frame for tools/call.
function httpServer({ auth = null, hang = false, tools = [PING_TOOL] } = {}) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ accept: req.headers.accept, session: req.headers['mcp-session-id'], authorization: req.headers.authorization });
      if (auth && req.headers.authorization !== `Bearer ${auth}`) { res.writeHead(401); return res.end('unauthorized'); }
      if (hang) return;
      const msg = JSON.parse(body);
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'http-notes', version: '1' } }
        : msg.method === 'tools/list'
          ? { tools }
          : { content: [{ type: 'text', text: JSON.stringify({ pong: msg.params.arguments.who }) }] };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'tools/call') { res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' }); return res.end(`event: message\ndata: ${payload}\n\n`); }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(payload);
    });
  });
  return { srv, seen, listen: () => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}/mcp`))) };
}

test('streamable http compiles over json and calls over an sse frame, carrying the session id', async () => {
  const { srv, seen, listen } = httpServer();
  const url = await listen();
  try {
    const h = await compile(`mcp:${url}`, { name: 'httpmcp' });
    assert.equal(h.baseUrl, url);
    assert.deepEqual(h.mcp, { transport: 'http', command: null, args: [], url });
    assert.deepEqual(h.verbs.map(v => v.name), ['ping']);
    assert.equal(h.verbs[0].mutating, false);
    assert.deepEqual(h.auth, { env: [] });
    assert.match(seen[0].accept, /text\/event-stream/);
    const r = await execute(h, 'ping', [], { who: 'declick' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { pong: 'declick' });
    assert.equal(seen.at(-1).session, 'sess-1', 'Mcp-Session-Id is carried back to the server');
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('a 401 names the bearer env key at compile and is exit 4 at execute', async () => {
  const { srv, listen } = httpServer({ auth: 'sekret' });
  const url = await listen();
  try {
    const e = await compile(`mcp:${url}`, { name: 'guarded' }).then(() => null, x => x);
    assert.equal(e.exit, 4);
    assert.match(e.message, /GUARDED_TOKEN/);
    process.env.GUARDED_TOKEN = 'sekret';
    const h = await compile(`mcp:${url}`, { name: 'guarded' });
    assert.deepEqual(h.auth, { env: ['GUARDED_TOKEN'] });
    delete process.env.GUARDED_TOKEN;
    const r = await execute(h, 'ping', [], { who: 'x' });
    assert.equal(r.exit, 4);
    assert.match(r.error, /GUARDED_TOKEN/);
  } finally { delete process.env.GUARDED_TOKEN; srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('a server that never answers is exit 1, not a hang', async () => {
  const { srv, listen } = httpServer({ hang: true });
  const url = await listen();
  try {
    const e = await compile(`mcp:${url}`, { name: 'slow', timeout: 300 }).then(() => null, x => x);
    assert.equal(e.exit, 1);
    assert.match(e.message, /timed out/);
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('a long command needs --name and a bad source says what a source looks like', async () => {
  const long = await compile('mcp:npx -y @modelcontextprotocol/server-filesystem C:/tmp').then(() => null, x => x);
  assert.equal(long.exit, 1);
  assert.match(long.message, /--name/);
  const empty = await compile('mcp:').then(() => null, x => x);
  assert.match(empty.message, /usage: declick add mcp:/);
});

// npx resolves to a .cmd shim on Windows; spawning it used shell:true, which Node 24 flags as DEP0190 on every call.
test('the npx stdio path on windows does not print the DEP0190 shell warning', async t => {
  if (process.platform !== 'win32') return t.skip('windows-only');
  const warnings = [];
  const onWarning = w => warnings.push(w.code);
  process.on('warning', onWarning);
  // -c runs the command through the real npx.cmd shim without resolving a package: bare `npx node` installs the npm
  // package named node (a whole runtime) from the registry, which cost a cold CI runner 13s and then the 30s timeout.
  const c = mcpClient({ transport: 'stdio', command: 'npx', args: ['-c', 'node fixtures/mcp-server.mjs'] });
  try {
    await c.connect();
    const tools = await c.listTools();
    assert.deepEqual(tools.map(x => x.name), ['list_notes', 'add_note', 'boom']);
  } finally { c.close(); process.off('warning', onWarning); }
  assert.ok(!warnings.includes('DEP0190'), `got warnings: ${warnings.join(', ')}`);
});
