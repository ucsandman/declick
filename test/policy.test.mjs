import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-policy-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-policy-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_POLICY: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const runtime = (args, extra = {}) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// Async twin for the tests that also run a server in this process: spawnSync would block the server's event loop.
const runtimeAsync = (args, extra = {}) => new Promise(res => { const c = spawn(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra } }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };

const POLICY = join(home, 'policy.json');
const setPolicy = (file, p = POLICY) => writeFileSync(p, typeof file === 'string' ? file : JSON.stringify(file, null, 2));
const clearPolicy = (p = POLICY) => rmSync(p, { force: true });
const check = (adapter, verb) => J(run(['policy', '--check', adapter, verb])).data;

test('the fixture adapter is there to police', () => {
  assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0);
});

test('a policy rule blocks a read verb before any request is built', () => {
  setPolicy({ rules: [{ adapter: 'petstore', verb: 'get-*', decision: 'block', reason: 'no reads from agents' }] });
  try {
    // petstore points at petstore3.swagger.io: exit 3 with no network error is the proof nothing was sent.
    const r = runtime(['petstore', 'get-pet-by-id', '7']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const j = J(r);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'blocked by policy: no reads from agents');
    assert.deepEqual(j.meta.governance, { enabled: false, decision: 'block', reason: 'no reads from agents', source: 'policy' });
    // The audit line records which governor decided, not just what it decided.
    const last = J(run(['audit', '--limit', '1'])).data[0];
    assert.equal(last.verb, 'get-pet-by-id');
    assert.equal(last.exit, 3);
    assert.deepEqual(last.governance, { enabled: false, decision: 'block', reason: 'no reads from agents', source: 'policy' });
  } finally { clearPolicy(); }
});

