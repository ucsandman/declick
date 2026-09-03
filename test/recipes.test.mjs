import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-recipes-'));
const { recipesDir, saveRecipe, loadRecipe, listRecipes, importRecipes, removeRecipe, validateStoredRecipe } = await import('../src/recipes.mjs');
const { compile } = await import('../src/engines/desktop.mjs');

const add = { description: 'Add two numbers', args: [{ name: 'a' }, { name: 'b' }], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:{{a}}'], as: 'a' }, { click: 'a' }, { read: 'a', as: 'r' }], returns: 'r' };

test('save, load, list', () => {
  const p = saveRecipe('calc', 'add', add);
  assert.equal(p, join(recipesDir('calc'), 'add.json'));
  assert.deepEqual(loadRecipe('calc', 'add'), add);
  assert.deepEqual(listRecipes('calc'), ['add']);
  assert.throws(() => loadRecipe('calc', 'nope'), e => e.exit === 2);
});
test('import copies a directory into the store', () => {
  const names = importRecipes('calc2', 'fixtures/calculator');
  assert.deepEqual(names, ['add']);
  assert.ok(existsSync(join(recipesDir('calc2'), 'add.json')));
});
test('compile reads the store when no recipes dir is given', async () => {
  const m = await compile('app:Calculator', { name: 'calc' });
  assert.equal(m.verbs.length, 1); assert.equal(m.verbs[0].name, 'add');
});
test('compile without any recipes says how to author', async () => {
  await assert.rejects(compile('app:Paint', { name: 'paint' }), e => e.exit === 1 && /declick add app:Paint --goal/.test(e.message));
});
test('validateStoredRecipe catches the recipes execute cannot run', () => {
  assert.deepEqual(validateStoredRecipe(add), []);
  assert.ok(validateStoredRecipe({ ...add, steps: [] }).some(e => /non-empty/.test(e)));
  assert.ok(validateStoredRecipe({ ...add, returns: 'a' }).some(e => /read/.test(e)));
  assert.ok(validateStoredRecipe({ ...add, steps: [{ click: 'ghost' }] }).some(e => /ghost/.test(e)));
  assert.ok(validateStoredRecipe({ ...add, steps: [{ find: ['Button:X'] }] }).some(e => /as/.test(e)));
});
test('import takes a single json file and names the verb after it', () => {
  assert.deepEqual(importRecipes('calc3', join('fixtures', 'calculator', 'add.json')), ['add']);
  assert.ok(existsSync(join(recipesDir('calc3'), 'add.json')));
});
test('import from - needs a verb', () => {
  assert.throws(() => importRecipes('calc4', '-'), e => e.exit === 1 && /verb/.test(e.message));
});
test('import from - reads the recipe on stdin', () => {
  const src = "const { importRecipes, loadRecipe } = await import('./src/recipes.mjs'); importRecipes('calc5', '-', { verb: 'add' }); console.log(loadRecipe('calc5', 'add').returns);";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { input: readFileSync(join('fixtures', 'calculator', 'add.json')), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /result/);
});
test('import validates every recipe before copying any', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bad-import-'));
  writeFileSync(join(dir, 'aaa.json'), JSON.stringify(add));
  writeFileSync(join(dir, 'zzz.json'), JSON.stringify({ ...add, steps: [{ click: 'ghost' }] }));
  assert.throws(() => importRecipes('calc6', dir), e => e.exit === 1 && /zzz\.json/.test(e.message) && /ghost/.test(e.message));
  assert.ok(!existsSync(join(recipesDir('calc6'), 'aaa.json')), 'nothing copied when one recipe is bad');
});
test('removeRecipe unlinks and returns what is left', () => {
  saveRecipe('calc7', 'add', add); saveRecipe('calc7', 'sub', add);
  assert.deepEqual(removeRecipe('calc7', 'add'), ['sub']);
  assert.deepEqual(removeRecipe('calc7', 'add'), ['sub']);
});
test('recipe verbs must be kebab-case', () => {
  assert.throws(() => saveRecipe('calc', 'Bad Verb', add), e => e.exit === 1 && /verb/.test(e.message));
  assert.throws(() => loadRecipe('calc', '../escape'), e => e.exit === 1 && /verb/.test(e.message));
});

const base = steps => ({ description: 'd', args: [], steps });
const errsOf = steps => validateStoredRecipe(base(steps));
const find = { find: ['Group:Number pad', 'Button:Seven'], as: 'seven' };

