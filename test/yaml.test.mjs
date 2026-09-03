import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, isYaml } from '../src/yaml.mjs';

const fixtures = join(import.meta.dirname, '..', 'fixtures');

test('parses fixtures/petstore.yaml to the same shape as fixtures/petstore.json', () => {
  const yaml = parseYaml(readFileSync(join(fixtures, 'petstore.yaml'), 'utf8'));
  const json = JSON.parse(readFileSync(join(fixtures, 'petstore.json'), 'utf8'));
  assert.deepEqual(yaml, json);
});

test('parses fixtures/openverse.yaml (multi-line quoted description, real-world spec) with all paths and components intact', () => {
  const doc = parseYaml(readFileSync(join(fixtures, 'openverse.yaml'), 'utf8'));
  assert.equal(Object.keys(doc.paths).length, 17);
  assert.ok(doc.components);
});

test('tricky scalars resolve to the same types JSON would give them', () => {
  const doc = `
n1: null
n2: ~
n3: Null
b1: true
b2: False
i1: 42
i2: -7
f1: 3.14
f2: -2.5e3
str_num: "42"
str_bool: 'true'
plain: hello world
dq: "line\\nbreak \\"quoted\\" \\u0041"
sq: 'it''s fine'
`;
  const v = parseYaml(doc);
  assert.deepEqual(v, {
    n1: null, n2: null, n3: null,
    b1: true, b2: false,
    i1: 42, i2: -7,
    f1: 3.14, f2: -2500,
    str_num: '42', str_bool: 'true',
    plain: 'hello world',
    dq: 'line\nbreak "quoted" A',
    sq: "it's fine",
  });
});

test('parses fixtures/petstore-zero-indent.yaml (block sequences at the same indent as their key) to the same shape as fixtures/petstore.json', () => {
  const yaml = parseYaml(readFileSync(join(fixtures, 'petstore-zero-indent.yaml'), 'utf8'));
  const json = JSON.parse(readFileSync(join(fixtures, 'petstore.json'), 'utf8'));
  assert.deepEqual(yaml, json);
});

test('a block sequence at the same indent as its mapping key parses instead of dropping the key and the mapping after it', () => {
  const v = parseYaml('a:\n  list:\n  - k: 1\n    j: 2\nb:\n  y: 9\n');
  assert.deepEqual(v, { a: { list: [{ k: 1, j: 2 }] }, b: { y: 9 } });
});

test('a same-indent sequence nested inside a same-indent sequence item still parses, and sibling keys after it survive', () => {
  const v = parseYaml('a:\n- x: 1\n  list:\n  - p: 1\n  - p: 2\n  after: 2\n');
  assert.deepEqual(v, { a: [{ x: 1, list: [{ p: 1 }, { p: 2 }], after: 2 }] });
});

test('a same-indent sequence followed by more keys in the same mapping keeps parsing those keys', () => {
  const v = parseYaml('list:\n- 1\n- 2\nnext: 3\n');
  assert.deepEqual(v, { list: [1, 2], next: 3 });
});

test('an unquoted scalar folds onto more-indented continuation lines instead of dropping the mapping key that follows', () => {
  const v = parseYaml('a:\n  b: one two\n    three four\n  c: 2\n');
  assert.deepEqual(v, { a: { b: 'one two three four', c: 2 } });
});

test('an anchored value that is a same-indent block sequence parses the sequence and keeps the sibling key after it', () => {
  const v = parseYaml('a: &an\n- 1\n- 2\nb: 9\n');
  assert.deepEqual(v, { a: [1, 2], b: 9 });
});

test('a plain-scalar sequence item folds onto its own continuation line and keeps the sibling key after it', () => {
  const v = parseYaml('a:\n- foo\n  bar\nb: 1\n');
  assert.deepEqual(v, { a: ['foo bar'], b: 1 });
});

test('a block-scalar sequence item (Stripe spec3.yaml shape) parses among plain items and keeps the sibling key after it', () => {
  const v = parseYaml('a:\n- one\n- >-\n  two three\n- four\nb: 1\n');
  assert.deepEqual(v, { a: ['one', 'two three', 'four'], b: 1 });
});

test('a quoted scalar that continues on following lines folds like a block scalar (blank line to newline, else space)', () => {
  const single = parseYaml("a: 'one\n  two\n\n  three'\nb: 1\n");
  assert.deepEqual(single, { a: 'one two\nthree', b: 1 });
  const double = parseYaml('a: "one\n  two"\nb: 1\n');
  assert.deepEqual(double, { a: 'one two', b: 1 });
});

test('anchors, aliases and merge keys', () => {
  const doc = `
base: &base
  a: 1
  b: 2
derived:
  <<: *base
  b: 3
  c: 4
x: &n 5
y: *n
`;
  const v = parseYaml(doc);
  assert.deepEqual(v.base, { a: 1, b: 2 });
  assert.deepEqual(v.derived, { a: 1, b: 3, c: 4 });
  assert.equal(v.y, 5);
});

test('literal and folded block scalars honor strip/clip/keep chomping', () => {
  const doc = `
lit_strip: |-
  line1
  line2
lit_clip: |
  line1
  line2
lit_keep: |+
  line1
  line2

fold_blank: >
  a
  b

  c
next2: ok
`;
  const v = parseYaml(doc);
  assert.equal(v.lit_strip, 'line1\nline2');
  assert.equal(v.lit_clip, 'line1\nline2\n');
  assert.equal(v.lit_keep, 'line1\nline2\n\n');
  assert.equal(v.fold_blank, 'a b\nc\n');
  assert.equal(v.next2, 'ok');
});

test('a clear error names the line number for unsupported constructs', () => {
  assert.throws(() => parseYaml('top: 1\nbad: !!str value\n'), /line 2/);
  assert.throws(() => parseYaml('a: 1\n? complex\n  key: value\n'), /line 2/);
});

test('flow collections nest: sequences of mappings, mappings of sequences', () => {
  const v = parseYaml('a: [{ x: 1, y: [1, 2, 3] }, { x: 2, y: [] }]\n');
  assert.deepEqual(v, { a: [{ x: 1, y: [1, 2, 3] }, { x: 2, y: [] }] });
});

test('a 1MB document parses in under a second', () => {
  const lines = [];
  let size = 0;
  for (let i = 0; size < 1_000_000; i++) { const l = `key${i}: value number ${i}`; lines.push(l); size += l.length + 1; }
  const doc = lines.join('\n');
  const start = Date.now();
  const v = parseYaml(doc);
  const ms = Date.now() - start;
  assert.ok(ms < 1000, `parse took ${ms}ms`);
  assert.equal(v.key0, 'value number 0');
  assert.equal(Object.keys(v).length, lines.length);
});

test('isYaml decides by extension for paths and by shape for raw text', () => {
  assert.equal(isYaml('spec.yaml'), true);
  assert.equal(isYaml('spec.yml'), true);
  assert.equal(isYaml('spec.json'), false);
  assert.equal(isYaml('openapi: 3.0.0\ninfo:\n  title: x\n'), true);
  assert.equal(isYaml('{"openapi": "3.0.0"}'), false);
});
