import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-'));
process.env.DECLICK_DESK = join(process.cwd(), 'test', 'fake-desk.mjs');
const { compile, execute } = await import('../src/engines/desktop.mjs');

const recipes = mkdtempSync(join(tmpdir(), 'recipes-'));
writeFileSync(join(recipes, 'add.json'), JSON.stringify({
  description: 'Add two digits and read the display', args: [{ name: 'a' }, { name: 'b' }], mutating: true,
  steps: [
    { window: 'Calculator' },
    { find: ['Group:Number pad', 'Button:{{a}}'], as: 'first' }, { click: 'first' },
    { find: ['Group:Standard operators', 'Button:Plus'], as: 'plus' }, { click: 'plus' },
    { find: ['Group:Number pad', 'Button:{{b}}'], as: 'second' }, { click: 'second' },
    { find: ['Group:Standard operators', 'Button:Equals'], as: 'eq' }, { click: 'eq' },
    { find: ['Text:Display is *'], as: 'display' }, { read: 'display', as: 'result' },
  ], returns: 'result',
}));

test('compile without recipes explains phase 3', async () => {
  await assert.rejects(() => compile('app:Calculator', { name: 'calc' }), /recipes/);
});
test('compile with recipes builds verbs', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  assert.equal(m.engine, 'desktop'); assert.equal(m.window, 'Calculator');
  assert.equal(m.verbs[0].name, 'add'); assert.equal(m.verbs[0].mutating, true);
  assert.deepEqual(m.verbs[0].args, [{ name: 'a' }, { name: 'b' }]);
});
test('dry-run resolves paths without acting', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  const log = join(tmpdir(), `desk-${Date.now()}.log`); process.env.FAKE_DESK_LOG = log;
  const r = await execute(m, 'add', ['Seven', 'Seven'], { dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.steps.some(s => s.would === 'click' && s.ref === '@e3'));
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(calls.every(c => c[0] === 'snapshot'), 'dry-run only snapshots');
});
test('unarmed acting maps to exit 3', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '0';
  const r = await execute(m, 'add', ['Seven', 'Seven'], {});
  assert.equal(r.exit, 3); assert.match(r.error, /desk arm/);
});
test('armed replay returns the display', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '1'; process.env.FAKE_DESK_DISPLAY = '14';
  const r = await execute(m, 'add', ['Seven', 'Seven'], {});
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'Display is 14');
});
test('missing element exits 2 with diff', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '1';
  const r = await execute(m, 'add', ['Nine', 'Seven'], {});
  assert.equal(r.exit, 2); assert.match(r.error, /Button:Nine/);
});
test('STOP maps to exit 3', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_STOP = '1';
  const r = await execute(m, 'add', ['Seven', 'Seven'], {});
  assert.equal(r.exit, 3); delete process.env.FAKE_DESK_STOP;
});
