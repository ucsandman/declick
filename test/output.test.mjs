import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, emit, parseFlags, camel, EXIT } from '../src/output.mjs';

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
