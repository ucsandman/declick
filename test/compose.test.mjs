import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-compose-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-compose-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, OPENCLAW_SKILLS: '', CREDS_VAULT: join(home, 'none.env'),
  DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_AUDIT: '', DECLICK_ENV_ALLOW: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}, opts = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8', ...opts });
// The server below runs in this process, so anything that calls back into it is spawned async: spawnSync
// would block this event loop and the child would wait forever for its own reply.
const runtime = (args, extra = {}) => new Promise(res => {
  const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
  c.on('close', status => res({ status, stdout, stderr }));
});
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const auditLines = () => readFileSync(join(home, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const chainFile = (name, doc) => { const p = join(home, `${name}.json`); writeFileSync(p, JSON.stringify(doc)); return p; };

// One server plays the whole petstore: the compiled adapter is pointed at it with the env every step inherits.
const pets = { 7: { id: 7, name: 'Rex', status: 'available', owner: { name: 'Ada', email: 'ada@example.test' } } };
let srv, api, apiCalls = 0;
const at = {};

test('setup: a petstore adapter, a chain over it, and a real server behind both', async () => {
  // One server plays two roles, the API and the governance endpoint, so a policy can refuse one step of a chain.
  srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/guard') {
      let d = ''; req.on('data', c => d += c);
      return req.on('end', () => json(200, JSON.parse(d || '{}').action === 'add-pet' ? { decision: 'block', reason: 'petstore writes are off' } : { decision: 'allow' }));
    }
    apiCalls++;
    if (req.method === 'POST' && u.pathname === '/pet') { let d = ''; req.on('data', c => d += c); return req.on('end', () => json(200, { id: 8, ...JSON.parse(d || '{}') })); }
    if (u.pathname === '/pet/findByStatus') return json(200, [{ id: 7, name: 'Rex', status: u.searchParams.get('status') }]);
    const m = /^\/pet\/(\d+)$/.exec(u.pathname);
    return m && pets[m[1]] ? json(200, pets[m[1]]) : json(404, { error: 'no such pet' });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${srv.address().port}`;
  // The steps are their own processes, so the base url and the key travel in the environment they inherit.
  Object.assign(at, { DECLICK_PETSTORE_BASE_URL: api, PETSTORE_API_KEY: 'k', DECLICK_ENV_ALLOW: 'PETSTORE_API_KEY' });
  assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0);
});

test('a chain compiles into an adapter whose mutating flag comes from the verbs its steps run', () => {
  const r = run(['add', 'compose:fixtures/compose/chain.json', '--name', 'ops']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const d = J(r).data;
  assert.equal(d.engine, 'compose');
  assert.match(d.source, /^compose:.*chain\.json$/);
  assert.deepEqual(d.verbs.map(v => v.name), ['pet-family', 'pet-name', 'pet-or-available', 'copy-pet']);
  assert.equal(d.verbs.find(v => v.name === 'pet-family').mutating, false, 'two GETs do not write');
  assert.equal(d.verbs.find(v => v.name === 'copy-pet').mutating, true, 'add-pet is a POST, so the chain that calls it writes');
  assert.deepEqual(J(run(['list'])).data.find(a => a.name === 'ops').verbs, ['pet-family', 'pet-name', 'pet-or-available', 'copy-pet']);
  // The per-step mutating flag is resolved at compile from the target manifest and recorded, so lint has a floor.
  const steps = J(run(['manifest', 'ops', '--verb', 'copy-pet'])).data.verbs[0].compose.steps;
  assert.deepEqual(steps.map(s => [s.adapter, s.verb, s.mutating]), [['petstore', 'get-pet-by-id', false], ['petstore', 'add-pet', true]]);
  assert.deepEqual(J(run(['lint', 'ops'])).data.errors, []);
});

test('a manifest cannot lower what its steps derive', () => {
  const p = join(home, 'ops', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  const patched = JSON.parse(JSON.stringify(m));
  patched.verbs.find(v => v.name === 'copy-pet').mutating = false;
  writeFileSync(p, JSON.stringify(patched, null, 2));
  const errs = J(run(['lint', 'ops'])).data.errors;
  assert.ok(errs.some(e => /copy-pet: mutating false/.test(e)), errs.join('; '));
  writeFileSync(p, JSON.stringify(m, null, 2));
  assert.deepEqual(J(run(['lint', 'ops'])).data.errors, []);
});

test('the engine is routed from the compose: prefix and from the file itself, and declick engines says so', () => {
  const e = J(run(['engines'])).data.find(x => x.name === 'compose');
  assert.equal(e.ready, true); assert.match(e.source, /^compose:/);
  const s = J(run(['engines', '--source', 'fixtures/compose/chain.json'])).data;
  assert.equal(s.engine, 'compose'); assert.equal(s.ready, true);
  assert.match(J(run(['add', '--help'])).data.flags.find(f => f.name === 'engine').description, /compose/);
});

test('a chain naming an adapter or a verb that is not there is refused at add, so nothing unrunnable is saved', () => {
  const ghost = chainFile('ghost-chain', { compose: true, verbs: [{ name: 'go', description: 'call a ghost', steps: [{ run: 'ghost get-thing' }] }] });
  const r = run(['add', `compose:${ghost}`, '--name', 'ghost-ops']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(J(r).error, /no adapter named ghost/);
  assert.ok(!existsSync(join(home, 'ghost-ops')), 'a refused chain leaves no adapter behind');
  const badVerb = chainFile('bad-verb', { compose: true, verbs: [{ name: 'go', description: 'call a verb that is gone', steps: [{ run: 'petstore feed-pet 7' }] }] });
  assert.match(J(run(['add', `compose:${badVerb}`, '--name', 'bad-ops'])).error, /step 1: petstore has no verb feed-pet; run: declick describe petstore/);
  const badName = chainFile('bad-name', { compose: true, verbs: [{ name: 'go', description: 'read a name nothing sets', args: [{ name: 'id' }], steps: [{ run: 'petstore get-pet-by-id {pet-id}' }] }] });
  assert.match(J(run(['add', `compose:${badName}`, '--name', 'bad-ops'])).error, /\{pet-id\} names nothing; go has id/);
  const shadow = chainFile('shadow', { compose: true, verbs: [{ name: 'go', description: 'name a step after an argument', args: [{ name: 'id' }], steps: [{ run: 'petstore get-pet-by-id {id}', as: 'id' }] }] });
  assert.match(J(run(['add', `compose:${shadow}`, '--name', 'bad-ops'])).error, /as "id" is already an argument/);
});

test('--dry-run previews every step, sends nothing, and keeps a template no step has answered yet literal', async () => {
  const r = await runtime(['ops', 'pet-family', '7', '--dry-run', '--json'], at);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = J(r);
  assert.equal(j.meta.dryRun, true); assert.equal(j.meta.steps, 2);
  assert.equal(j.data.steps.length, 2);
  assert.equal(j.data.steps[0].run, 'petstore get-pet-by-id 7', 'the composite argument is filled in');
  assert.equal(j.data.steps[0].preview.method, 'GET');
  assert.match(j.data.steps[0].preview.url, new RegExp(`^${api}/pet/7$`));
  assert.equal(j.data.steps[1].run, 'petstore find-pets-by-status --status {pet.status}', 'a preview binds nothing, so the template stays readable');
  assert.match(j.data.steps[1].preview.url, /status=%7Bpet\.status%7D/);
  const mut = J(await runtime(['ops', 'copy-pet', '7', '--suffix', 'II', '--dry-run', '--json'], at));
  assert.equal(mut.meta.governance.decision, 'dry-run');
  assert.equal(mut.data.steps[1].run, 'petstore add-pet --name "{pet.name} II" --status {pet.status}');
  assert.equal(JSON.parse(mut.data.steps[1].preview.body).name, '{pet.name} II', 'nothing was sent, and the preview shows exactly what would be');
});

test('a step that ends its own flags with -- still gets --dry-run, so a preview sends nothing', async () => {
  const p = chainFile('endflags', { compose: true, verbs: [{ name: 'go', description: 'one pet, flags ended early', args: [{ name: 'id' }],
    steps: [{ run: 'petstore get-pet-by-id -- {id}', as: 'pet' }], returns: 'pet' }] });
  assert.equal(run(['add', `compose:${p}`, '--name', 'endflags']).status, 0);
  const before = apiCalls;
  const r = await runtime(['endflags', 'go', '7', '--dry-run', '--json'], at);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(apiCalls, before, 'a preview reached the server');
  assert.equal(J(r).data.steps[0].preview.method, 'GET');
  assert.equal(J(await runtime(['endflags', 'go', '7', '--json'], at)).data.id, 7, 'the same step still runs for real');
  assert.equal(apiCalls, before + 1);
  assert.equal(run(['remove', 'endflags']).status, 0);
});

test('a step name is read the way the command line spells it, hyphens or camelCase', async () => {
  const p = chainFile('spelling', { compose: true, verbs: [{ name: 'go', description: 'the name behind a pet id', args: [{ name: 'id' }],
    steps: [{ run: 'petstore get-pet-by-id {id}', as: 'my-pet' }], returns: '{myPet.name}' }] });
  assert.equal(run(['add', `compose:${p}`, '--name', 'spelling']).status, 0);
  const r = await runtime(['spelling', 'go', '7', '--json'], at);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(J(r).data, 'Rex');
  assert.equal(run(['remove', 'spelling']).status, 0);
});

test('a real run resolves templates across steps and answers with the step returns names', async () => {
  const r = await runtime(['ops', 'pet-family', '7', '--json'], at);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = J(r);
  assert.deepEqual(j.data, [{ id: 7, name: 'Rex', status: 'available' }], 'step 2 was called with the status step 1 found');
  assert.equal(j.meta.steps, 2); assert.ok(typeof j.meta.ms === 'number' && j.meta.ms >= 0);
  // returns as a template is the value itself, not a stringified object.
  assert.equal(J(await runtime(['ops', 'pet-name', '7', '--json'], at)).data, 'Rex');
  // A flag of the composite reaches a step the same way an argument does.
  const copy = J(await runtime(['ops', 'copy-pet', '7', '--suffix', 'II', '--json'], at));
  assert.equal(copy.data.name, 'Rex II'); assert.equal(copy.data.status, 'available');
});

test('--fields and --limit shape the composite answer, not the steps', async () => {
  const j = J(await runtime(['ops', 'pet-family', '7', '--fields', 'id,name', '--limit', '1', '--json'], at));
  assert.deepEqual(j.data, [{ id: 7, name: 'Rex' }]);
  assert.equal(j.meta.count, 1); assert.equal(j.meta.steps, 2);
});

test('a failing step stops the chain, keeps the step exit code and names the step', async () => {
  const r = await runtime(['ops', 'pet-family', '999', '--json'], at);
  assert.equal(r.status, 2, r.stdout);
  const j = J(r);
  assert.equal(j.ok, false); assert.equal(j.exit, 2);
  assert.match(j.error, /^step 1 \(petstore get-pet-by-id\): .*404/);
  assert.equal(j.data.steps.length, 1, 'step 2 never ran');
  assert.equal(j.data.steps[0].ok, false); assert.equal(j.data.steps[0].exit, 2);
  assert.ok(j.data.steps[0].governance, 'a failed step carries the decision its own run made');
});

test('an optional step records its failure and the chain carries on without it', async () => {
  const r = await runtime(['ops', 'pet-or-available', '999', '--json'], at);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = J(r);
  assert.deepEqual(j.data, [{ id: 7, name: 'Rex', status: 'available' }]);
  assert.equal(j.data.length, 1);
  assert.equal(j.meta.steps, 2);
});

test('a returns naming a step that was optional and failed is an error, not a silent null', async () => {
  const p = chainFile('opt-returns', { compose: true, verbs: [{ name: 'go', description: 'a pet that may not be there', args: [{ name: 'id' }],
    steps: [{ run: 'petstore get-pet-by-id {id}', as: 'pet', optional: true }], returns: 'pet' }] });
  assert.equal(run(['add', `compose:${p}`, '--name', 'opt-returns']).status, 0);
  const r = await runtime(['opt-returns', 'go', '999', '--json'], at);
  assert.equal(r.status, 1, r.stdout);
  assert.match(J(r).error, /^returns pet never ran/);
  assert.equal(J(r).data.steps.length, 1);
  assert.equal(run(['remove', 'opt-returns']).status, 0);
});

test('a template nothing can answer is one error naming the step and the placeholder', async () => {
  const p = chainFile('unresolved', { compose: true, verbs: [{ name: 'go', description: 'read a field the pet has not got', args: [{ name: 'id' }],
    steps: [{ run: 'petstore get-pet-by-id {id}', as: 'pet', optional: true }, { run: 'petstore find-pets-by-status --status {pet.status}' }] }] });
  assert.equal(run(['add', `compose:${p}`, '--name', 'unresolved']).status, 0);
  const r = await runtime(['unresolved', 'go', '999', '--json'], at);
  assert.equal(r.status, 1, r.stdout);
  const j = J(r);
  assert.match(j.error, /^step 2 \(petstore find-pets-by-status\): \{pet\.status\} did not resolve$/);
  assert.equal(j.data.steps.length, 1);
  assert.equal(run(['remove', 'unresolved']).status, 0);
});

test('every step is its own audited command, and the composite is one more line on top', async () => {
  const before = auditLines().length;
  const r = await runtime(['ops', 'pet-family', '7', '--json'], at);
  assert.equal(r.status, 0, r.stderr);
  const rows = auditLines().slice(before);
  assert.equal(rows.length, 3, rows.map(x => `${x.adapter} ${x.verb}`).join(', '));
  assert.deepEqual(rows.map(x => `${x.adapter} ${x.verb}`), ['petstore get-pet-by-id', 'petstore find-pets-by-status', 'ops pet-family']);
  assert.deepEqual(rows.map(x => x.exit), [0, 0, 0]);
  assert.deepEqual(rows.at(-1).args, { id: '7' });
  assert.deepEqual(rows[0].args, { petId: '7' }, 'the step logs the value the template resolved to');
});

test('a step blocked by governance stops the chain at exit 3 and records the decision that blocked it', async () => {
  const r = await runtime(['ops', 'copy-pet', '7', '--suffix', 'II', '--json'], { ...at, DASHCLAW_API_KEY: 'k', DASHCLAW_URL: api });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const j = J(r);
  assert.equal(j.error, 'step 2 (petstore add-pet): blocked by governance: petstore writes are off');
  assert.equal(j.data.steps[0].ok, true, 'the read that came first still ran');
  assert.equal(j.data.steps[1].exit, 3);
  assert.equal(j.data.steps[1].governance.decision, 'block');
  // Two decisions, one per level: the composite was allowed on its own and the step it tried to run was not.
  assert.equal(j.meta.governance.decision, 'allow');
});

test('a chain that calls itself stops instead of forking forever', async () => {
  const p = chainFile('loop', { compose: true, verbs: [{ name: 'go', description: 'call one pet', args: [{ name: 'id' }], steps: [{ run: 'petstore get-pet-by-id {id}' }] }] });
  assert.equal(run(['add', `compose:${p}`, '--name', 'loop']).status, 0);
  writeFileSync(p, JSON.stringify({ compose: true, verbs: [{ name: 'go', description: 'call itself', args: [{ name: 'id' }], steps: [{ run: 'loop go {id}' }] }] }));
  assert.equal(run(['build', 'loop']).status, 0, 'the adapter exists now, so the self-reference compiles');
  const r = await runtime(['loop', 'go', '7', '--json'], at);
  assert.notEqual(r.status, 0);
  assert.match(J(r).error, /chains are nested 8 deep at loop go/);
  assert.equal(run(['remove', 'loop']).status, 0);
});

test('describe, skill, export and import all know a compose adapter', () => {
  const d = run(['describe', 'ops', '--json', 'false']);
  assert.match(d.stdout, /^ops \(compose\)  source: compose:/);
  assert.match(d.stdout, /copy-pet <id> {2,}look one pet up and add a copy of it \[mutating\]/);
  const skill = readFileSync(join(skills, 'ops', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: ops\n/);
  assert.match(skill, /step <i> \(<adapter> <verb>\)/);
  assert.match(skill, /asked about once for itself and once per mutating step/);
  assert.equal(J(run(['skill', 'ops', '--print'])).data.text, skill, '--print is the same text that was written');
  const bundle = join(home, 'ops-bundle.json');
  writeFileSync(bundle, run(['export', 'ops']).stdout);
  assert.equal(run(['remove', 'ops']).status, 0);
  assert.equal(run(['import', bundle]).status, 0);
  assert.equal(J(run(['describe', 'ops'])).data.engine, 'compose');
  assert.deepEqual(J(run(['lint', 'ops'])).data.errors, []);
});

test('declick compose is the same compile with the name first, from a file or from stdin', () => {
  const r = run(['compose', 'ops2', '--steps', 'fixtures/compose/chain.json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(J(r).data.engine, 'compose');
  assert.deepEqual(J(run(['manifest', 'ops2'])).data.verbs.map(v => v.name), ['pet-family', 'pet-name', 'pet-or-available', 'copy-pet']);
  // Stdin has no path to record, so the chain is copied where declick build can still find it.
  const doc = JSON.stringify({ compose: true, verbs: [{ name: 'one-pet', description: 'one pet by id', args: [{ name: 'id' }], steps: [{ run: 'petstore get-pet-by-id {id}', as: 'pet' }], returns: 'pet' }] });
  const s = run(['compose', 'piped', '--steps', '-'], {}, { input: doc });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(existsSync(join(home, 'piped', 'compose.json')));
  assert.equal(J(run(['build', 'piped'])).data.verbs[0].name, 'one-pet');
  assert.equal(run(['compose', 'petstore']).status, 1);
  assert.match(J(run(['compose', 'petstore'])).error, /petstore is a openapi adapter, not a chain/);
});

test('declick compose <name> with no --steps prints the chain, step by step', () => {
  const t = run(['compose', 'ops2', '--json', 'false']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^ops2 \(compose\)  source: compose:/);
  assert.match(t.stdout, /\n {4}1 {2}petstore get-pet-by-id \{id\} {2}-> pet\n/);
  assert.match(t.stdout, /\n {4}2 {2}petstore find-pets-by-status --status \{pet\.status\} {2}-> family\n/);
  assert.match(t.stdout, /\n {4}returns: family\n/);
  assert.match(t.stdout, /\(optional\)/); assert.match(t.stdout, /\[mutating\]/);
  const d = J(run(['compose', 'ops2'])).data;
  assert.equal(d.name, 'ops2');
  assert.deepEqual(d.verbs.find(v => v.verb === 'pet-name').steps, [{ run: 'petstore get-pet-by-id {id}', as: 'pet', optional: false, mutating: false }]);
  assert.equal(d.verbs.find(v => v.verb === 'pet-name').returns, '{pet.name}');
  srv.close();
});
