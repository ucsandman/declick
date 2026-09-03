import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-'));
process.env.DECLICK_DESK = join(process.cwd(), 'test', 'fake-desk.mjs');
const { compile, execute } = await import('../src/engines/desktop.mjs');
const { manifestDir } = await import('../src/manifest.mjs');

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
  assert.equal(r.exit, 3); assert.match(r.error, /not armed/); assert.doesNotMatch(r.error, /STOP/);
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
  assert.equal(r.exit, 3); assert.match(r.error, /STOP/); assert.doesNotMatch(r.error, /not armed/); delete process.env.FAKE_DESK_STOP;
});
test('element miss records last-error.json with the diff', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '1';
  const r = await execute(m, 'add', ['Nine', 'Seven'], {});
  assert.equal(r.exit, 2);
  const le = JSON.parse(readFileSync(join(manifestDir('calc'), 'last-error.json'), 'utf8'));
  assert.equal(le.verb, 'add'); assert.ok(Array.isArray(le.diff.missing)); assert.match(le.error, /Button:Nine/);
});
test('a closed window says so instead of blaming the element', async () => {
  const m = await compile('app:Calculator', { name: 'calc-closed', recipes });
  process.env.FAKE_DESK_CLOSED = '1';
  const r = await execute(m, 'add', ['Seven', 'Seven'], { dryRun: true });
  delete process.env.FAKE_DESK_CLOSED;
  assert.equal(r.exit, 2); assert.match(r.error, /window "Calculator" is not open/);
  assert.ok(!existsSync(join(manifestDir('calc-closed'), 'last-error.json')), 'no last-error for a closed window');
});
test('a successful replay clears last-error.json', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '1'; process.env.FAKE_DESK_DISPLAY = '14';
  assert.equal((await execute(m, 'add', ['Nine', 'Seven'], {})).exit, 2);
  const p = join(manifestDir('calc'), 'last-error.json');
  assert.ok(existsSync(p), 'miss records last-error.json');
  const ok = await execute(m, 'add', ['Seven', 'Seven'], {});
  assert.equal(ok.ok, true, ok.error);
  assert.ok(!existsSync(p), 'success clears last-error.json');
});
test('an undeclared placeholder fails before touching the desktop', async () => {
  const m = { name: 'calc', window: 'Calculator', verbs: [{ name: 'add', args: [{ name: 'a' }], recipe: { steps: [{ window: 'Calculator' }, { find: ['Button:{{b}}'], as: 'x' }] } }] };
  const r = await execute(m, 'add', ['Seven'], { dryRun: true });
  assert.equal(r.exit, 1); assert.match(r.error, /undeclared \{\{b\}\}/);
});
test('the element miss diff names the unresolved path', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  process.env.FAKE_DESK_ARMED = '1';
  const r = await execute(m, 'add', ['Nine', 'Seven'], {});
  assert.deepEqual(r.data.unresolved, ['Group:Number pad', 'Button:Nine']);
});
test('a missing deskclaw binary explains where to get it', async () => {
  const m = await compile('app:Calculator', { name: 'calc', recipes });
  const real = process.env.DECLICK_DESK;
  process.env.DECLICK_DESK = join(tmpdir(), 'no-such-desk');
  const r = await execute(m, 'add', ['Seven', 'Seven'], { dryRun: true });
  process.env.DECLICK_DESK = real;
  assert.equal(r.exit, 1); assert.match(r.error, /deskclaw not found at .*no-such-desk; install/);
});
// 0.3 steps. Each case drives the real fake-desk child process, so a step that does not spawn the
// right deskclaw command shows up as a missing line in the call log.
const mk = (steps, extra = {}) => ({
  name: extra.name || 'calc', engine: 'desktop', window: 'Calculator', ...(extra.launch ? { launch: extra.launch } : {}),
  verbs: [{ name: 'v', description: 'd', args: extra.args || [], flags: [], mutating: true, recipe: { steps, returns: extra.returns ?? null, tree: extra.tree ?? null } }],
});
let seq = 0;
const isolate = () => {
  const dir = mkdtempSync(join(tmpdir(), `desk-${seq++}-`));
  process.env.FAKE_DESK_STATE = join(dir, 'state.json');
  process.env.FAKE_DESK_LOG = join(dir, 'calls.log');
  process.env.FAKE_DESK_ARMED = '1';
  delete process.env.FAKE_DESK_SHIFT_AT; delete process.env.FAKE_DESK_CLOSED; delete process.env.FAKE_DESK_OPEN_FILE;
  return { dir, calls: () => (existsSync(process.env.FAKE_DESK_LOG) ? readFileSync(process.env.FAKE_DESK_LOG, 'utf8') : '').split('\n').filter(Boolean).map(JSON.parse) };
};

