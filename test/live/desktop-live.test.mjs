import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = process.env.DECLICK_LIVE === '1';
const home = mkdtempSync(join(tmpdir(), 'declick-live-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills') };
const cli = a => spawnSync(process.execPath, ['bin/declick.mjs', ...a], { env, encoding: 'utf8' });
const run = a => spawnSync(process.execPath, ['bin/run.mjs', ...a], { env, encoding: 'utf8' });

test('calculator add 7+7 reads 14', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  spawnSync('cmd', ['/c', 'start', 'calc'], { stdio: 'ignore' }); spawnSync('timeout', ['/t', '2'], { stdio: 'ignore' });
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
  spawnSync('cmd', ['/c', 'start', 'notepad'], { stdio: 'ignore' }); spawnSync('timeout', ['/t', '2'], { stdio: 'ignore' });
  assert.equal(cli(['add', 'app:Notepad', '--name', 'notepad', '--recipes', 'fixtures/notepad']).status, 0);
  const r = run(['notepad', 'write-text', 'declick was here', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
