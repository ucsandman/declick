import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One home for the CLI children and for the in-process ui and health reader, set before either module loads.
const home = mkdtempSync(join(tmpdir(), 'declick-health-'));
process.env.DECLICK_HOME = home;
process.env.DECLICK_SKILLS = mkdtempSync(join(tmpdir(), 'skills-health-'));
process.env.CREDS_VAULT = join(home, 'none.env');
// This suite's own governor, cache and defaults: none. The ui gates its routes on governance in this process.
for (const k of ['DASHCLAW_API_KEY', 'DASHCLAW_URL', 'DECLICK_GUARD', 'DECLICK_POLICY', 'DECLICK_CACHE', 'DECLICK_DEFAULTS', 'DECLICK_ENV_ALLOW', 'DECLICK_MAX_BYTES']) delete process.env[k];
const env = { ...process.env, DECLICK_AUDIT: 'off', DECLICK_DESK: join(process.cwd(), 'test', 'fake-desk.mjs'),
  DECLICK_AUTHOR: join(process.cwd(), 'test', 'fake-author.mjs'), FAKE_DESK_ARMED: '1', FAKE_DESK_DISPLAY: '14' };
const H = await import('../src/health.mjs');
const { startUi, adapterRows } = await import('../src/ui.mjs');
const { skillText } = await import('../src/skill.mjs');

// The ui and the api server below run in this process, so every child is spawned async: spawnSync would block
// this event loop and the child would wait forever for its own reply.
const spawnAsync = (bin, args, extra = {}) => new Promise(res => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...env, ...extra } });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
  c.on('close', status => res({ status, stdout, stderr }));
});
const runtime = (args, extra) => spawnAsync('bin/run.mjs', args, extra);
const cli = (args, extra) => spawnAsync('bin/declick.mjs', args, extra);
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const errFile = n => join(home, n, 'last-error.json');
const runFile = n => join(home, n, 'last-run.json');
const readOrNull = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const failures = n => H.readHealth(n).failures;
const reset = n => { rmSync(errFile(n), { force: true }); rmSync(runFile(n), { force: true }); };
const seed = (n, rec) => { mkdirSync(join(home, n), { recursive: true }); writeFileSync(errFile(n), JSON.stringify(rec, null, 2) + '\n'); };

let srv, base, KEY, ui, uiBase;
const spec = url => ({
  openapi: '3.0.0', info: { title: 'Pets' }, servers: [{ url }],
  components: { securitySchemes: { api_key: { type: 'apiKey', in: 'header', name: 'x-api-key' } } }, security: [{ api_key: [] }],
  paths: {
    '/pet/{id}': { get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
    '/pets': { get: { operationId: 'listPets', summary: 'List pets' } },
  },
});
const addSteps = [
  { window: 'Calculator' },
  { find: ['Group:Number pad', 'Button:{{a}}'], as: 'first' }, { click: 'first' },
  { find: ['Group:Standard operators', 'Button:Plus'], as: 'plus' }, { click: 'plus' },
  { find: ['Group:Number pad', 'Button:{{b}}'], as: 'second' }, { click: 'second' },
  { find: ['Group:Standard operators', 'Button:Equals'], as: 'eq' }, { click: 'eq' },
  { find: ['Text:Display is *'], as: 'display' }, { read: 'display', as: 'result' },
];
// What the fake authoring model hands back: the same add, an expect that matches the fake display, and variants.
const authoredAdd = { verb: 'add', description: 'Add two digits and read the display', args: [{ name: 'a' }, { name: 'b' }], mutating: true,
  steps: addSteps, returns: 'result', example: ['Seven', 'Seven'], expect: '14' };
const authoredShow = { verb: 'show', description: 'Read the display', args: [], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }], returns: 'result', example: [], expect: '14' };
const author = (verb, recipe, extra = {}) => cli(['author', 'tally', '--goal', 'do the thing', '--verb', verb], { FAKE_AUTHOR_RECIPE: JSON.stringify(recipe), ...extra });

