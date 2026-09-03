import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = process.env.DECLICK_LIVE === '1';
const home = mkdtempSync(join(tmpdir(), 'declick-live-'));
// Same rule as the authoring tests: drop any real key so the suite never calls the operator's governance service.
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills') };
delete env.DASHCLAW_API_KEY;
const cli = a => spawnSync(process.execPath, ['bin/declick.mjs', ...a], { env, encoding: 'utf8' });
const run = a => spawnSync(process.execPath, ['bin/run.mjs', ...a], { env, encoding: 'utf8' });
// A recipes dir written per test, so the read-only cases do not disturb the shipped fixtures.
const dir = (verb, recipe) => { const d = mkdtempSync(join(tmpdir(), 'live-recipes-')); writeFileSync(join(d, `${verb}.json`), JSON.stringify(recipe)); return d; };
const LAUNCH = { command: 'calc.exe', waitForWindow: 'Calculator', timeout: 20000 };

test('calculator add 7+7 reads 14', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  assert.equal(cli(['add', 'app:Calculator', '--name', 'calc', '--recipes', 'fixtures/calculator']).status, 0);
  const r = run(['calc', 'add', 'Seven', 'Seven', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(JSON.parse(r.stdout).data, /14/);
});
test('broken recipe exits 2 and names the missing element', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  assert.equal(cli(['add', 'app:Calculator', '--name', 'calc-broken', '--recipes', 'fixtures/broken']).status, 0);
  const r = run(['calc-broken', 'add', 'Seven', 'Seven', '--json']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /Button:Plus Sign/);
});
test('notepad write-text', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  assert.equal(cli(['add', 'app:Notepad', '--name', 'notepad', '--recipes', 'fixtures/notepad']).status, 0);
  const r = run(['notepad', 'write-text', 'declick was here', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
// The two cases below only read, so they never need "desk arm": they are the live proof that the tree,
// the launch and the candidates payload work against real UI Automation and not just the double.
test('read-all returns the real number pad, and launch opens Calculator first', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  const d = dir('list-pad', { description: 'List the number pad buttons', args: [], launch: LAUNCH,
    steps: [{ 'wait-for': ['Group:Number pad'], timeout: 20000 }, { 'read-all': ['Group:Number pad', 'Button:*'], as: 'rows' }], returns: 'rows' });
  assert.equal(cli(['add', 'app:Calculator', '--name', 'calc-read', '--recipes', d]).status, 0);
  const r = run(['calc-read', 'list-pad', '--json', '--limit', '20']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const names = JSON.parse(r.stdout).data.map(x => x.name);
  for (const n of ['Seven', 'Eight', 'Nine']) assert.ok(names.includes(n), `${n} missing from ${JSON.stringify(names)}`);
});
test('a path that misses the real tree comes back with candidates, not a screenshot', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  const d = dir('bad-path', { description: 'Deliberately wrong element path', args: [], launch: LAUNCH,
    steps: [{ find: ['Group:Number pad', 'Button:Nien'], as: 'x' }] });
  assert.equal(cli(['add', 'app:Calculator', '--name', 'calc-miss', '--recipes', d]).status, 0);
  const r = run(['calc-miss', 'bad-path', '--json']);
  assert.equal(r.status, 2, r.stdout);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.data.resolved, ['Group:Number pad']);
  assert.ok(j.data.candidates.some(c => c.name === 'Nine'), JSON.stringify(j.data.candidates));
  assert.match(j.error, /declick desk arm 30/);
});
