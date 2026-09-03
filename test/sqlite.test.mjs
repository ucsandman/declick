import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, execute } from '../src/engines/sqlite.mjs';

// Real sqlite file, real node:sqlite writes/reads — no mocking of the underlying mechanism.
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'declick-sqlite-'));
  const path = join(dir, 'app.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE)`);
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT)`);
  db.exec(`CREATE VIEW user_posts AS SELECT posts.id AS post_id, users.name AS author, posts.title AS title FROM posts JOIN users ON users.id = posts.user_id`);
  db.close();
  return { dir, path };
}

async function build(path) {
  return compile(`sqlite:${path}`, { name: 'app' });
}

test('compile introspects tables and a view into list/get/insert/update/delete verbs', async () => {
  const { path } = makeDb();
  const m = await build(path);
  assert.equal(m.engine, 'sqlite');
  assert.equal(m.baseUrl, `sqlite:${path}`);
  assert.deepEqual(m.auth, { env: [] });
  const names = m.verbs.map(v => v.name).sort();
  assert.deepEqual(names, [
    'delete-posts', 'delete-users', 'get-posts', 'get-user-posts', 'get-users',
    'insert-posts', 'insert-users', 'list-posts', 'list-user-posts', 'list-users', 'query',
    'update-posts', 'update-users',
  ]);

  const listUsers = m.verbs.find(v => v.name === 'list-users');
  assert.equal(listUsers.mutating, false);
  assert.deepEqual(listUsers.returns.fields.map(f => f.name).sort(), ['email', 'id', 'name']);
  assert.ok(listUsers.flags.some(f => f.name === 'name'));
  assert.ok(listUsers.flags.some(f => f.name === 'order'));
  assert.ok(listUsers.flags.some(f => f.name === 'desc'));

  const getUsers = m.verbs.find(v => v.name === 'get-users');
  assert.deepEqual(getUsers.args, [{ name: 'id', required: true, type: 'integer' }]);
  assert.equal(getUsers.returns.shape, 'object');

  const insertUsers = m.verbs.find(v => v.name === 'insert-users');
  assert.equal(insertUsers.mutating, true);
  assert.equal(insertUsers.flags.some(f => f.name === 'id'), false, 'pk is not an insert flag');
  const nameFlag = insertUsers.flags.find(f => f.name === 'name');
  assert.equal(nameFlag.required, true, 'NOT NULL without default is required');
  const emailFlag = insertUsers.flags.find(f => f.name === 'email');
  assert.equal(emailFlag.required, false, 'nullable column is optional');

  const listView = m.verbs.find(v => v.name === 'list-user-posts');
  assert.equal(listView.mutating, false);
  assert.ok(!names.includes('insert-user-posts'), 'views get no mutating verbs');
  assert.ok(!names.includes('update-user-posts'));
  assert.ok(!names.includes('delete-user-posts'));

  rmSync(path, { force: true });
});

test('insert, get, list with filter and limit, update, delete through the real db file', async () => {
  const { path } = makeDb();
  const m = await build(path);

  const ins1 = await execute(m, 'insert-users', [], { name: 'Alice', email: 'alice@x.com' });
  assert.equal(ins1.ok, true, JSON.stringify(ins1));
  assert.equal(ins1.data.changes, 1);
  assert.equal(ins1.data.lastInsertRowid, 1);
  const ins2 = await execute(m, 'insert-users', [], { name: 'Bob', email: 'bob@x.com' });
  assert.equal(ins2.data.lastInsertRowid, 2);

  const missingName = await execute(m, 'insert-users', [], { email: 'no-name@x.com' });
  assert.equal(missingName.ok, false); assert.equal(missingName.exit, 1);
  assert.match(missingName.error, /name/);

  const got = await execute(m, 'get-users', ['1'], {});
  assert.equal(got.ok, true);
  assert.equal(got.data.name, 'Alice');

  const notFound = await execute(m, 'get-users', ['999'], {});
  assert.equal(notFound.ok, false); assert.equal(notFound.exit, 2);

  const listed = await execute(m, 'list-users', [], { limit: 10 });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 2);

  const filtered = await execute(m, 'list-users', [], { name: 'Bob', limit: 5 });
  assert.equal(filtered.ok, true);
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].name, 'Bob');

  const upd = await execute(m, 'update-users', ['1'], { email: 'alice2@x.com' });
  assert.equal(upd.ok, true); assert.equal(upd.data.changes, 1);
  const gotAfter = await execute(m, 'get-users', ['1'], {});
  assert.equal(gotAfter.data.email, 'alice2@x.com');

  const updMissing = await execute(m, 'update-users', ['999'], { email: 'x@x.com' });
  assert.equal(updMissing.ok, false); assert.equal(updMissing.exit, 2);

  const del = await execute(m, 'delete-users', ['2'], {});
  assert.equal(del.ok, true); assert.equal(del.data.changes, 1);
  const delAgain = await execute(m, 'delete-users', ['2'], {});
  assert.equal(delAgain.ok, false); assert.equal(delAgain.exit, 2);

  rmSync(path, { force: true });
});

test('query verb runs parameterized SELECT and rejects anything else', async () => {
  const { path } = makeDb();
  const m = await build(path);
  await execute(m, 'insert-users', [], { name: 'Carol', email: 'carol@x.com' });

  const q = await execute(m, 'query', [], { sql: 'SELECT * FROM users WHERE name = ?', param: 'Carol' });
  assert.equal(q.ok, true);
  assert.equal(q.data.length, 1);
  assert.equal(q.data[0].email, 'carol@x.com');

  const rejected = await execute(m, 'query', [], { sql: 'DELETE FROM users' });
  assert.equal(rejected.ok, false); assert.equal(rejected.exit, 1);
  assert.match(rejected.error, /SELECT|WITH/);

  rmSync(path, { force: true });
});

test('dry-run shows the sql and params without touching the database', async () => {
  const { path } = makeDb();
  const m = await build(path);
  const dry = await execute(m, 'insert-users', [], { name: 'Dry', email: 'dry@x.com', dryRun: true });
  assert.equal(dry.ok, true);
  assert.match(dry.data.sql, /^INSERT INTO "users"/);
  assert.deepEqual(dry.data.params, ['Dry', 'dry@x.com']);
  const listed = await execute(m, 'list-users', [], {});
  assert.equal(listed.data.length, 0, 'dry-run must not write');
  rmSync(path, { force: true });
});

test('constraint errors surface as exit 1 with the sqlite message', async () => {
  const { path } = makeDb();
  const m = await build(path);
  await execute(m, 'insert-users', [], { name: 'Dup', email: 'dup@x.com' });
  const dup = await execute(m, 'insert-users', [], { name: 'Dup2', email: 'dup@x.com' });
  assert.equal(dup.ok, false); assert.equal(dup.exit, 1);
  assert.match(dup.error, /UNIQUE constraint/);
  rmSync(path, { force: true });
});

test('a missing database file is exit 2 on execute', async () => {
  const { path, dir } = makeDb();
  const m = await build(path);
  rmSync(dir, { recursive: true, force: true });
  const r = await execute(m, 'list-users', [], {});
  assert.equal(r.ok, false); assert.equal(r.exit, 2);
  assert.match(r.error, /no sqlite file/);
});

test('--limit is the output contract flag, not a SQL LIMIT that hides the true count', async () => {
  const { path } = makeDb();
  const m = await build(path);
  for (const n of ['A', 'B', 'C', 'D']) await execute(m, 'insert-users', [], { name: n, email: `${n}@x.com` });

  const dry = await execute(m, 'list-users', [], { dryRun: true, limit: 1 });
  assert.equal(dry.ok, true, dry.error);
  assert.ok(!/LIMIT/i.test(dry.data.sql), `--limit reached the sql: ${dry.data.sql}`);
  assert.deepEqual(dry.data.params, []);
  const all = await execute(m, 'list-users', [], { limit: 1 });
  assert.equal(all.data.length, 4, 'the engine hands the whole result set to the shared projection');

  // The envelope an agent actually reads: the count is the real total and truncated says there is more.
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'declick-sqlite-home-'));
  const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills'), OPENCLAW_SKILLS: '', CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '' };
  const add = spawnSync(process.execPath, ['bin/declick.mjs', 'add', `sqlite:${path}`, '--name', 'app'], { env, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const r = spawnSync(process.execPath, ['bin/run.mjs', 'app', 'list-users', '--json', '--limit', '1'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.data.length, 1);
  assert.equal(j.meta.count, 4);
  assert.equal(j.meta.truncated, true, r.stdout);
  rmSync(path, { force: true });
});

test('a column named like a contract flag is renamed, and still filters and writes its own column', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'declick-sqlite-'));
  const path = join(dir, 'rate.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "limit" INTEGER, "fields" TEXT)');
  db.close();
  const m = await compile(`sqlite:${path}`, { name: 'rate' });
  const { lint } = await import('../src/lint.mjs');
  assert.deepEqual(lint(m), [], 'a real column name must never collide with a contract flag');
  const list = m.verbs.find(v => v.name === 'list-plans');
  assert.deepEqual(list.flags.filter(f => f.wire).map(f => [f.name, f.wire]), [['param-limit', 'limit'], ['param-fields', 'fields']]);

  const ins = await execute(m, 'insert-plans', [], { name: 'free', 'param-limit': 5, 'param-fields': 'a,b' });
  assert.equal(ins.ok, true, ins.error);
  const dry = await execute(m, 'list-plans', [], { dryRun: true, 'param-limit': 5 });
  assert.match(dry.data.sql, /WHERE "limit" = \?/);
  const hit = await execute(m, 'list-plans', [], { 'param-limit': 5 });
  assert.equal(hit.data.length, 1);
  assert.equal(hit.data[0].limit, 5);
  assert.equal(hit.data[0].fields, 'a,b');
  const upd = await execute(m, 'update-plans', ['1'], { 'param-limit': 9 });
  assert.equal(upd.ok, true, upd.error);
  assert.equal((await execute(m, 'get-plans', ['1'], {})).data.limit, 9);
  rmSync(dir, { recursive: true, force: true });
});