test('a rule with no reason falls back to its index, and a mutating verb is blocked the same way', () => {
  setPolicy({ rules: [{ adapter: 'petstore', verb: 'delete-pet', decision: 'block' }] });
  try {
    const r = runtime(['petstore', 'delete-pet', '7']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(J(r).error, 'blocked by policy: rule 0');
    assert.equal(J(r).meta.governance.source, 'policy');
  } finally { clearPolicy(); }
});

test('globs, first match wins and the mutating filter, as declick policy --check reports them', () => {
  setPolicy({ rules: [
    { adapter: 'petstore', verb: 'delete-*', decision: 'block', reason: 'no deletes from agents' },
    { adapter: '*', mutating: true, decision: 'warn', reason: 'writes are logged' },
    { adapter: 'crm', decision: 'allow' },
  ] });
  try {
    const del = check('petstore', 'delete-pet');
    assert.equal(del.decision, 'block'); assert.equal(del.rule, 0); assert.equal(del.mutating, true);
    assert.equal(del.reason, 'no deletes from agents');
    // add-pet is mutating but not a delete-*, so the second rule takes it.
    const add = check('petstore', 'add-pet');
    assert.equal(add.decision, 'warn'); assert.equal(add.rule, 1);
    // A read never matches a mutating:true rule, and no rule after it names petstore.
    const read = check('petstore', 'get-pet-by-id');
    assert.equal(read.decision, 'allow'); assert.equal(read.rule, null); assert.equal(read.reason, null); assert.equal(read.mutating, false);
  } finally { clearPolicy(); }
  // First match wins on the same pair, whichever way round the file is written.
  setPolicy({ rules: [{ adapter: 'pet*', decision: 'block', reason: 'prefix' }, { adapter: 'petstore', verb: 'delete-pet', decision: 'allow' }] });
  try { assert.deepEqual([check('petstore', 'delete-pet').decision, check('petstore', 'delete-pet').rule], ['block', 0]); } finally { clearPolicy(); }
  setPolicy({ rules: [{ adapter: 'petstore', verb: 'delete-pet', decision: 'allow' }, { adapter: 'pet*', decision: 'block', reason: 'prefix' }] });
  try { assert.deepEqual([check('petstore', 'delete-pet').decision, check('petstore', 'delete-pet').rule], ['allow', 0]); } finally { clearPolicy(); }
  // An adapter name that is not a glob and does not match leaves the run alone.
  setPolicy({ rules: [{ adapter: 'crm', decision: 'block', reason: 'not this adapter' }] });
  try { assert.equal(check('petstore', 'delete-pet').decision, 'allow'); } finally { clearPolicy(); }
});

test('warn runs the verb and says so; allow, a read and a dry run go through untouched', async () => {
  let calls = 0;
  const srv = createServer((req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 7, deleted: req.method === 'DELETE' })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const spec = join(home, 'pol.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.0', info: { title: 'Pol' }, servers: [{ url: base }], paths: { '/pet/{id}': {
      get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'id', in: 'path', required: true }] },
      delete: { operationId: 'deletePet', summary: 'Delete a pet', parameters: [{ name: 'id', in: 'path', required: true }] } } } }));
    assert.equal(run(['add', spec, '--name', 'pol']).status, 0);

    setPolicy({ rules: [{ adapter: 'pol', mutating: true, decision: 'warn', reason: 'writes are logged' }] });
    const before = calls;
    const w = await runtimeAsync(['pol', 'delete-pet', '7']);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stderr, /^warning: policy: writes are logged$/m);
    assert.deepEqual(J(w).meta.governance, { enabled: false, decision: 'warn', reason: 'writes are logged', source: 'policy' });
    assert.equal(J(w).data.deleted, true);
    assert.equal(calls, before + 1, 'a warned call really reaches the api');

    // mutating:true never matches a read: no warning, no source, the old read-only line stands.
    const r = await runtimeAsync(['pol', 'get-pet', '7']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(J(r).meta.governance, { enabled: false, decision: 'skipped', reason: 'read-only verb' });

    // A dry run sends nothing, so it never asks the policy either.
    setPolicy({ rules: [{ adapter: 'pol', decision: 'block', reason: 'no pol at all' }] });
    const d = await runtimeAsync(['pol', 'delete-pet', '7', '--dry-run']);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.equal(J(d).meta.governance.decision, 'dry-run');
    assert.equal(J(d).meta.governance.source, undefined);

    // An explicit allow is the same run as no policy at all, and it wins over the block behind it.
    setPolicy({ rules: [{ adapter: 'pol', verb: 'get-*', decision: 'allow' }, { adapter: '*', decision: 'block', reason: 'everything else' }] });
    const a = await runtimeAsync(['pol', 'get-pet', '7']);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.equal(a.stderr, '');
    assert.deepEqual(J(a).meta.governance, { enabled: false, decision: 'skipped', reason: 'read-only verb' });
  } finally { clearPolicy(); srv.close(); }
});

