import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, emit, parseFlags, EXIT } from '../src/output.mjs';

test('shape projects fields and applies limit', () => {
  const rows = [{ id: 1, name: 'a', x: 9 }, { id: 2, name: 'b', x: 8 }, { id: 3, name: 'c', x: 7 }];
  const r = shape(rows, { fields: ['id', 'name'], limit: 2 });
  assert.deepEqual(r.data, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  assert.deepEqual(r.meta, { count: 3, truncated: true });
});
test('shape handles a single object', () => {
  const r = shape({ id: 1, name: 'a', x: 9 }, { fields: ['name'] });
  assert.deepEqual(r.data, { name: 'a' });
  assert.deepEqual(r.meta, { count: 1, truncated: false });
});
test('emit json envelope and exit code', () => {
  const { text, exit } = emit({ ok: true, data: [1, 2] }, { json: true });
  assert.deepEqual(JSON.parse(text), { ok: true, data: [1, 2], meta: { count: 2, truncated: false } });
  assert.equal(exit, EXIT.OK);
});
test('emit error carries exit and message', () => {
  const { text, exit } = emit({ ok: false, error: 'nope', exit: EXIT.NOT_FOUND }, { json: true });
  assert.equal(JSON.parse(text).error, 'nope');
  assert.equal(exit, 2);
});
test('emit text mode prints rows as lines', () => {
  const { text } = emit({ ok: true, data: [{ id: 1, name: 'a' }] }, { json: false });
  assert.match(text, /id=1\s+name=a/);
});
test('parseFlags', () => {
  const r = parseFlags(['list-pets', '--fields', 'id,name', '--limit', '5', '--dry-run', '--status', 'sold']);
  assert.deepEqual(r.positional, ['list-pets']);
  assert.deepEqual(r.flags.fields, ['id', 'name']);
  assert.equal(r.flags.limit, 5);
  assert.equal(r.flags.dryRun, true);
  assert.equal(r.flags.status, 'sold');
});
