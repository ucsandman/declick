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
