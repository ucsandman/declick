import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';

const m = { name: 'pet', engine: 'openapi', source: 'x.json', builtAt: 'now', auth: { env: ['PET_TOKEN'] }, verbs: [
  { name: 'list-pets', description: 'List pets by status', args: [], flags: [{ name: 'status', description: 'available|pending|sold' }], mutating: false },
  { name: 'add-pet', description: 'Create a pet', args: [{ name: 'name', required: true }], flags: [], mutating: true },
] };

test('describe is compact and lists verbs', () => {
  const s = describe(m);
  assert.match(s, /^pet \(openapi\)/);
  assert.match(s, /list-pets\s+List pets by status/);
  assert.match(s, /add-pet <name>\s+Create a pet \[mutating\]/);
  assert.match(s, /--json --fields --limit --dry-run/);
  assert.ok(!s.includes('available|pending|sold'), 'flag detail only in --full');
  assert.ok(s.length < 2000);
});
test('describe --full includes flag detail', () => assert.match(describe(m, { full: true }), /--status\s+available\|pending\|sold/));
test('lint passes a good manifest', () => assert.deepEqual(lint(m), []));
test('lint fails oversized describe', () => {
  const big = { ...m, verbs: Array.from({ length: 80 }, (_, i) => ({ name: `verb-${i}`, description: 'x'.repeat(60), args: [], flags: [], mutating: false })) };
  assert.ok(lint(big).some(e => /2000/.test(e)));
});
test('lint fails duplicate verbs', () => {
  assert.ok(lint({ ...m, verbs: [m.verbs[0], m.verbs[0]] }).some(e => /duplicate/.test(e)));
});