// The desktop states the cases below start from, made by the real writers: a miss through bin/run.mjs, a STOP.
const brokenAdd = async () => {
  reset('tally');
  const r = await runtime(['tally', 'add', 'Nine', 'Seven']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(H.verbState(H.readHealth('tally'), 'add'), 'broken');
  return failures('tally').add;
};
const failingAdd = async () => {
  reset('tally');
  const r = await runtime(['tally', 'add', 'Seven', 'Seven'], { FAKE_DESK_STOP: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(H.verbState(H.readHealth('tally'), 'add'), 'failing');
  return failures('tally').add;
};
const failingGetPet = async () => {
  reset('pets');
  const r = await runtime(['pets', 'get-pet', '7']);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  return failures('pets')['get-pet'];
};

test('setup: an openapi adapter on a local server, a desktop adapter on the fake desk, and the ui', async () => {
  srv = createServer((req, res) => {
    if (req.url.startsWith('/pet/404')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"no such pet"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/pets') ? [{ id: 7, name: 'Rex' }] : { id: 7, name: 'Rex' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  writeFileSync(join(home, 'pets.json'), JSON.stringify(spec(base)));
  const a = await cli(['add', join(home, 'pets.json'), '--name', 'pets']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  KEY = JSON.parse(readFileSync(join(home, 'pets', 'manifest.json'), 'utf8')).auth.env[0];
  assert.match(KEY, /^PETS_/);
  const recipes = join(home, 'tally-recipes'); mkdirSync(recipes);
  writeFileSync(join(recipes, 'add.json'), JSON.stringify({ description: 'Add two digits and read the display', args: [{ name: 'a' }, { name: 'b' }], mutating: true,
    steps: addSteps, returns: 'result', tree: ['Group:Number pad', 'Button:Seven', 'Group:Standard operators', 'Button:Plus', 'Button:Equals'] }));
  // An optional find that misses is a skipped step: the verb still works.
  writeFileSync(join(recipes, 'peek.json'), JSON.stringify({ description: 'Read the display past an optional button', args: [], mutating: false,
    steps: [{ window: 'Calculator' }, { find: ['Button:Nine'], as: 'nine', optional: true }, { find: ['Text:Display is *'], as: 'display' }, { read: 'display', as: 'result' }], returns: 'result' }));
  const d = await cli(['add', 'app:Calculator', '--name', 'tally', '--recipes', recipes]);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  ui = await startUi({ port: 0, allowAuthoring: true });
  uiBase = `http://127.0.0.1:${ui.address().port}`;
});
const repairPost = name => fetch(`${uiBase}/api/${name}/repair`, { method: 'POST', headers: { origin: uiBase, 'content-type': 'application/json', 'x-declick-token': ui.token }, body: '{}' });
const page = async () => (await fetch(uiBase + '/')).text();
const repairButton = (html, name) => new RegExp(`<tr data-name="${name}">[\\s\\S]*?<button data-action="repair"([^>]*)>`).exec(html)?.[1];

// ---- the table itself

test('table: HEALTH_STATES is ok, failing, broken and every state has a label', () => {
  assert.deepEqual(H.HEALTH_STATES, ['ok', 'failing', 'broken']);
  assert.deepEqual(Object.keys(H.HEALTH_STATE_LABELS), H.HEALTH_STATES);
});
test('table: every from-key and to-value is a state and every event is declared', () => {
  for (const [event, row] of Object.entries(H.HEALTH_TABLE)) {
    assert.ok(H.HEALTH_EVENTS.includes(event), event);
    for (const [from, to] of Object.entries(row)) { assert.ok(H.HEALTH_STATES.includes(from), from); assert.ok(H.HEALTH_STATES.includes(to), to); }
  }
  assert.deepEqual(Object.keys(H.HEALTH_TABLE).sort(), [...H.HEALTH_EVENTS].sort());
});
// Every state a from-state can reach by some event, read off HEALTH_TABLE.
const edges = from => [...new Set(Object.values(H.HEALTH_TABLE).map(row => row[from]).filter(Boolean))];
test('table: every state is reachable from ok', () => {
  const seen = new Set(['ok']); const queue = ['ok'];
  while (queue.length) for (const to of edges(queue.shift())) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  assert.deepEqual([...seen].sort(), [...H.HEALTH_STATES].sort());
});
test('table: no state is terminal: every state has an outgoing edge', () => {
  assert.deepEqual(H.HEALTH_STATES.filter(s => !edges(s).length), []);
});
test('table: repair is defined only from broken, and miss is the only event that yields broken from ok or failing', () => {
  assert.deepEqual(Object.keys(H.HEALTH_TABLE.repair), ['broken']);
  for (const from of ['ok', 'failing']) assert.deepEqual(H.HEALTH_EVENTS.filter(e => H.HEALTH_TABLE[e][from] === 'broken'), ['miss'], from);
});
test('table: repair is refused from ok and failing, and a preview never clears a failure', () => {
  assert.equal(H.canApply('ok', 'repair'), false);
  assert.equal(H.canApply('failing', 'repair'), false);
  assert.equal(H.canApply('broken', 'repair'), true);
  assert.equal(H.HEALTH_TABLE.preview.failing, 'failing');
  assert.equal(H.HEALTH_TABLE.preview.broken, 'broken');
  assert.equal(edges('broken').includes('failing'), false);
});

// One case per (from, to) pair: the eight the plan names are accepted, broken -> failing is refused.
const LEGAL = { ok: ['ok', 'failing', 'broken'], failing: ['ok', 'failing', 'broken'], broken: ['ok', 'broken'] };
for (const from of ['ok', 'failing', 'broken']) for (const to of ['ok', 'failing', 'broken']) {
  const legal = LEGAL[from].includes(to);
  test(`transition ${from} -> ${to} is ${legal ? 'accepted' : 'refused'}`, () => {
    assert.equal(edges(from).includes(to), legal);
  });
}
// One case per (event, state) pair, restating the plan's transitions; null is a refusal.
const EXPECT = {
  run: { ok: 'ok', failing: 'ok', broken: 'ok' }, preview: { ok: 'ok', failing: 'failing', broken: 'broken' }, author: { ok: 'ok', failing: 'ok', broken: 'ok' },
  fail: { ok: 'failing', failing: 'failing', broken: 'broken' }, miss: { ok: 'broken', failing: 'broken', broken: 'broken' }, repair: { ok: null, failing: null, broken: 'ok' },
};
for (const [event, row] of Object.entries(EXPECT)) for (const [state, to] of Object.entries(row)) {
  test(`event ${event} from ${state} ${to ? `goes to ${to}` : 'is refused'}`, () => {
    assert.equal(H.canApply(state, event), !!to);
    if (to) return assert.equal(H.assertApply(state, event), to);
    assert.throws(() => H.assertApply(state, event, { adapter: 'calc', verb: 'add' }), e => e instanceof H.IllegalTransitionError && e.code === 'illegal_transition' && e.exit === 1
      && e.current === state && e.requested === event && JSON.stringify(e.allowed) === JSON.stringify(H.nextEvents(state))
      && JSON.stringify(e.data) === JSON.stringify({ error: 'illegal_transition', current: state, requested: event, allowed: H.nextEvents(state) }));
  });
}

test('verbState over the stored-file matrix returns only states, and healthOf ignores a verb not in the manifest', () => {
  const m = { engine: 'desktop', verbs: [{ name: 'add' }] };
  const at = '2026-01-01T00:00:00.000Z';
  const cases = [
    [null, 'ok'],
    [{ verb: 'add', error: 'deskclaw STOP is set', exit: 3, at }, 'failing'],
    [{ verb: 'add', error: 'element not found', diff: { missing: [], added: [] }, at }, 'broken'],
    [{ verb: 'add', error: 'x', exit: 2, at, failures: { add: { error: 'x', exit: 2, diff: { missing: ['Button:Plus'], added: [] }, at } } }, 'broken'],
    [{ verb: 'gone', error: 'x', exit: 1, at }, 'ok'],
  ];
  try {
    for (const [file, want] of cases) {
      rmSync(join(home, 'matrix'), { recursive: true, force: true });
      if (file) seed('matrix', file);
      const h = H.readHealth('matrix');
      for (const v of ['add', 'gone', 'typo']) assert.ok(H.HEALTH_STATES.includes(H.verbState(h, v)), v);
      assert.equal(H.verbState(h, 'add'), want, JSON.stringify(file));
      assert.equal(H.healthOf('matrix', m, h).state, want);
    }
    assert.equal(H.verbState(H.readHealth('matrix'), 'gone'), 'failing', 'the record is read');
    assert.deepEqual(H.healthOf('matrix', m).failing, [], 'but a verb the manifest lacks is not health');
  } finally { rmSync(join(home, 'matrix'), { recursive: true, force: true }); }
});

// ---- writers that must not move a record (the illegal transitions of today's code)

test('broken(add) + a --dry-run exit 0: the failure and its diff survive', async () => {
  const before = await brokenAdd();
  const r = await runtime(['tally', 'add', 'Seven', 'Seven', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(failures('tally').add, before);
  assert.equal(readOrNull(runFile('tally')).dryRun, true);
});
test('failing(get-pet) on openapi + get-pet 7 --dry-run exit 0: the failure survives', async () => {
  const before = await failingGetPet();
  const r = await runtime(['pets', 'get-pet', '7', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(failures('pets')['get-pet'], before);
});
test('failing(get-pet) seeded as a legacy file + a --cache 60 hit: the failure survives and last-run says cache', async () => {
  reset('pets');
  const fill = await runtime(['pets', 'get-pet', '7', '--cache', '60'], { [KEY]: 'k' });
  assert.equal(fill.status, 0, fill.stdout + fill.stderr); assert.equal(J(fill).meta.cache.hit, false);
  seed('pets', { verb: 'get-pet', error: `needs ${KEY}`, exit: 4, at: new Date().toISOString() });
  const legacy = readFileSync(errFile('pets'), 'utf8');
  const hit = await runtime(['pets', 'get-pet', '7', '--cache', '60'], { [KEY]: 'k' });
  assert.equal(hit.status, 0, hit.stdout + hit.stderr); assert.equal(J(hit).meta.cache.hit, true);
  assert.equal(readFileSync(errFile('pets'), 'utf8'), legacy, 'a cache hit leaves the record exactly as it was');
  assert.equal(failures('pets')['get-pet'].exit, 4);
  const lr = readOrNull(runFile('pets'));
  assert.equal(lr.cache, true); assert.equal(H.lastRunLabel(lr), 'cached ok');
});
test('failing(A) + a real exit-0 run of verb B: A survives, last-run is B, the top-level lastError is still A', async () => {
  const before = await failingGetPet();
  const r = await runtime(['pets', 'list-pets'], { [KEY]: 'k' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(failures('pets')['get-pet'], before);
  assert.equal(readOrNull(runFile('pets')).verb, 'list-pets');
  assert.equal(readOrNull(errFile('pets')).verb, 'get-pet');
  assert.equal(adapterRows().find(x => x.name === 'pets').lastError.verb, 'get-pet');
});
test('failing(A) + <adapter> A --help: A survives and last-run.json is unchanged', async () => {
  const before = await failingGetPet();
  const lr = readFileSync(runFile('pets'), 'utf8');
  const r = await runtime(['pets', 'get-pet', '--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(failures('pets')['get-pet'], before);
  assert.equal(readFileSync(runFile('pets'), 'utf8'), lr);
});
test('an unknown verb exit 2 records no failure of its own and leaves the others alone', async () => {
  const before = await failingGetPet();
  const r = await runtime(['pets', 'typo']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!('typo' in failures('pets')));
  assert.deepEqual(failures('pets')['get-pet'], before);
});
test('broken(add) then a non-miss failure of add (STOP, exit 3): still broken, the diff is kept', async () => {
  const before = await brokenAdd();
  const r = await runtime(['tally', 'add', 'Seven', 'Seven'], { FAKE_DESK_STOP: '1' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const after = failures('tally').add;
  assert.equal(H.verbState(H.readHealth('tally'), 'add'), 'broken');
  assert.deepEqual(after.diff, before.diff); assert.equal(after.exit, 3);
  assert.equal(edges('broken').includes('failing'), false);
});
test('broken(add) + declick author saving another verb: add stays broken', async () => {
  const before = await brokenAdd();
  const r = await author('show', authoredShow);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(failures('tally').add, before);
});
test('broken(add) + a repair whose recipe fails expect: add stays broken', async () => {
  const before = await brokenAdd();
  const r = await cli(['repair', 'tally', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify({ ...authoredAdd, expect: '^never$' }) });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(J(r).error, /expected \/\^never\$\//);
  assert.deepEqual(failures('tally').add, before);
});
test('an authoring draft whose dry run misses writes no failure for the unsaved verb', async () => {
  reset('tally');
  const r = await author('ghost', { ...authoredShow, verb: 'ghost', steps: [{ window: 'Calculator' }, { find: ['Button:Nine'], as: 'out' }, { read: 'out', as: 'result' }] });
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(J(r).error, /dry-run failed/);
  assert.ok(!existsSync(errFile('tally')), 'no record at all');
});
test('an optional find that misses in a dry run or a real run records nothing', async () => {
  reset('tally');
  for (const extra of [['--dry-run'], []]) {
    const r = await runtime(['tally', 'peek', ...extra]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(errFile('tally')), `peek ${extra.join(' ')}`);
  }
});
test('declick repair with no record (ok) is refused with exit 1 and the contract fields', async () => {
  reset('tally');
  const r = await cli(['repair', 'tally', 'add']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = J(r);
  assert.equal(j.ok, false); assert.equal(j.exit, 1); assert.match(j.error, /tally add has no recorded failure/); assert.match(j.error, /declick author tally --verb add/);
  assert.deepEqual(j.data, { error: 'illegal_transition', current: 'ok', requested: 'repair', allowed: ['run', 'preview', 'author'] });
});
test('declick repair of a failing, non-miss record (exit 3) is refused with current failing', async () => {
  await failingAdd();
  const r = await cli(['repair', 'tally', 'add']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(J(r).data.current, 'failing'); assert.equal(J(r).data.error, 'illegal_transition');
  assert.equal(H.verbState(H.readHealth('tally'), 'add'), 'failing', 'the refusal changed nothing');
});
test('declick repair of an openapi adapter is exit 1 naming the engine', async () => {
  await failingGetPet();
  const r = await cli(['repair', 'pets', 'get-pet']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(J(r).error, /pets is a openapi adapter; repair works on desktop adapters/);
});

// ---- writers that must move a record (the legal transitions)

test('ok -> failing: an openapi verb exits 4 and the record carries exit 4 and the same error as last-run', async () => {
  const f = await failingGetPet();
  assert.equal(f.exit, 4); assert.equal(f.diff, undefined);
  const le = readOrNull(errFile('pets'));
  assert.equal(le.verb, 'get-pet'); assert.equal(le.exit, 4); assert.match(le.error, new RegExp(KEY));
  assert.equal(le.error, readOrNull(runFile('pets')).error);
});
test('ok -> broken: a desktop miss records failures.add.diff.missing as an array', async () => {
  const f = await brokenAdd();
  assert.ok(Array.isArray(f.diff.missing)); assert.match(f.error, /Button:Nine/); assert.equal(f.exit, 2);
});
test('failing -> ok: a real exit-0 run of the same verb deletes last-error.json when no failure remains', async () => {
  await failingGetPet();
  const r = await runtime(['pets', 'get-pet', '7'], { [KEY]: 'k' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(errFile('pets')));
});
test('broken -> ok: a real exit-0 run of the same desktop verb', async () => {
  await brokenAdd();
  const r = await runtime(['tally', 'add', 'Seven', 'Seven']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(errFile('tally')));
});
test('broken -> ok: declick repair with a matching recipe seeds the diff and clears add', async () => {
  await brokenAdd();
  const log = join(home, 'repair-prompt.txt');
  const r = await cli(['repair', 'tally', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify(authoredAdd), FAKE_AUTHOR_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(log, 'utf8'), /Button:Nine/);
  assert.ok(!existsSync(errFile('tally')));
});
test('failing -> ok: declick author saving the failing verb', async () => {
  await failingAdd();
  const r = await author('add', authoredAdd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(errFile('tally')));
});
test('failing -> broken: a miss on a verb whose record had no diff', async () => {
  await failingAdd();
  const r = await runtime(['tally', 'add', 'Nine', 'Seven']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(H.verbState(H.readHealth('tally'), 'add'), 'broken');
  assert.ok(Array.isArray(failures('tally').add.diff.missing));
});
test('failing -> failing: a second failure updates exit, error and at', async () => {
  const first = await failingGetPet();
  const r = await runtime(['pets', 'get-pet', '404'], { [KEY]: 'k' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const second = failures('pets')['get-pet'];
  assert.equal(second.exit, 2); assert.notEqual(second.error, first.error); assert.ok(second.at >= first.at);
  assert.equal(H.verbState(H.readHealth('pets'), 'get-pet'), 'failing');
});
test('ok -> ok: preview, run and author on a verb with no record leave no file', async () => {
  reset('pets');
  assert.equal((await runtime(['pets', 'get-pet', '7', '--dry-run'])).status, 0);
  assert.ok(!existsSync(errFile('pets')), 'preview');
  assert.equal((await runtime(['pets', 'get-pet', '7'], { [KEY]: 'k' })).status, 0);
  assert.ok(!existsSync(errFile('pets')), 'run');
  assert.equal(H.recordEvent('pets', 'get-pet', 'author'), 'ok');
  assert.ok(!existsSync(errFile('pets')), 'author');
  assert.equal(H.recordEvent('pets', 'get-pet', 'repair'), 'ok', 'a refused repair reports the state it left alone');
  assert.ok(!existsSync(errFile('pets')), 'repair');
});
test('two failing verbs: clearing the newest rewrites the top-level record to the other one', async () => {
  await failingGetPet();
  assert.equal((await runtime(['pets', 'list-pets'])).status, 4);
  assert.equal(readOrNull(errFile('pets')).verb, 'list-pets');
  assert.equal((await runtime(['pets', 'list-pets'], { [KEY]: 'k' })).status, 0);
  const le = readOrNull(errFile('pets'));
  assert.equal(le.verb, 'get-pet'); assert.equal(le.exit, 4);
  assert.deepEqual(Object.keys(le.failures), ['get-pet']);
});

// ---- the surfaces that read the machine

test('ui: repair on an openapi adapter with no record is 400 with the contract fields', async () => {
  reset('pets');
  const r = await repairPost('pets');
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /no recorded failure/); assert.equal(j.code, 'illegal_transition'); assert.equal(j.current, 'ok'); assert.equal(j.requested, 'repair');
  assert.ok(!j.allowed.includes('repair'));
});
test('ui: a failing (exit 4) record is refused with current failing, and the button says why it is off', async () => {
  await failingGetPet();
  const r = await repairPost('pets');
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.code, 'illegal_transition'); assert.equal(j.current, 'failing'); assert.match(j.error, /get-pet failed with exit 4, not an element miss/);
  assert.match(repairButton(await page(), 'pets'), /disabled title="get-pet failed with exit 4, not an element miss"/);
});
test('ui: a broken desktop verb renders an enabled repair button, exactly where canApply allows it', async () => {
  await brokenAdd();
  const row = adapterRows().find(x => x.name === 'tally');
  assert.equal(row.health.failing.some(f => H.canApply(f.state, 'repair')), true);
  const attrs = repairButton(await page(), 'tally');
  assert.equal(attrs, '', `repair button attributes: ${attrs}`);
  assert.match(await page(), /element path stopped resolving: add: element not found/);
});
test('ui: after a --dry-run the last-run cell reads preview ok, never plain ok', async () => {
  reset('pets');
  assert.equal((await runtime(['pets', 'get-pet', '7', '--dry-run'])).status, 0);
  const html = await page();
  assert.match(html, /get-pet preview ok <span/); assert.doesNotMatch(html, /get-pet ok <span/);
});
test('declick status carries health: broken with a repair action for tally, never a repair action for openapi', async () => {
  await brokenAdd();
  const s = J(await cli(['status', 'tally'])).data;
  assert.equal(s.health.state, 'broken');
  assert.deepEqual(s.health.nextActions, ['declick repair tally add']);
  assert.deepEqual(s.health.failing.map(f => [f.verb, f.state, f.allowedNext]), [['add', 'broken', ['run', 'preview', 'author', 'repair']]]);
  assert.equal(s.lastError.verb, 'add');
  await failingGetPet();
  const p = J(await cli(['status', 'pets'])).data;
  assert.equal(p.health.state, 'failing');
  assert.ok(!p.health.nextActions.some(a => /repair/.test(a)));
  assert.ok(!p.health.failing[0].allowedNext.includes('repair'));
});
test('declick repair refusal: exit 1 (not 2), and data has exactly error, current, requested, allowed', async () => {
  reset('tally');
  const r = await cli(['repair', 'tally', 'add']);
  assert.equal(r.status, 1); assert.notEqual(r.status, 2);
  assert.deepEqual(Object.keys(J(r).data).sort(), ['allowed', 'current', 'error', 'requested']);
});
test('skill tails: the desktop one sends agents to repair only with data.missing; no other engine mentions repair', () => {
  const desk = JSON.parse(readFileSync(join(home, 'tally', 'manifest.json'), 'utf8'));
  const sentences = skillText(desk).split(/(?<=[.;])\s+/).filter(s => s.includes('declick repair'));
  assert.ok(sentences.length, 'the desktop skill names repair');
  for (const s of sentences) assert.match(s, /data\.missing/, s);
  assert.match(skillText(desk), /window is not open means start the app, which repair cannot fix/);
  const verbs = [{ name: 'go', description: 'Go somewhere.', args: [], flags: [] }];
  for (const engine of ['openapi', 'web', 'mcp', 'sqlite', 'compose', 'cli', 'graphql', 'postman', 'har']) {
    const m = { name: 'other', engine, source: 'https://x.test/spec.json', baseUrl: 'https://x.test', window: 'https://x.test', auth: { env: [] }, verbs };
    assert.doesNotMatch(skillText(m), /repair/, engine);
  }
  assert.doesNotMatch(skillText(JSON.parse(readFileSync(join(home, 'pets', 'manifest.json'), 'utf8'))), /repair/);
});

test('teardown', async () => {
  if (ui) { ui.closeAllConnections(); await new Promise(r => ui.close(r)); }
  if (srv) { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});
