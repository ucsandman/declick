import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot, findByPath, treeDiff } from '../src/engines/desktop-tree.mjs';

const SNAP = `@e1 Window "Calculator" [10,10]
  @e2 Group "Number pad" [20,300]
    @e3 Button "Seven" [30,310]
    @e4 Button "Eight" [60,310]
  @e5 Group "Standard operators" [20,400]
    @e6 Button "Plus" [30,410]
    @e7 Button "Equals" [60,410]
  @e8 Text "Display is 0" [20,100]`;

test('parseSnapshot', () => {
  const els = parseSnapshot(SNAP);
  assert.equal(els.length, 8);
  assert.deepEqual(els[2], { ref: '@e3', depth: 2, type: 'Button', name: 'Seven', x: 30, y: 310 });
});
test('findByPath walks descendants', () => {
  const els = parseSnapshot(SNAP);
  assert.equal(findByPath(els, ['Group:Number pad', 'Button:Eight']).ref, '@e4');
  assert.equal(findByPath(els, ['Group:Standard operators', 'Button:Eight']), null);
  assert.equal(findByPath(els, ['Text:Display is *']).ref, '@e8');
  assert.equal(findByPath(els, ['Button:*']).ref, '@e3');
});
test('findByPath backtracks out of a dead-end branch', () => {
  const els = parseSnapshot(SNAP);
  assert.equal(findByPath(els, ['Group:*', 'Button:Equals']).ref, '@e7');
  assert.equal(findByPath(els, ['Window:*', 'Group:*', 'Button:Plus']).ref, '@e6');
  assert.equal(findByPath(els, ['Group:*', 'Button:Nine']), null);
});
test('treeDiff reports missing and added', () => {
  const a = parseSnapshot(SNAP);
  const b = parseSnapshot(SNAP.replace('Button "Eight"', 'Button "Nine"'));
  assert.deepEqual(treeDiff(a, b), { missing: ['Button:Eight'], added: ['Button:Nine'] });
});
