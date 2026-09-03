import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { engines, ENGINE_INFO, pickEngine, probe } from '../src/engines/index.mjs';
import { findChrome } from '../src/cdp.mjs';

const home = mkdtempSync(join(tmpdir(), 'declick-eng-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-eng-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin: a test that also serves http in this process cannot block its own event loop on spawnSync.
const runAsync = args => new Promise(res => { const c = spawn(process.execPath, ['bin/declick.mjs', ...args], { env }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const abs = p => resolve(p);
// Every add here is a preview: it must compile, lint and validate without writing an adapter.
const added = (args, engine) => {
  const r = run(['add', ...args, '--dry-run']);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  const d = J(r).data;
  assert.equal(d.engine, engine);
  assert.ok(d.verbs.length, `${d.name} compiled no verbs`);
  assert.ok(!existsSync(join(home, d.name)), 'a dry run wrote an adapter');
  return d;
};

const dbPath = join(home, 'notes.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT)');
  db.exec("INSERT INTO notes (title, body) VALUES ('first', 'hello')");
  db.close();
}

test('every engine in the map has an ENGINE_INFO row with a runnable source example', () => {
  assert.deepEqual(Object.keys(engines).sort(), ENGINE_INFO.map(e => e.name).sort());
  for (const e of ENGINE_INFO) {
    assert.equal(typeof e.ready, 'boolean', `${e.name}.ready`);
    assert.ok(e.source && e.note, `${e.name} needs a source example and a note`);
    assert.ok(!/lands in|coming|todo/i.test(e.note), `${e.name} note is not present tense: ${e.note}`);
  }
  const by = n => ENGINE_INFO.find(e => e.name === n);
  assert.equal(by('sqlite').ready, true);
  assert.equal(by('web').ready, !!findChrome());
  assert.equal(by('desktop').ready, process.platform === 'win32');
  for (const n of ['openapi', 'mcp', 'graphql', 'postman', 'har', 'cli']) assert.equal(by(n).ready, true, n);
});

test('pickEngine routes every source form declick accepts', () => {
  const table = [
    ['app:Calculator', 'desktop'],
    ['mcp:node fixtures/mcp-server.mjs', 'mcp'],
    ['mcp:https://host/mcp', 'mcp'],
    ['web:https://example.com/', 'web'],
    ['graphql:https://api.example.com/graphql', 'graphql'],
    ['sqlite:./notes.db', 'sqlite'],
    ['cli:gh', 'cli'],
    ['cli:node ./tool.mjs', 'cli'],
    ['./data/notes.db', 'sqlite'],
    ['C:\\tmp\\app.sqlite', 'sqlite'],
    ['/var/lib/app.sqlite3', 'sqlite'],
    ['fixtures/sample.har', 'har'],
    ['capture.har?x=1', 'har'],
    ['fixtures/petstore.yaml', 'openapi'],
    ['spec.yml', 'openapi'],
    ['schema.graphql', 'graphql'],
    ['schema.gql', 'graphql'],
    ['fixtures/petstore.json', 'openapi'],
    ['missing-spec.json', 'openapi'],
  ];
  for (const [source, engine] of table) assert.equal(pickEngine(source), engine, source);
});

test('a local json file is routed by what is inside it, not by its extension', () => {
  const har = join(home, 'capture.json');
  copyFileSync('fixtures/sample.har', har);
  assert.equal(pickEngine(har), 'har');
  assert.equal(pickEngine('fixtures/postman.json'), 'postman');
  assert.equal(pickEngine('fixtures/insomnia.json'), 'postman');
  assert.equal(pickEngine('fixtures/graphql-schema.json'), 'graphql');
  assert.equal(pickEngine('fixtures/petstore.json'), 'openapi');
  assert.equal(pickEngine('fixtures/swagger2.json'), 'openapi');
});

test('an override wins, an unknown engine lists the engines, and the catch-all names every form', () => {
  assert.equal(pickEngine('fixtures/postman.json', 'openapi'), 'openapi');
  assert.throws(() => pickEngine('x.json', 'nope'), e => /unknown engine nope/.test(e.message) && /sqlite/.test(e.message) && e.exit === 1);
  const e = (() => { try { pickEngine('notes.txt'); return null; } catch (x) { return x; } })();
  assert.match(e?.message ?? '', /cannot tell what notes\.txt is/);
  for (const form of ['app:', 'mcp:', 'web:', 'graphql:', 'sqlite:', 'cli:', '.har', '.yaml']) assert.ok(e.message.includes(form), `catch-all never mentions ${form}: ${e.message}`);
});

test('a url is read once and routed by what it serves', async () => {
  const yaml = 'openapi: "3.0.0"\ninfo:\n  title: y\n  version: "1"\npaths: {}\n';
  const server = createServer((req, res) => {
    if (req.url.startsWith('/a')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'a', version: '1' }, paths: {} })); return; }
    if (req.url.startsWith('/b')) { res.writeHead(200, { 'content-type': 'application/yaml' }); res.end(yaml); return; }
    if (req.url.startsWith('/c')) {
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errors: [{ message: 'GET not allowed' }] })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { __typename: 'Query' } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>site</title><body>hi</body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await probe(`${base}/a`), 'openapi');
    assert.equal(await probe(`${base}/b`), 'openapi');
    assert.equal(await probe(`${base}/c`), 'graphql');
    assert.equal(await probe(`${base}/d`), 'web');
    // Through the real CLI: pickEngine is synchronous, so the probe has to survive a child process.
    const cli = await runAsync(['engines', '--source', `${base}/c`]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(J(cli).data.engine, 'graphql');
  } finally { server.close(); }
});

