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

const { author } = await import('../src/author.mjs');
const { recipesDir } = await import('../src/recipes.mjs');
const { manifestDir } = await import('../src/manifest.mjs');

test('author saves a recipe when the live replay matches expect', async () => {
  process.env.FAKE_AUTHOR_RECIPE = JSON.stringify(good);
  process.env.FAKE_DESK_ARMED = '1'; process.env.FAKE_DESK_DISPLAY = '14';
  process.env.FAKE_AUTHOR_LOG = join(process.env.DECLICK_HOME, 'prompt.txt');
  const out = await author({ name: 'calc', window: 'Calculator', goal: 'add two numbers', verb: 'add' });
  assert.equal(out.result, 'Display is 14');
  assert.ok(existsSync(join(recipesDir('calc'), 'add.json')));
  const saved = JSON.parse(readFileSync(join(recipesDir('calc'), 'add.json'), 'utf8'));
  assert.ok(saved.tree.includes('Button:Seven'));
  assert.ok(readFileSync(process.env.FAKE_AUTHOR_LOG, 'utf8').includes('add two numbers'));
});
test('author keeps a proposal and exits 2 when expect does not match', async () => {
  process.env.FAKE_AUTHOR_RECIPE = JSON.stringify({ ...good, verb: 'sub', expect: '^Display is 99$' });
  process.env.FAKE_DESK_ARMED = '1'; process.env.FAKE_DESK_DISPLAY = '14';
  await assert.rejects(author({ name: 'calc', window: 'Calculator', goal: 'subtract', verb: 'sub' }), e => e.exit === 2 && /expected/.test(e.message));
  assert.ok(existsSync(join(manifestDir('calc'), 'proposals', 'sub.json')));
  assert.ok(!existsSync(join(recipesDir('calc'), 'sub.json')));
});
test('author exits 2 when dry-run cannot find an element', async () => {
  process.env.FAKE_AUTHOR_RECIPE = JSON.stringify({ ...good, verb: 'nine', steps: [{ window: 'Calculator' }, { find: ['Button:Nine'], as: 'n' }, { read: 'n', as: 'r' }], returns: 'r' });
  process.env.FAKE_DESK_ARMED = '1';
  await assert.rejects(author({ name: 'calc', window: 'Calculator', goal: 'x', verb: 'nine' }), e => e.exit === 2 && /dry-run failed/.test(e.message));
});
test('author exits 3 when replay is not armed', async () => {
  process.env.FAKE_AUTHOR_RECIPE = JSON.stringify({ ...good, verb: 'add2' });
  delete process.env.FAKE_DESK_ARMED;
  await assert.rejects(author({ name: 'calc', window: 'Calculator', goal: 'x', verb: 'add2' }), e => e.exit === 3);
});
test('author exits 1 when the model produces no recipe', async () => {
  process.env.FAKE_AUTHOR_MODE = 'nofence';
  await assert.rejects(author({ name: 'calc', window: 'Calculator', goal: 'x', verb: 'add3' }), e => e.exit === 1 && /json/.test(e.message));
  delete process.env.FAKE_AUTHOR_MODE;
});
test('author clamps a long description to the 80 char lint cap', async () => {
  const long = 'Multiply two numbers entered as calculator digit names and return the display text after equals';
  process.env.FAKE_AUTHOR_RECIPE = JSON.stringify({ ...good, verb: 'mul', description: long });
  process.env.FAKE_DESK_ARMED = '1'; process.env.FAKE_DESK_DISPLAY = '14';
  await author({ name: 'calc', window: 'Calculator', goal: 'x', verb: 'mul' });
  const saved = JSON.parse(readFileSync(join(recipesDir('calc'), 'mul.json'), 'utf8'));
  assert.ok(saved.description.length <= 80 && saved.description.length > 40, saved.description);
  assert.ok(!/\s$/.test(saved.description));
});