test('one blocked item stops an --each batch', () => {
  const items = join(home, 'items.ndjson');
  writeFileSync(items, '{"petId": 1}\n{"petId": 2}\n');
  setPolicy({ rules: [{ adapter: 'petstore', verb: 'get-pet-by-id', decision: 'block', reason: 'no reads from agents' }] });
  try {
    const r = runtime(['petstore', 'get-pet-by-id', '--each', items]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const j = J(r);
    assert.equal(j.data.length, 2);
    assert.equal(j.data[0].error, 'blocked by policy: no reads from agents');
    assert.match(j.data[1].error, /not run: item 1 was blocked/);
    assert.equal(j.meta.governance.source, 'policy');
  } finally { clearPolicy(); }
});

test('an invalid policy file fails closed: every run and declick policy itself are exit 1', () => {
  const bad = [
    ['not json at all', /not valid JSON/],
    [JSON.stringify({ rules: {} }), /rules must be an array/],
    [JSON.stringify({ rules: [], mode: 'strict' }), /unknown field mode/],
    [JSON.stringify({ rules: [{ adapter: 'petstore', decision: 'nope' }] }), /rules\[0\]\.decision must be allow, warn or block/],
    [JSON.stringify({ rules: [{ adapter: 'petstore', decision: 'block', when: 'now' }] }), /rules\[0\] has unknown field when/],
    [JSON.stringify({ rules: [{ adapter: 'petstore', decision: 'block', mutating: 'yes' }] }), /rules\[0\]\.mutating must be true or false/],
  ];
  try {
    for (const [body, why] of bad) {
      setPolicy(body);
      const read = runtime(['petstore', 'get-pet-by-id', '7']);
      assert.equal(read.status, 1, `${body}: exit ${read.status} ${read.stdout}`);
      assert.match(J(read).error, why);
      assert.match(J(read).error, /fix it or unset DECLICK_POLICY$/);
      assert.ok(J(read).error.startsWith(`policy file ${POLICY} is invalid: `), J(read).error);
      // A write fails closed too, before the guard and before the request.
      const write = runtime(['petstore', 'delete-pet', '7']);
      assert.equal(write.status, 1, `${body}: exit ${write.status} ${write.stdout}`);
      assert.match(J(write).error, why);
      // The command that would explain the file refuses in the same words, so the agent sees why runs fail.
      const cmd = run(['policy']);
      assert.equal(cmd.status, 1, cmd.stdout);
      assert.match(J(cmd).error, why);
      assert.equal(run(['policy', '--check', 'petstore', 'delete-pet']).status, 1);
    }
  } finally { clearPolicy(); }
});

test('declick policy prints the path, whether it exists, and one line per rule', () => {
  const none = run(['policy']);
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(J(none).data, { path: POLICY, exists: false, rules: [] });
  assert.ok(run(['policy', '--json', 'false']).stdout.includes(`no policy file at ${POLICY}`), run(['policy', '--json', 'false']).stdout);
  const rules = [
    { adapter: 'petstore', verb: 'delete-*', decision: 'block', reason: 'no deletes from agents' },
    { adapter: '*', mutating: true, decision: 'warn', reason: 'writes are logged' },
    { adapter: 'crm', decision: 'allow' },
  ];
  setPolicy({ rules });
  try {
    const j = J(run(['policy']));
    assert.equal(j.ok, true);
    assert.equal(j.data.exists, true);
    assert.deepEqual(j.data.rules, rules);
    const lines = run(['policy', '--json', 'false']).stdout.trim().split('\n');
    assert.equal(lines[0], '#0 petstore delete-* -> block (no deletes from agents)');
    assert.equal(lines[1], '#1 * * mutating -> warn (writes are logged)');
    assert.equal(lines[2], '#2 crm * -> allow');
    // --check answers the one question a rule list cannot: which rule wins for this verb.
    const t = run(['policy', '--check', 'petstore', 'delete-pet', '--json', 'false']).stdout;
    assert.match(t, /petstore delete-pet \(mutating\) -> block: no deletes from agents \(rule #0\)/);
    assert.equal(run(['policy', '--check', 'petstore', 'ghost-verb']).status, 2);
    assert.equal(run(['policy', '--check', 'ghost', 'delete-pet']).status, 2);
  } finally { clearPolicy(); }
});

test('declick policy --example prints a file worth copying, and DECLICK_POLICY moves the file', () => {
  const ex = J(run(['policy', '--example']));
  assert.equal(ex.ok, true);
  assert.ok(Array.isArray(ex.data.rules) && ex.data.rules.length >= 3, JSON.stringify(ex.data));
  assert.deepEqual(ex.data.rules[0], { adapter: 'petstore', verb: 'delete-*', decision: 'block', reason: 'no deletes from agents' });
  // The example is itself a valid policy file: writing it back is not an invalid-file error.
  const other = join(home, 'elsewhere.json');
  setPolicy(ex.data, other);
  try {
    assert.deepEqual([J(run(['policy'], { DECLICK_POLICY: other })).data.path, J(run(['policy'], { DECLICK_POLICY: other })).data.exists], [other, true]);
    // The default path has no file, so only the override blocks the delete.
    assert.equal(runtime(['petstore', 'delete-pet', '7'], { DECLICK_POLICY: other }).status, 3);
    assert.equal(J(run(['policy'])).data.exists, false, 'the default path is still empty');
  } finally { clearPolicy(other); }
});
