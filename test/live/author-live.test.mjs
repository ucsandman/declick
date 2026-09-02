import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = process.env.DECLICK_LIVE === '1';
const home = mkdtempSync(join(tmpdir(), 'declick-author-live-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: join(home, 'skills') };
const cli = a => spawnSync(process.execPath, ['bin/declick.mjs', ...a], { env, encoding: 'utf8', timeout: 400000 });
const run = a => spawnSync(process.execPath, ['bin/run.mjs', ...a], { env, encoding: 'utf8' });

test('author a real Calculator multiply verb with sonnet', { skip: !live && 'DECLICK_LIVE not set' }, () => {
  spawnSync('cmd', ['/c', 'start', 'calc'], { stdio: 'ignore' }); spawnSync('timeout', ['/t', '2'], { stdio: 'ignore' });
  const r = cli(['add', 'app:Calculator', '--name', 'calc', '--goal', 'multiply two numbers given as digit names like Three and Four and return the display text', '--verb', 'multiply']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const m = run(['calc', 'multiply', 'Three', 'Four', '--json']);
  assert.equal(m.status, 0, m.stderr + m.stdout);
  assert.match(JSON.parse(m.stdout).data, /12/);
});
