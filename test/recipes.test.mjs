import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-recipes-'));
const { recipesDir, saveRecipe, loadRecipe, listRecipes, importRecipes } = await import('../src/recipes.mjs');
const { compile } = await import('../src/engines/desktop.mjs');

const add = { description: 'Add two numbers', args: [{ name: 'a' }, { name: 'b' }], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:{{a}}'], as: 'a' }, { click: 'a' }], returns: 'a' };

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