test('read takes a property straight off the snapshot attributes', async () => {
  const h = isolate();
  const r = await execute(mk([{ find: ['ComboBox:Mode'], as: 'm' }, { read: 'm', prop: 'value', as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'Standard');
  const t = await execute(mk([{ find: ['CheckBox:Scientific'], as: 'c' }, { read: 'c', prop: 'toggle', as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.equal(t.data, 'off');
  const e = await execute(mk([{ find: ['Button:Paste'], as: 'p' }, { read: 'p', prop: 'enabled', as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.equal(e.data, 'false');
  assert.ok(h.calls().every(c => c[0] === 'snapshot'), 'snapshot attributes cost no extra process');
});
test('read prop text asks deskclaw for the live text', async () => {
  const h = isolate();
  const r = await execute(mk([{ find: ['Edit:Entry'], as: 'e' }, { read: 'e', prop: 'text', as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'Entry');
  assert.deepEqual(h.calls().find(c => c[0] === 'read'), ['read', '@e8', '--prop', 'text']);
});
test('read-all returns one object per row', async () => {
  isolate();
  const rows = await execute(mk([{ 'read-all': ['List:History', 'ListItem:*'], as: 'out', fields: { expr: 'Text:Expression', answer: 'Text:Answer' } }], { returns: 'out' }), 'v', [], {});
  assert.deepEqual(rows.data, [{ expr: '7 + 7', answer: '14' }, { expr: '1 + 1', answer: '2' }]);
  const bare = await execute(mk([{ 'read-all': ['List:History', 'ListItem:*'], as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.deepEqual(bare.data.map(x => x.name), ['row-1', 'row-2']);
});
test('wait-for resolves an element and times out with candidates', async () => {
  isolate();
  const ok = await execute(mk([{ 'wait-for': ['Group:Number pad', 'Button:Seven'], timeout: 1000 }]), 'v', [], {});
  assert.equal(ok.ok, true, ok.error);
  const miss = await execute(mk([{ 'wait-for': ['Group:Number pad', 'Button:Nine'], timeout: 300 }]), 'v', [], {});
  assert.equal(miss.exit, 2); assert.match(miss.error, /Button:Nine/);
  assert.ok(miss.data.candidates.some(c => c.name === 'Seven'), JSON.stringify(miss.data.candidates));
});
test('wait-for-text waits for text in the window', async () => {
  isolate(); process.env.FAKE_DESK_DISPLAY = '14';
  const ok = await execute(mk([{ 'wait-for-text': { text: 'Display is 14' }, timeout: 1000 }]), 'v', [], {});
  assert.equal(ok.ok, true, ok.error);
  const el = await execute(mk([{ find: ['ComboBox:Mode'], as: 'm' }, { 'wait-for-text': { as: 'm', text: 'Standard' }, timeout: 1000 }]), 'v', [], {});
  assert.equal(el.ok, true, el.error);
  const miss = await execute(mk([{ 'wait-for-text': { text: 'never appears' }, timeout: 300 }]), 'v', [], {});
  assert.equal(miss.exit, 2); assert.match(miss.error, /never appears/);
});
test('scroll, expand, collapse, select and context each spawn their deskclaw verb', async () => {
  const h = isolate();
  const r = await execute(mk([
    { find: ['ComboBox:Mode'], as: 'm' }, { scroll: 'm' }, { expand: 'm' }, { collapse: 'm' }, { context: 'm' },
    { find: ['List:History', 'ListItem:row-1'], as: 'row' }, { select: 'row' },
  ]), 'v', [], {});
  assert.equal(r.ok, true, r.error);
  const acts = h.calls().filter(c => c[0] !== 'snapshot');
  assert.deepEqual(acts, [['scroll', '@e10'], ['expand', '@e10'], ['collapse', '@e10'], ['context', '@e10'], ['select', '@e13']]);
});
test('set drives the checkbox to the state the recipe asks for', async () => {
  const h = isolate();
  const r = await execute(mk([
    { find: ['CheckBox:Scientific'], as: 'c' }, { set: ['c', 'on'] },
    { find: ['CheckBox:Scientific'], as: 'c2' }, { read: 'c2', prop: 'toggle', as: 'out' },
  ], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'on');
  assert.deepEqual(h.calls().find(c => c[0] === 'toggle'), ['toggle', '@e9', 'on']);
});
test('clipboard set then get round-trips through deskclaw', async () => {
  isolate();
  const r = await execute(mk([{ clipboard: 'set', text: 'declick was here' }, { clipboard: 'get', as: 'out' }], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'declick was here');
});
test('dismiss sends escape to the foreground window', async () => {
  const h = isolate();
  const r = await execute(mk([{ dismiss: true }]), 'v', [], {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(h.calls(), [['dismiss']]);
});
test('assert compares the live value and fails with what it actually found', async () => {
  isolate(); process.env.FAKE_DESK_DISPLAY = '14';
  const steps = a => [{ find: ['Text:Display is *'], as: 'd' }, { assert: { as: 'd', ...a } }];
  assert.equal((await execute(mk(steps({ equals: 'Display is 14' })), 'v', [], {})).ok, true);
  assert.equal((await execute(mk(steps({ matches: '^Display is \\d+$' })), 'v', [], {})).ok, true);
  const bad = await execute(mk(steps({ equals: 'Display is 99' })), 'v', [], {});
  assert.equal(bad.exit, 1); assert.match(bad.error, /Display is 99/); assert.match(bad.error, /Display is 14/);
});
test('optional skips a step whose element is not on screen', async () => {
  isolate();
  const r = await execute(mk([
    { find: ['Button:Nine'], as: 'n', optional: true }, { click: 'n', optional: true },
    { find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { click: 's' },
  ]), 'v', [], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.steps.filter(s => s.skipped).length, 2, JSON.stringify(r.meta.steps));
  const hard = await execute(mk([{ find: ['Button:Nine'], as: 'n', optional: true }, { click: 'n' }]), 'v', [], {});
  assert.equal(hard.exit, 2); assert.match(hard.error, /optional/);
});
test('an element that moved between find and click is refused, not clicked', async () => {
  const h = isolate(); process.env.FAKE_DESK_SHIFT_AT = '2';
  const r = await execute(mk([{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:Seven'], as: 'first' }, { click: 'first' }]), 'v', [], {});
  delete process.env.FAKE_DESK_SHIFT_AT;
  assert.equal(r.exit, 2); assert.match(r.error, /between find and click/); assert.match(r.error, /Button:Seven/);
  assert.ok(!h.calls().some(c => c[0] === 'click'), 'nothing was clicked');
});
test('a find miss answers with the candidates under the deepest resolved ancestor', async () => {
  isolate();
  const r = await execute(mk([{ find: ['Group:Number pad', 'Button:Nine'], as: 'n' }]), 'v', [], {});
  assert.equal(r.exit, 2);
  assert.deepEqual(r.data.resolved, ['Group:Number pad']);
  assert.ok(r.data.candidates.length <= 15 && r.data.candidates.some(c => c.name === 'Seven'), JSON.stringify(r.data.candidates));
  assert.deepEqual(r.data.unresolved, ['Group:Number pad', 'Button:Nine']);
});
test('the trace is meta.steps on success and data.steps on failure', async () => {
  isolate();
  const ok = await execute(mk([{ find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { click: 's' }]), 'v', [], {});
  assert.ok(Array.isArray(ok.meta.steps) && ok.meta.steps.length === 2, JSON.stringify(ok.meta));
  const bad = await execute(mk([{ find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { click: 's' }, { find: ['Button:Nine'], as: 'n' }]), 'v', [], {});
  assert.equal(bad.exit, 2);
  assert.ok(Array.isArray(bad.data.steps) && bad.data.steps.length === 2, JSON.stringify(bad.data.steps));
});
test('surplus positional args are refused before anything moves', async () => {
  const h = isolate();
  const r = await execute(mk([{ find: ['Group:Number pad', 'Button:{{a}}'], as: 's' }], { args: [{ name: 'a' }] }), 'v', ['Seven', 'Eight'], {});
  assert.equal(r.exit, 1); assert.match(r.error, /Eight/); assert.deepEqual(h.calls(), []);
});
test('an off-enum argument is refused before anything moves', async () => {
  const h = isolate();
  const m = mk([{ find: ['Group:Number pad', 'Button:{{a}}'], as: 's' }], { args: [{ name: 'a', example: 'Seven', enum: ['Seven', 'Eight'] }] });
  assert.equal((await execute(m, 'v', ['Seven'], {})).ok, true);
  const r = await execute(m, 'v', ['Nine'], {});
  assert.equal(r.exit, 1); assert.match(r.error, /Seven, Eight/);
  assert.ok(!h.calls().some(c => JSON.stringify(c).includes('Nine')));
});
test('every desktop error hint names desk arm and describe --verb', async () => {
  isolate();
  const miss = await execute(mk([{ find: ['Button:Nine'], as: 'n' }]), 'v', [], {});
  process.env.FAKE_DESK_ARMED = '0';
  const unarmed = await execute(mk([{ find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { click: 's' }]), 'v', [], {});
  process.env.FAKE_DESK_ARMED = '1';
  for (const r of [miss, unarmed]) {
    assert.match(r.error, /declick desk arm 30/, r.error);
    assert.match(r.error, /declick describe calc --verb v/, r.error);
  }
});
test('manifest.launch starts the app when the window is not open', async () => {
  const h = isolate();
  const marker = join(h.dir, 'opened');
  process.env.FAKE_DESK_OPEN_FILE = marker;
  const launch = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], waitForWindow: 'Calculator', timeout: 8000 };
  const r = await execute(mk([{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { read: 's', as: 'out' }], { returns: 'out', launch }), 'v', [], {});
  delete process.env.FAKE_DESK_OPEN_FILE;
  assert.equal(r.ok, true, r.error); assert.equal(r.data, 'Seven');
  assert.ok(existsSync(marker), 'the launch command really ran');
});
test('a launch step starts the app from inside the recipe', async () => {
  const h = isolate();
  const marker = join(h.dir, 'opened-step');
  process.env.FAKE_DESK_OPEN_FILE = marker;
  const r = await execute(mk([
    { launch: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], waitForWindow: 'Calculator', timeout: 8000 } },
    { find: ['Group:Number pad', 'Button:Seven'], as: 's' }, { read: 's', as: 'out' },
  ], { returns: 'out' }), 'v', [], {});
  delete process.env.FAKE_DESK_OPEN_FILE;
  assert.equal(r.ok, true, r.error); assert.ok(existsSync(marker));
});
test('a launch that never opens the window says so instead of blaming the element', async () => {
  const h = isolate();
  process.env.FAKE_DESK_OPEN_FILE = join(h.dir, 'never');
  const r = await execute(mk([{ find: ['Button:Seven'], as: 's' }], { launch: { command: process.execPath, args: ['-e', '0'], timeout: 600 } }), 'v', [], {});
  delete process.env.FAKE_DESK_OPEN_FILE;
  assert.equal(r.exit, 2); assert.match(r.error, /did not appear/);
});
test('dry-run previews every 0.3 step without spawning an act', async () => {
  const h = isolate();
  const r = await execute(mk([
    { window: 'Calculator' }, { find: ['ComboBox:Mode'], as: 'm' }, { expand: 'm' }, { set: ['m', 'on'] },
    { 'read-all': ['List:History', 'ListItem:*'], as: 'rows' }, { 'wait-for': ['Button:Seven'] },
    { 'wait-for-text': { text: 'Display is 0' } }, { clipboard: 'get', as: 'c' }, { dismiss: true },
    { launch: { command: 'calc.exe' } },
  ]), 'v', [], { dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.steps.filter(s => s.would).map(s => s.would),
    ['expand', 'set', 'wait-for', 'wait-for-text', 'clipboard', 'dismiss', 'launch']);
  assert.ok(h.calls().every(c => c[0] === 'snapshot'), JSON.stringify(h.calls()));
});
test('compile rejects a stored recipe that cannot run', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'bad-recipes-'));
  writeFileSync(join(bad, 'broken.json'), JSON.stringify({ description: 'x', args: [], steps: [{ click: 'ghost' }], returns: 'nope' }));
  await assert.rejects(compile('app:Calculator', { name: 'calc', recipes: bad }), e => e.exit === 1 && /broken\.json/.test(e.message) && /ghost/.test(e.message));
});

// A read after an acting step is the whole point of reading a property: it has to see what the action did,
// not the snapshot taken before it. assert already re-resolves; read used to answer from the stale element.
test('a read after an acting step sees the live value, not the one found before it', async () => {
  const h = isolate();
  const r = await execute(mk([
    { find: ['CheckBox:Scientific'], as: 'c' }, { set: ['c', 'on'] }, { read: 'c', prop: 'toggle', as: 'out' },
  ], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, 'on', `read answered from the pre-action snapshot: ${JSON.stringify(r)}`);
  assert.deepEqual(h.calls().find(c => c[0] === 'toggle'), ['toggle', '@e9', 'on']);
});
test('a property that only exists after the action is read, not reported as missing', async () => {
  isolate();
  const r = await execute(mk([
    { find: ['Edit:Entry'], as: 'e' }, { type: ['e', '42'] }, { read: 'e', prop: 'value', as: 'out' },
  ], { returns: 'out' }), 'v', [], {});
  assert.equal(r.ok, true, `${r.error} ${JSON.stringify(r.data)}`);
  assert.equal(r.data, '42');
});