test('a url that cannot be read falls back to its shape instead of failing', () => {
  assert.equal(pickEngine('http://127.0.0.1:1/openapi.json'), 'openapi');
  assert.equal(pickEngine('http://127.0.0.1:1/graphql'), 'graphql');
  assert.equal(pickEngine('http://127.0.0.1:1/shop'), 'web');
});

test('add --dry-run compiles a yaml spec through the openapi engine', () => {
  const d = added(['fixtures/petstore.yaml', '--name', 'petstore-yaml'], 'openapi');
  assert.equal(d.baseUrl, 'https://petstore3.swagger.io/api/v3');
  assert.ok(d.verbs.some(v => v.name === 'get-pet-by-id'));
});

test('add --dry-run compiles a real mcp server', () => {
  const d = added([`mcp:node ${abs('fixtures/mcp-server.mjs')}`], 'mcp');
  assert.ok(d.verbs.some(v => v.name === 'list-notes'), d.verbs.map(v => v.name).join(','));
});

test('add --dry-run compiles a graphql introspection dump', () => {
  const d = added(['fixtures/graphql-schema.json'], 'graphql');
  assert.ok(d.verbs.some(v => v.name === 'pets'));
});

test('add --dry-run compiles a postman collection and an insomnia export', () => {
  assert.ok(added(['fixtures/postman.json'], 'postman').verbs.length);
  assert.ok(added(['fixtures/insomnia.json'], 'postman').verbs.length);
});

// Two engines take a compile option nothing else does, and ENGINE_INFO already advertises --host.
test('add hands --host and --url to the engines that need them', () => {
  const har = added(['fixtures/sample.har', '--host', 'tracker.other.com'], 'har');
  assert.equal(har.baseUrl, 'https://tracker.other.com');
  assert.deepEqual(har.verbs.map(v => v.name), ['post-api-collect']);
  const gql = added(['fixtures/graphql-schema.json', '--url', 'https://api.example.com/graphql'], 'graphql');
  assert.equal(gql.baseUrl, 'https://api.example.com/graphql');
});

test('add --dry-run compiles a har capture', () => {
  assert.ok(added(['fixtures/sample.har'], 'har').verbs.length);
});

test('add --dry-run compiles a real sqlite file', () => {
  const d = added([dbPath], 'sqlite');
  assert.ok(d.verbs.some(v => v.name === 'list-notes'));
  assert.ok(d.verbs.some(v => v.name === 'insert-notes' && v.mutating));
});

test('add --dry-run compiles a real cli tool from its own help', () => {
  const d = added([`cli:node ${abs('fixtures/fake-tool.mjs')}`], 'cli');
  assert.ok(d.verbs.some(v => v.name === 'list'), d.verbs.map(v => v.name).join(','));
});

test('add --dry-run compiles a web recipe directory', { skip: findChrome() ? false : 'no chrome or edge on this machine' }, async () => {
  const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Declick Web Fixture</title></html>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}/`;
  try {
    const r = await runAsync(['add', `web:${site}`, '--recipes', 'fixtures/web-recipes', '--name', 'web-fixture', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    const d = J(r).data;
    assert.equal(d.engine, 'web');
    assert.equal(d.window, site.replace(/\/$/, ''));
    assert.ok(d.verbs.some(v => v.name === 'read-title'));
    assert.ok(!existsSync(join(home, 'web-fixture')), 'a dry run wrote an adapter');
  } finally { server.close(); }
});

test('the skill an adapter ships names the thing that engine acts on when a verb fails', () => {
  const cases = [
    [[`mcp:node ${abs('fixtures/mcp-server.mjs')}`], /server/i],
    [[dbPath], new RegExp(dbPath.replace(/[\\.]/g, '\\$&'))],
    [[`cli:node ${abs('fixtures/fake-tool.mjs')}`], /fake-tool|node/i],
  ];
  for (const [args, re] of cases) {
    const r = run(['add', ...args]);
    assert.equal(r.status, 0, r.stderr);
    const name = J(r).data.name;
    assert.match(readFileSync(join(skills, name, 'SKILL.md'), 'utf8'), re);
  }
});

test('describe names the target in each engine own words', () => {
  const first = name => run(['describe', name, '--json', 'false']).stdout.split('\n')[0];
  assert.match(first('notes'), /db: .*notes\.db/);
  assert.match(first('mcp-server'), /server: /);
  assert.match(first('fake-tool'), /bin: /);
});

test('a saved adapter from every engine passes lint through the real CLI', () => {
  for (const name of ['notes', 'mcp-server', 'fake-tool']) {
    const r = run(['lint', name]);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
  writeFileSync(join(home, 'unused.txt'), '');
});
