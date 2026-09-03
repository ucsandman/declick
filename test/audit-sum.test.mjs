import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-sum-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-sum-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env'), DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk') };
const run = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const runtime = (args, extra = {}) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const auditLines = () => readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const sum = (args = []) => J(run(['audit', '--sum', ...args])).data;

assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'petstore']).status, 0, 'fixture adapter');
assert.equal(run(['add', 'fixtures/petstore.json', '--name', 'shop']).status, 0, 'a second adapter to sort against');

// Runs first on purpose: the log is empty here, so the totals are exactly these calls and nothing else.
test('the sum is the lines added up, one row per adapter, biggest reader first', () => {
  for (let i = 0; i < 3; i++) assert.equal(runtime(['petstore', 'get-pet-by-id', String(i), '--dry-run']).status, 0);
  assert.equal(runtime(['shop', 'get-pet-by-id', '1', '--dry-run']).status, 0);
  const s = sum();
  assert.equal(s.calls, 4); assert.equal(s.ok, 4); assert.equal(s.failed, 0); assert.equal(s.blocked, 0);
  assert.deepEqual(s.adapters.map(a => a.adapter), ['petstore', 'shop'], 'sorted by bytes, biggest first');
  assert.deepEqual(s.adapters.map(a => a.calls), [3, 1]);
  assert.equal(s.bytes, s.adapters.reduce((n, a) => n + a.bytes, 0));
  assert.equal(s.ms, s.adapters.reduce((n, a) => n + a.ms, 0));
  assert.ok(s.adapters[0].bytes > s.adapters[1].bytes, JSON.stringify(s.adapters));
  assert.equal(s.bytes, auditLines().reduce((n, l) => n + l.bytes, 0));
});
test('bytes is what the run actually wrote to stdout', () => {
  const r = runtime(['petstore', 'find-pets-by-status', '--status', 'sold', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const line = auditLines().at(-1);
  assert.equal(line.verb, 'find-pets-by-status');
  assert.equal(line.bytes, Buffer.byteLength(r.stdout.trimEnd()));
  const before = sum(['--adapter', 'petstore']).bytes;
  runtime(['petstore', 'get-pet-by-id', '4', '--dry-run']);
  assert.equal(sum(['--adapter', 'petstore']).bytes, before + auditLines().at(-1).bytes);
});
test('a line written before bytes existed counts as 0, not as a dropped run', () => {
  appendFileSync(join(home, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), adapter: 'legacy', verb: 'old', mutating: false, dryRun: false, exit: 0, ok: true, ms: 7 }) + '\n');
  const s = sum(['--adapter', 'legacy']);
  assert.deepEqual(s.adapters, [{ adapter: 'legacy', calls: 1, bytes: 0, ms: 7, failed: 0 }]);
  assert.equal(s.calls, 1); assert.equal(s.bytes, 0); assert.equal(s.ms, 7);
});
test('a failure and a block are counted, and the failures stay a subset of the calls', () => {
  const policy = join(home, 'block.json');
  writeFileSync(policy, JSON.stringify({ rules: [{ adapter: 'shop', decision: 'block', reason: 'no reads today' }] }));
  assert.equal(runtime(['shop', 'nope']).status, 2, 'an unknown verb is a failed call');
  assert.equal(runtime(['shop', 'get-pet-by-id', '1'], { DECLICK_POLICY: policy }).status, 3, 'a blocked read never reaches the wire');
  const s = sum(['--adapter', 'shop']);
  assert.equal(s.calls, 3); assert.equal(s.failed, 2); assert.equal(s.blocked, 1); assert.equal(s.ok, 1);
  assert.equal(s.adapters[0].failed, 2);
  assert.ok(s.adapters[0].bytes > 0, 'an error envelope was still written and still cost bytes');
  assert.equal(sum(['--adapter', 'shop', '--failed']).calls, 2, '--failed narrows the sum the way it narrows the lines');
});
test('--since and --adapter narrow the sum, and an empty window sums to nothing', () => {
  assert.equal(sum(['--adapter', 'petstore']).adapters.length, 1);
  assert.equal(sum(['--since', '2h']).calls, J(run(['audit', '--since', '2h', '--limit', '500'])).data.length);
  const none = sum(['--since', new Date(Date.now() + 36e5).toISOString()]);
  assert.deepEqual(none, { calls: 0, ok: 0, failed: 0, blocked: 0, bytes: 0, ms: 0, adapters: [] });
});
test('the human rendering is one line per adapter and one total line', () => {
  const t = run(['audit', '--sum', '--json', 'false']);
  assert.equal(t.status, 0, t.stderr);
  const lines = t.stdout.trim().split('\n');
  const s = sum();
  assert.equal(lines.length, s.adapters.length + 1);
  assert.match(lines[0], /^petstore\t\d+ calls\t[\d.]+ (B|KB)\t\d+ms\t\d+ failed$/);
  assert.equal(lines.at(-1), `${s.calls} calls, ${s.bytes < 1024 ? `${s.bytes} B` : `${(s.bytes / 1024).toFixed(1)} KB`} read through adapters, ${s.failed} failed`);
  assert.match(lines.at(-1), /^\d+ calls, [\d.]+ (B|KB) read through adapters, \d+ failed$/);
  assert.match(run(['audit', '--sum', '--adapter', 'ghost', '--json', 'false']).stdout, /^no runs logged yet in /);
});
test('--sum is a declared boolean, so it never eats a token and --sum false is the lines', () => {
  assert.deepEqual(J(run(['audit', '--help'])).data.flags.find(f => f.name === 'sum')?.type, 'boolean');
  const r = run(['audit', '--sum', '--adapter', 'petstore']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(J(r).data.adapters.map(a => a.adapter), ['petstore']);
  assert.ok(Array.isArray(J(run(['audit', '--sum', 'false', '--limit', '500'])).data), '--sum false is still the run log');
});
