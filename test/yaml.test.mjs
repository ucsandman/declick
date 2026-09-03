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