test('validateStoredRecipe accepts the 0.3 step vocabulary', () => {
  assert.deepEqual(validateStoredRecipe({
    description: 'd', args: [], mutating: true,
    launch: { command: 'calc.exe', args: [], waitForWindow: 'Calculator', timeout: 8000 },
    steps: [
      { window: 'Calculator' }, { launch: { command: 'calc.exe' } }, find,
      { read: 'seven', prop: 'value', as: 'v' }, { 'read-all': ['List:History', 'ListItem:*'], as: 'rows', fields: { answer: 'Text:Answer' } },
      { 'wait-for': ['Text:Display is *'], timeout: 3000 }, { 'wait-for-text': { as: 'seven', text: 'Seven' } },
      { scroll: 'seven' }, { expand: 'seven' }, { collapse: 'seven' }, { select: 'seven' }, { context: 'seven' },
      { set: ['seven', 'on'] }, { assert: { as: 'seven', prop: 'name', equals: 'Seven' } },
      { clipboard: 'get', as: 'clip' }, { clipboard: 'set', text: 'hi' }, { dismiss: true },
      { click: 'seven', optional: true },
    ], returns: 'rows',
  }), []);
});
test('validateStoredRecipe rejects a malformed read-all', () => {
  assert.ok(errsOf([find, { 'read-all': ['ListItem:*'] }]).some(e => /as/.test(e)));
  assert.ok(errsOf([{ 'read-all': 'ListItem:*', as: 'r' }]).some(e => /Type:Name/.test(e)));
  assert.ok(errsOf([{ 'read-all': ['ListItem:*'], as: 'r', fields: ['a'] }]).some(e => /fields/.test(e)));
  assert.ok(errsOf([{ 'read-all': ['ListItem:*'], as: 'r', fields: { a: 'noColon' } }]).some(e => /fields/.test(e)));
});
test('validateStoredRecipe rejects a bad read prop', () => {
  assert.ok(errsOf([find, { read: 'seven', prop: 'colour', as: 'v' }]).some(e => /prop/.test(e)));
  assert.deepEqual(errsOf([find, { read: 'seven', prop: 'toggle', as: 'v' }]), []);
});
test('validateStoredRecipe checks the new acting steps name an earlier find', () => {
  for (const k of ['scroll', 'expand', 'collapse', 'select', 'context']) {
    assert.ok(errsOf([{ [k]: 'ghost' }]).some(e => /ghost/.test(e)), k);
  }
  assert.ok(errsOf([{ set: ['ghost', 'on'] }]).some(e => /ghost/.test(e)));
  assert.ok(errsOf([find, { set: ['seven', 'maybe'] }]).some(e => /on\|off|on, off/.test(e)));
});
test('validateStoredRecipe checks wait-for, wait-for-text, assert, clipboard, dismiss and launch', () => {
  assert.ok(errsOf([{ 'wait-for': 'Text:x' }]).some(e => /Type:Name/.test(e)));
  assert.ok(errsOf([{ 'wait-for': ['Text:x'], timeout: 'soon' }]).some(e => /timeout/.test(e)));
  assert.ok(errsOf([{ 'wait-for-text': { text: '' } }]).some(e => /text/.test(e)));
  assert.ok(errsOf([{ 'wait-for-text': { as: 'ghost', text: 'x' } }]).some(e => /ghost/.test(e)));
  assert.ok(errsOf([find, { assert: { as: 'seven' } }]).some(e => /equals/.test(e)));
  assert.ok(errsOf([{ assert: { as: 'ghost', equals: 'x' } }]).some(e => /ghost/.test(e)));
  assert.ok(errsOf([find, { assert: { as: 'seven', matches: '([' } }]).some(e => /regex/.test(e)));
  assert.ok(errsOf([{ clipboard: 'get' }]).some(e => /as/.test(e)));
  assert.ok(errsOf([{ clipboard: 'set' }]).some(e => /text/.test(e)));
  assert.ok(errsOf([{ clipboard: 'paste', as: 'x' }]).some(e => /get/.test(e)));
  assert.ok(errsOf([{ dismiss: 'yes' }]).some(e => /dismiss/.test(e)));
  assert.ok(errsOf([{ launch: { args: [] } }]).some(e => /command/.test(e)));
  assert.ok(errsOf([{ launch: { command: 'x', args: 'y' } }]).some(e => /args/.test(e)));
  assert.ok(errsOf([{ launch: { command: '{{app}}' } }]).some(e => /literal/.test(e)));
});
test('validateStoredRecipe lets returns name a read-all or a clipboard read', () => {
  assert.deepEqual(validateStoredRecipe({ ...base([{ 'read-all': ['ListItem:*'], as: 'rows' }]), returns: 'rows' }), []);
  assert.deepEqual(validateStoredRecipe({ ...base([{ clipboard: 'get', as: 'clip' }]), returns: 'clip' }), []);
  assert.ok(validateStoredRecipe({ ...base([find]), returns: 'seven' }).some(e => /read/.test(e)));
});
test('validateStoredRecipe checks a top-level launch block', () => {
  assert.ok(validateStoredRecipe({ ...base([find]), launch: { command: '' } }).some(e => /launch: command/.test(e)));
  assert.deepEqual(validateStoredRecipe({ ...base([find]), launch: { command: 'calc.exe' } }), []);
});
test('optional is a modifier, not a step of its own', () => {
  assert.deepEqual(errsOf([{ ...find, optional: true }]), []);
  assert.ok(errsOf([{ optional: true }]).some(e => /unknown step/.test(e)));
  assert.ok(errsOf([{ ...find, optional: 'yes' }]).some(e => /optional/.test(e)));
});
