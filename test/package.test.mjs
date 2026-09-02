import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
test('package metadata is publish ready', () => {
  assert.equal(pkg.name, 'declick'); assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.homepage, 'https://declick.dev'); assert.equal(pkg.scripts.prepublishOnly, 'npm test');
  assert.ok(pkg.keywords.includes('agents')); assert.deepEqual(pkg.bin, { declick: 'bin/declick.mjs' });
});
test('npm pack ships bin, src, fixtures, README and nothing else', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: true });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map(f => f.path);
  for (const f of ['bin/declick.mjs', 'bin/run.mjs', 'src/ui.mjs', 'fixtures/petstore.json', 'README.md', 'LICENSE', 'package.json']) assert.ok(files.includes(f), `missing ${f}`);
  assert.ok(!files.some(f => f.startsWith('test/') || f.startsWith('site/') || f.startsWith('.handoff/') || f.startsWith('.github/')), files.join(','));
});
test('workflows and changelog exist', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/publish.yml', 'CHANGELOG.md']) assert.ok(existsSync(f), f);
  assert.match(readFileSync('.github/workflows/publish.yml', 'utf8'), /npm publish --provenance --access public/);
  assert.match(readFileSync('CHANGELOG.md', 'utf8'), /## 0\.1\.0/);
});
