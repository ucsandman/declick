import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, emit, parseFlags, camel, nearest, RESERVED, EXIT } from '../src/output.mjs';

test('shape projects fields and applies limit', () => {
  const rows = [{ id: 1, name: 'a', x: 9 }, { id: 2, name: 'b', x: 8 }, { id: 3, name: 'c', x: 7 }];
  const r = shape(rows, { fields: ['id', 'name'], limit: 2 });
  assert.deepEqual(r.data, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  assert.deepEqual(r.meta, { count: 3, truncated: true });
});
test('shape handles a single object and defaults the limit to 50', () => {
  const r = shape({ id: 1, name: 'a', x: 9 }, { fields: ['name'] });
  assert.deepEqual(r.data, { name: 'a' });
  assert.deepEqual(r.meta, { count: 1, truncated: false });
  assert.equal(shape(Array.from({ length: 60 }, (_, i) => i)).data.length, 50);
});
test('shape unwraps a named rows array and keeps the rest of the body in meta.extra', () => {
  const page = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], next: 'c' };
  const r = shape(page, { rows: 'items', limit: 2 });
  assert.deepEqual(r.data, [{ id: 1 }, { id: 2 }]);
  assert.equal(r.meta.count, 3); assert.equal(r.meta.truncated, true); assert.equal(r.meta.rows, 'items');
  assert.deepEqual(r.meta.extra, { next: 'c' });
});
test('a plain object is untouched with no flags and unwraps its one array only for a response body', () => {
  const page = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], next: 'c' };
  const bare = shape(page, { auto: true });
  assert.deepEqual(bare.data, page); assert.equal(bare.meta.rows, undefined); assert.equal(bare.meta.count, 1);
  const filtered = shape(page, { limit: 2, auto: true });
  assert.equal(filtered.meta.rows, 'items'); assert.equal(filtered.data.length, 2); assert.equal(filtered.meta.extra.next, 'c');
  const resource = shape({ name: 'pets', engine: 'openapi', verbs: [{ name: 'a' }, { name: 'b' }] }, { limit: 1 });
  assert.equal(resource.meta.rows, undefined); assert.equal(resource.data.name, 'pets');
  assert.throws(() => shape(page, { fields: ['id'] }), /no field matched id/, 'a resource is never guessed at');
});
test('--rows with no value is a contract error, not a raw TypeError', () => {
  assert.throws(() => shape({ items: [{ id: 1 }] }, { rows: true }), e => e.exit === 1 && /^--rows needs a dotted path/.test(e.message));
  assert.match(JSON.parse(emit({ ok: true, data: { items: [{ id: 'a' }], next: 'c' } }, { json: true, rows: true }).text).error, /--rows needs a dotted path/);
});
test('a single resource whose fields resolve on the object is never unwrapped', () => {
  const r = shape({ id: 7, tags: ['a', 'b'] }, { fields: ['id'] });
  assert.deepEqual(r.data, { id: 7 }); assert.equal(r.meta.rows, undefined); assert.equal(r.meta.count, 1);
});
test('--fields naming top-level (or dotted) keys of the object skips an auto rows path entirely, --rows included', () => {
  const repo = { full_name: 'octo/hello', stargazers_count: 42, owner: { login: 'octo' }, contributors: [{ login: 'a' }, { login: 'b' }] };
  const compiled = shape(repo, { fields: ['full_name', 'stargazers_count'], rows: 'contributors', auto: true });
  assert.deepEqual(compiled.data, { full_name: 'octo/hello', stargazers_count: 42 }); assert.equal(compiled.meta.rows, undefined);
  const dotted = shape(repo, { fields: ['owner.login'], rows: 'contributors', auto: true });
  assert.deepEqual(dotted.data, { 'owner.login': 'octo' }); assert.equal(dotted.meta.rows, undefined);
  // A field list that matches nothing on the object still unwraps: the rows array is the only sensible answer.
  const unwrapped = shape(repo, { fields: ['login'], rows: 'contributors', auto: true });
  assert.deepEqual(unwrapped.data, [{ login: 'a' }, { login: 'b' }]); assert.equal(unwrapped.meta.rows, 'contributors');
});
test('auto rows-path detection only fires for a data/items-named array, not any sole array on the object', () => {
  // GitHub's repository shape: 90-odd fields, one array called topics. --fields on the object itself still
  // works, a typo still lists the object's own keys (never an empty list), and topics is never mistaken for rows.
  const repo = { id: 1, name: 'hello', full_name: 'octo/hello', stargazers_count: 42, topics: ['a', 'b'], owner: { login: 'octo' } };
  const named = shape(repo, { fields: ['full_name'], auto: true });
  assert.deepEqual(named.data, { full_name: 'octo/hello' }); assert.equal(named.meta.rows, undefined);
  assert.throws(() => shape(repo, { fields: ['fullname'], auto: true }),
    e => e.exit === 1 && /^no field matched fullname; available: id, name, full_name, stargazers_count, topics, owner$/.test(e.message));
  const untouched = shape({ topics: ['a', 'b'], name: 'hello', id: 1 }, { auto: true, limit: 1 });
  assert.equal(untouched.meta.rows, undefined); assert.deepEqual(untouched.data, { topics: ['a', 'b'], name: 'hello', id: 1 });
  // data/items/etc still unwrap by name alone, whatever else rides beside them.
  const page = shape({ data: [{ id: 1 }, { id: 2 }], has_more: true }, { auto: true, limit: 1 });
  assert.equal(page.meta.rows, 'data'); assert.deepEqual(page.data, [{ id: 1 }]);
});
test('shape resolves dotted fields, reports partial misses and fails when nothing matches', () => {
  const rows = [{ a: { b: 1 }, c: 2 }];
  assert.deepEqual(shape(rows, { fields: ['a.b'] }).data, [{ 'a.b': 1 }]);
  const partial = shape(rows, { fields: ['c', 'nope'] });
  assert.deepEqual(partial.data, [{ c: 2 }]); assert.deepEqual(partial.meta.unknownFields, ['nope']);
  assert.throws(() => shape(rows, { fields: ['x', 'y'] }), e => e.exit === 1 && /^no field matched x, y; available: a, c$/.test(e.message));
  assert.throws(() => shape({ id: 7 }, { fields: ['x'] }), e => e.exit === 1 && /available: id/.test(e.message));
  assert.deepEqual(shape([], { fields: ['x'] }).data, [], 'an empty list has no rows to match against');
});
test('an unresolvable --rows path is an exit 1 error naming the keys that are there', () => {
  assert.throws(() => shape({ items: [1], next: 'c' }, { rows: 'nope' }), e => e.exit === 1 && /^no rows array at nope; available: items, next$/.test(e.message));
});
test('emit turns a bad --fields into an error envelope instead of a crash', () => {
  const { text, exit } = emit({ ok: true, data: [{ id: 1 }] }, { json: true, fields: ['nope'] });
  assert.equal(exit, 1); assert.match(JSON.parse(text).error, /no field matched nope; available: id/);
});
test('emit json envelope and exit code', () => {
  const { text, exit } = emit({ ok: true, data: [1, 2] }, { json: true });
  assert.deepEqual(JSON.parse(text), { ok: true, data: [1, 2], meta: { count: 2, truncated: false } });
  assert.equal(exit, EXIT.OK);
});
test('emit error carries exit, message and the engine payload', () => {
  const { text, exit } = emit({ ok: false, error: 'nope', exit: EXIT.NOT_FOUND, data: { missing: ['Button:Plus'] } }, { json: true });
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'nope', exit: 2, data: { missing: ['Button:Plus'] } });
  assert.equal(exit, 2);
});
test('emit marks dry runs and never projects the preview away', () => {
  const j = JSON.parse(emit({ ok: true, data: { method: 'GET', url: 'u' } }, { json: true, dryRun: true, fields: ['nope'] }).text);
  assert.equal(j.meta.dryRun, true); assert.equal(j.data.url, 'u');
  assert.equal(JSON.parse(emit({ ok: true, data: [1] }, { json: true }).text).meta.dryRun, undefined);
});
test('emit text mode prints rows as lines', () => {
  const { text } = emit({ ok: true, data: [{ id: 1, name: 'a' }] }, { json: false });
  assert.match(text, /id=1\s+name=a/);
});
test('parseFlags space form', () => {
  const r = parseFlags(['list-pets', '--fields', 'id,name', '--limit', '5', '--dry-run', '--status', 'sold']);
  assert.deepEqual(r.positional, ['list-pets']);
  assert.deepEqual(r.flags.fields, ['id', 'name']);
  assert.equal(r.flags.limit, 5);
  assert.equal(r.flags.dryRun, true);
  assert.equal(r.flags.status, 'sold');
});
test('parseFlags: --key=value, booleans never eat positionals, true/false forms, repeats, --', () => {
  assert.deepEqual(parseFlags(['get', '--dry-run', '7']), { positional: ['get', '7'], flags: { dryRun: true } });
  assert.equal(parseFlags(['get', '7', '--dry-run=true']).flags.dryRun, true);
  assert.equal(parseFlags(['get', '7', '--dry-run', 'false']).flags.dryRun, false);
  assert.equal(parseFlags(['get', '--json=false']).flags.json, false);
  assert.equal(parseFlags(['get', '--no-json']).flags.json, false);
  assert.equal(parseFlags(['list', '--limit=5']).flags.limit, 5);
  assert.deepEqual(parseFlags(['list', '--fields=id,name']).flags.fields, ['id', 'name']);
  assert.deepEqual(parseFlags(['list', '--tag', 'a', '--tag', 'b']).flags.tag, ['a', 'b']);
  assert.equal(parseFlags(['x', '--page-size', '3']).flags.pageSize, '3');
  assert.deepEqual(parseFlags(['x', '--', '--not-a-flag']).positional, ['x', '--not-a-flag']);
  assert.equal(parseFlags(['x', '-']).positional[1], '-');
});
test('parseFlags: bare --limit is ignored, bad --limit is an exit 1 error', () => {
  assert.equal(parseFlags(['list', '--limit']).flags.limit, undefined);
  for (const bad of ['abc', '0', '-5', '1.5']) assert.throws(() => parseFlags(['list', '--limit', bad]), e => e.exit === 1 && /positive integer/.test(e.message));
});
test('camel', () => { assert.equal(camel('page-size'), 'pageSize'); assert.equal(camel('x'), 'x'); });
test('nearest suggests names within three edits, closest first, at most three', () => {
  // get-pet-by-id is 6 edits away (past the old d<=3 cutoff) but starts with the typed word, so it now outranks
  // add-pet (3 edits, no shared prefix): this replaces the old ['get-pets', 'add-pet'] expectation, which
  // encoded the exact bug (add-pet over get-pet-by-id) the fix corrects.
  assert.deepEqual(nearest('get-pet', ['get-pets', 'get-pet-by-id', 'add-pet', 'delete-everything']), ['get-pets', 'get-pet-by-id', 'add-pet']);
  assert.deepEqual(nearest('flag', ['flagx', 'flagy', 'flagz', 'flagw']), ['flagw', 'flagx', 'flagy']);
  assert.deepEqual(nearest('zzzzzzzz', ['a', 'b']), []);
  assert.deepEqual(nearest('dry-runn', RESERVED), ['dry-run']);
  // A prefix of a candidate ranks first even past edit distance 3: 'list' is 6 edits from 'list-notes'.
  assert.deepEqual(nearest('list', ['list-notes', 'delete-note']), ['list-notes']);
  // A candidate containing the word (not just prefixed by it) still outranks an edit-distance-only match.
  assert.deepEqual(nearest('pet', ['get-pet-by-id', 'pest']), ['get-pet-by-id', 'pest']);
});
test('emit merges engine meta into the envelope meta, on errors too', () => {
  const j = JSON.parse(emit({ ok: true, data: { id: 1 }, meta: { status: 200, retries: 2, curl: 'curl x' } }, { json: true }).text);
  assert.equal(j.meta.status, 200); assert.equal(j.meta.retries, 2); assert.equal(j.meta.curl, 'curl x');
  assert.equal(j.meta.count, 1); assert.equal(j.meta.truncated, false);
  const e = JSON.parse(emit({ ok: false, error: 'boom', exit: 1, meta: { status: 500 } }, { json: true }).text);
  assert.equal(e.meta.status, 500); assert.equal(e.exit, 1);
  assert.equal(JSON.parse(emit({ ok: false, error: 'boom', exit: 1 }, { json: true }).text).meta, undefined);
});
test('the request contract flags are reserved and the boolean ones never eat a value', () => {
  for (const f of ['header', 'output', 'content-type', 'base-url', 'server', 'retry', 'timeout', 'verbose', 'curl', 'body-file']) assert.ok(RESERVED.includes(f), f);
  const r = parseFlags(['get', '--verbose', '7', '--curl', '--header', 'X-A: 1', '--header', 'X-B: 2', '--timeout', '500', '--body', '-']);
  assert.deepEqual(r.positional, ['get', '7']);
  assert.equal(r.flags.verbose, true); assert.equal(r.flags.curl, true);
  assert.deepEqual(r.flags.header, ['X-A: 1', 'X-B: 2']);
  assert.equal(r.flags.timeout, '500'); assert.equal(r.flags.body, '-');
});
