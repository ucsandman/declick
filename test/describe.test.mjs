import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, describeJson } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';

const m = { name: 'pet', engine: 'openapi', source: 'x.json', baseUrl: 'https://api.example.com/v1', builtAt: 'now', auth: { env: ['PET_TOKEN'] }, verbs: [
  { name: 'list-pets', description: 'List pets by status', args: [], flags: [{ name: 'status', description: 'available|pending|sold', required: true }], mutating: false, http: { path: '/pets' } },
  { name: 'add-pet', description: 'Create a pet', args: [{ name: 'name', required: true }], flags: [], mutating: true, http: { path: '/pets/{name}' } },
] };

test('describe is compact and lists verbs', () => {
  const s = describe(m);
  assert.match(s, /^pet \(openapi\)  source: x\.json  base: https:\/\/api\.example\.com\/v1/);
  assert.match(s, /list-pets\s+List pets by status/);
  assert.match(s, /add-pet <name>\s+Create a pet \[mutating\]/);
  assert.match(s, /--json --fields --limit --dry-run --full/);
  assert.ok(!s.includes('available|pending|sold'), 'flag detail only in --full');
  assert.ok(s.length < 2000);
});
test('describe --full includes flag detail and required markers', () => assert.match(describe(m, { full: true }), /--status \(required\)\s+available\|pending\|sold/));
test('describe --verb narrows to one verb', () => { const s = describe(m, { verb: 'add-pet', full: true }); assert.ok(s.includes('add-pet') && !s.includes('list-pets')); });
test('describeJson is the manifest minus internals', () => {
  const j = describeJson(m);
  assert.equal(j.baseUrl, m.baseUrl); assert.equal(j.window, null);
  assert.deepEqual(j.verbs.map(v => v.name), ['list-pets', 'add-pet']);
  assert.equal(j.verbs[0].http, undefined);
  assert.deepEqual(describeJson(m, { verb: 'add-pet' }).verbs.map(v => v.name), ['add-pet']);
});
test('lint passes a good manifest', () => assert.deepEqual(lint(m), []));
test('lint fails oversized describe and names the filter flags', () => {
  const big = { ...m, verbs: Array.from({ length: 80 }, (_, i) => ({ name: `verb-${i}`, description: 'x'.repeat(60), args: [], flags: [], mutating: false })) };
  assert.ok(lint(big).some(e => /2000/.test(e) && /--verbs/.test(e)));
});
test('lint fails duplicate verbs', () => {
  assert.ok(lint({ ...m, verbs: [m.verbs[0], m.verbs[0]] }).some(e => /duplicate/.test(e)));
});
test('lint reserves describe and the contract flags, and requires an absolute baseUrl', () => {
  assert.ok(lint({ ...m, verbs: [{ ...m.verbs[0], name: 'describe' }] }).some(e => /reserved verb/.test(e)));
  assert.ok(lint({ ...m, verbs: [{ ...m.verbs[0], flags: [{ name: 'limit' }] }] }).some(e => /--limit collides/.test(e)));
  assert.ok(lint({ ...m, verbs: [{ ...m.verbs[0], args: [{ name: 'dry-run' }] }] }).some(e => /reserved/.test(e)));
  assert.ok(lint({ ...m, baseUrl: '/api/v3' }).some(e => /absolute/.test(e)));
  assert.ok(lint({ ...m, baseUrl: 'https://{region}.example.com' }).some(e => /variables/.test(e)));
  assert.ok(lint({ ...m, verbs: [{ ...m.verbs[1], args: [] }] }).some(e => /\{name\} has no arg/.test(e)));
});
