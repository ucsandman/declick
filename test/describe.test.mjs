import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, describeJson } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';

const m = { name: 'pet', engine: 'openapi', source: 'x.json', baseUrl: 'https://api.example.com/v1', builtAt: 'now', auth: { env: ['PET_TOKEN'] }, verbs: [
  { name: 'list-pets', description: 'List pets by status', args: [], flags: [{ name: 'status', description: 'available|pending|sold', required: true }], mutating: false, http: { path: '/pets' }, returns: { shape: 'object', rowsPath: 'items', fields: [{ name: 'id' }, { name: 'name' }, { name: 'status' }] } },
  { name: 'add-pet', description: 'Create a pet', args: [{ name: 'name', required: true }], flags: [], mutating: true, http: { path: '/pets/{name}' }, returns: { shape: 'object', fields: [{ name: 'id' }, { name: 'name' }] } },
] };

test('describe is compact and lists verbs', () => {
  const s = describe(m);
  assert.match(s, /^pet \(openapi\)  source: x\.json  base: https:\/\/api\.example\.com\/v1/);
  assert.match(s, /list-pets\s+List pets by status/);
  assert.match(s, /add-pet <name>\s+Create a pet \[mutating\]/);
  assert.match(s, /--json --fields --limit --rows --dry-run --full/);
  assert.ok(!s.includes('available|pending|sold'), 'flag detail only in --full');
  assert.ok(s.length < 2000);
});
test('the first line says how many alternate servers there are, and --full names the request flags', () => {
  const one = describe(m);
  const first = s => s.split('\n')[0];
  assert.ok(!one.includes('--server'), first(one));
  const many = { ...m, servers: [{ url: m.baseUrl }, { url: 'https://sandbox.example.com/v1', description: 'sandbox' }, { url: 'https://eu.example.com/v1' }] };
  assert.match(first(describe(many)), / base: https:\/\/api\.example\.com\/v1 \(\+2 more, --server <i\|description>\)$/);
  // The contract flags a request engine accepts are worth one line, but only for a caller who asked for detail.
  assert.match(describe(m, { full: true }), /\nrequest: --header --base-url --server --content-type --body-file --output --retry --timeout --curl --verbose\n/);
  assert.ok(!one.includes('request: --header'), 'the request line is --full only');
  assert.ok(!describe({ ...m, engine: 'sqlite', baseUrl: 'sqlite:/tmp/x.db' }, { full: true }).includes('request: --header'), 'a database takes no http flags');
});
test('describe --full includes flag detail and required markers', () => assert.match(describe(m, { full: true }), /--status \(required\)\s+available\|pending\|sold/));
test('describe --verb narrows to one verb', () => { const s = describe(m, { verb: 'add-pet', full: true }); assert.ok(s.includes('add-pet') && !s.includes('list-pets')); });
test('describe --full names what each verb returns and where its rows live', () => {
  const s = describe(m, { full: true });
  assert.match(s, /\n      -> \[ \{id, name, status\} \] rows: items\n/);
  assert.match(s, /\n      -> \{id, name\}/);
  assert.ok(!describe(m).includes('->'), 'the arrow is --full only');
  assert.ok(!describe({ ...m, verbs: [{ ...m.verbs[1], returns: { shape: 'none', fields: [] } }] }, { full: true }).includes('->'), 'nothing to say for none');
});
test('describe --full prints enum, default and example, and describeJson keeps them', () => {
  const em = { ...m, verbs: [{ ...m.verbs[0], args: [{ name: 'kind', required: true, type: 'string', enum: ['cat', 'dog'] }],
    flags: [{ name: 'status', description: 'lifecycle', required: false, type: 'string', enum: ['available', 'pending', 'sold'], default: 'available', example: 'sold' }] }] };
  const s = describe(em, { full: true });
  assert.match(s, /--status\s+lifecycle\s+one of available\|pending\|sold\s+default: available\s+e\.g\. sold/);
  assert.match(s, /<kind>\s+one of cat\|dog/);
  assert.ok(!describe(em).includes('one of'), 'facets are --full only');
  const f = describeJson(em).verbs[0].flags[0];
  assert.deepEqual(f.enum, ['available', 'pending', 'sold']);
  assert.equal(f.default, 'available'); assert.equal(f.example, 'sold');
  assert.deepEqual(describeJson(em).verbs[0].args[0].enum, ['cat', 'dog']);
});
test('describeJson is the manifest minus internals', () => {
  const j = describeJson(m);
  assert.equal(j.baseUrl, m.baseUrl); assert.equal(j.window, null);
  assert.deepEqual(j.verbs.map(v => v.name), ['list-pets', 'add-pet']);
  assert.equal(j.verbs[0].http, undefined);
  assert.deepEqual(j.verbs[0].returns, m.verbs[0].returns);
  assert.equal(describeJson({ ...m, verbs: [{ ...m.verbs[0], returns: undefined }] }).verbs[0].returns, null);
  assert.deepEqual(describeJson(m, { verb: 'add-pet' }).verbs.map(v => v.name), ['add-pet']);
});
test('lint passes a good manifest', () => assert.deepEqual(lint(m), []));
const manyVerbs = n => Array.from({ length: n }, (_, i) => ({ name: `verb-${i}`, description: `Does thing number ${i} to a resource`, args: [], flags: [], mutating: false }));
test('describe pages a large surface: stays under 2000 chars with a footer naming the total', () => {
  const big = { ...m, verbs: manyVerbs(300) };
  const s = describe(big);
  assert.ok(s.length < 2000, `length ${s.length}`);
  const footer = s.match(/\.\.\. (\d+) more verbs \(300 total\): declick describe pet --grep <text> \| --offset N --limit N \| --verb v$/m);
  assert.ok(footer, s);
  const shown = (s.match(/^  verb-\d+/gm) || []).length;
  assert.equal(shown + Number(footer[1]), 300);
});
test('describe --offset --limit shows exactly the requested page and a footer of what is left', () => {
  const big = { ...m, verbs: manyVerbs(300) };
  const s = describe(big, { offset: 280, limit: 10 });
  assert.ok(s.includes('verb-280') && s.includes('verb-289'));
  assert.ok(!s.includes('verb-279') && !s.includes('verb-290'));
  assert.match(s, /\.\.\. 10 more verbs \(300 total\)/);
});
test('describe has no footer when the whole surface already fits', () => {
  const small = { ...m, verbs: manyVerbs(12) };
  assert.ok(!describe(small).includes('more verbs'));
});
test('describe --offset --limit coerces string flags the way a CLI parser would hand them over', () => {
  const big = { ...m, verbs: manyVerbs(300) };
  const s = describe(big, { offset: '280', limit: '10' });
  assert.ok(s.includes('verb-280') && s.includes('verb-289') && !s.includes('verb-290'));
  assert.match(s, /\.\.\. 10 more verbs \(300 total\)/);
});
test('lint passes a manifest with many verbs because describe pages itself', () => {
  const big = { ...m, verbs: manyVerbs(300) };
  assert.deepEqual(lint(big), []);
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
