import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheRead, cacheWrite } from '../src/cache.mjs';

const previousHome = process.env.DECLICK_HOME;
const home = mkdtempSync(join(tmpdir(), 'declick-freshness-'));
process.env.DECLICK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.DECLICK_HOME;
  else process.env.DECLICK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const now = Date.parse('2026-11-13T12:00:00.000Z');
const result = { ok: true, data: ['fresh'] };

for (const [label, offset, expected] of [
  ['future timestamp after clock rollback', 1, false],
  ['future timestamp far ahead', 3600000, false],
  ['fractionally expired entry', -60500, false],
  ['exact TTL boundary', -60000, false],
  ['fresh entry', -59999, true],
]) {
  test(label, t => {
    t.mock.method(Date, 'now', () => now);
    cacheWrite('shop', 'entry', { at: new Date(now + offset).toISOString(), result });
    const hit = cacheRead('shop', 'entry', 60);
    assert.equal(hit !== null, expected);
    if (hit) assert.deepEqual(hit, { result, age: 59 });
  });
}
for (const invalid of [undefined, null, {}, { ok: false, error: 'upstream failure' }]) {
  test(`invalid cached response is a miss: ${JSON.stringify(invalid)}`, t => {
    t.mock.method(Date, 'now', () => now);
    cacheWrite('shop', 'entry', { at: new Date(now).toISOString(), result: invalid });
    assert.equal(cacheRead('shop', 'entry', 60), null);
  });
}
