import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSnapshot, findByPath, findAll, candidates, treeDiff } from '../src/engines/desktop-tree.mjs';

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

const ATTRS = `@e1 Window "Settings" [0,0]
  @e2 Edit "Search" [10,20] value="hello \\" world"
  @e3 CheckBox "Dark mode" [10,40] toggle=on
  @e4 ListItem "Row" [10,60] selected=true
  @e5 Button "Save" [10,80] enabled=false
  @e6 ComboBox "Theme" [10,100] value="Light" expanded=false
  @e7 Text "Hidden" [10,120] offscreen=true
@e8 Window "" [0,0] popup="Context menu"
# offscreen=4`;

test('parseSnapshot reads the attribute tail and the offscreen trailer', () => {
  const els = parseSnapshot(ATTRS);
  assert.equal(els.length, 8);
  assert.equal(els.offscreen, 4);
  assert.equal(els[1].value, 'hello " world');
  assert.equal(els[2].toggle, 'on');
  assert.equal(els[3].selected, true);
  assert.equal(els[4].enabled, false);
  assert.equal(els[5].expanded, false);
  assert.equal(els[5].value, 'Light');
  assert.equal(els[6].offscreen, true);
  assert.equal(els[7].popup, 'Context menu');
  assert.deepEqual(Object.keys(els[0]), ['ref', 'depth', 'type', 'name', 'x', 'y']);
});
test('parseSnapshot keeps the 0.2 line shape when there is no attribute tail', () => {
  const els = parseSnapshot(SNAP);
  assert.deepEqual(els[2], { ref: '@e3', depth: 2, type: 'Button', name: 'Seven', x: 30, y: 310 });
  assert.equal(els.offscreen, 0);
});
test('parseSnapshot survives a value that itself contains a coordinate pair', () => {
  const els = parseSnapshot('@e1 Edit "n" [1,2] value="x\\" [3,4]"');
  assert.equal(els.length, 1);
  assert.equal(els[0].name, 'n'); assert.equal(els[0].x, 1); assert.equal(els[0].value, 'x" [3,4]');
});
test('findAll returns every match in tree order', () => {
  const els = parseSnapshot(SNAP);
  assert.deepEqual(findAll(els, ['Group:*', 'Button:*']).map(e => e.ref), ['@e3', '@e4', '@e6', '@e7']);
  assert.deepEqual(findAll(els, ['Text:Display is *']).map(e => e.ref), ['@e8']);
  assert.deepEqual(findAll(els, ['Button:Nine']), []);
  assert.deepEqual(findAll(els, []), []);
});
test('candidates names the deepest resolved ancestor and what is under it', () => {
  const els = parseSnapshot(SNAP);
  const c = candidates(els, ['Group:Number pad', 'Button:Nine']);
  assert.deepEqual(c.resolved, ['Group:Number pad']);
  assert.deepEqual(c.candidates.slice(0, 2).map(e => e.name), ['Seven', 'Eight']);
  assert.ok(c.candidates.every(e => e.ref && e.type && typeof e.name === 'string'));
});
test('candidates adds the nearest names from elsewhere in the tree', () => {
  const els = parseSnapshot(SNAP);
  const c = candidates(els, ['Group:Standard operators', 'Button:Eigth']);
  assert.deepEqual(c.resolved, ['Group:Standard operators']);
  assert.ok(c.candidates.some(e => e.name === 'Eight'), JSON.stringify(c.candidates));
  assert.ok(c.candidates.length <= 15);
});
test('candidates with nothing resolved falls back to the top of the tree', () => {
  const els = parseSnapshot(SNAP);
  const c = candidates(els, ['Group:Missing', 'Button:Seven']);
  assert.deepEqual(c.resolved, []);
  assert.ok(c.candidates.length > 0);
});
test('the real deskclaw snapshot fixture parses with its attributes', () => {
  const els = parseSnapshot(readFileSync('fixtures/deskclaw-snapshot.txt', 'utf8'));
  assert.ok(els.length > 60, `parsed ${els.length}`);
  assert.equal(els.offscreen, 2);
  assert.equal(findByPath(els, ['Window:Calculator', 'Group:Number pad', 'Button:Seven']).type, 'Button');
  assert.equal(findByPath(els, ['Window:Calculator', 'Text:Scientific Calculator mode']).value, 'Scientific');
  assert.equal(els.find(e => e.name === 'Clear all memory').enabled, false);
  assert.equal(els.find(e => e.name === 'Scientific notation').toggle, 'off');
  assert.equal(els.find(e => e.popup !== undefined).popup, 'Settings');
  assert.equal(findAll(els, ['Group:Number pad', 'Button:*']).length, 11);
});
