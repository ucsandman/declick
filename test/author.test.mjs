import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Env before the first import: manifest.mjs reads DECLICK_HOME once, at module load.
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-author-'));
process.env.DECLICK_DESK = join(process.cwd(), 'test', 'fake-desk.mjs');
process.env.DECLICK_AUTHOR = join(process.cwd(), 'test', 'fake-author.mjs');
const { buildPrompt, parseRecipe, validateRecipe } = await import('../src/author.mjs');

const good = { verb: 'add', description: 'Add two numbers', args: [{ name: 'a' }, { name: 'b' }], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:{{a}}'], as: 'a' }, { click: 'a' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }],
  returns: 'result', example: ['Seven', 'Seven'], expect: '14' };

test('prompt names the window, goal, snapshot command and output rules', () => {
  const p = buildPrompt({ window: 'Calculator', goal: 'add two numbers', verb: 'add', desk: 'C:/x/desk' });
  for (const s of ['Calculator', 'add two numbers', 'bash "C:/x/desk" snapshot "Calculator"', 'ControlType:Name', '"example"', '"expect"', '```json']) assert.ok(p.includes(s), `missing ${s}`);
  assert.ok(!p.includes('\u2014'), 'no em dashes');
});
test('repair prompt carries the old recipe and the diff', () => {
  const p = buildPrompt({ window: 'Calculator', goal: 'add two numbers', verb: 'add', desk: 'd', seed: { recipe: good, diff: { missing: ['Button:Plus'], added: ['Button:Plus Sign'] }, error: 'element not found: Button:Plus' } });
  assert.ok(p.includes('Button:Plus Sign')); assert.ok(p.includes('element not found')); assert.ok(p.includes('"verb": "add"'));
});
test('parseRecipe takes the last json fence', () => {
  const text = 'thinking...\n```json\n{"verb":"x"}\n```\nfinal:\n```json\n' + JSON.stringify(good) + '\n```\n';
  assert.deepEqual(parseRecipe(text), good);
});
test('parseRecipe rejects missing or broken fences', () => {
  assert.throws(() => parseRecipe('no fence here'), e => e.exit === 1 && /json/.test(e.message));
  assert.throws(() => parseRecipe('```json\n{oops\n```'), e => e.exit === 1);
});
test('validateRecipe', () => {
  assert.deepEqual(validateRecipe(good), []);
  assert.ok(validateRecipe({ ...good, verb: 'Bad Name' }).some(e => /kebab/.test(e)));
  assert.ok(validateRecipe({ ...good, steps: [{ jump: 1 }] }).some(e => /unknown step/.test(e)));
  assert.ok(validateRecipe({ ...good, example: undefined }).some(e => /example/.test(e)));
  assert.ok(validateRecipe({ ...good, steps: [{ find: ['Button:X'] }] }).some(e => /as/.test(e)));
});
