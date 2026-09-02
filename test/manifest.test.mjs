import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-'));
const { validateManifest, saveManifest, loadManifest, listManifests } = await import('../src/manifest.mjs');

const good = { name: 'pet', engine: 'openapi', source: 'x.json', builtAt: '2026-09-02T00:00:00Z',
  auth: { env: [] }, verbs: [{ name: 'list-pets', description: 'List pets', args: [], flags: [], mutating: false }] };

test('valid manifest has no errors', () => assert.deepEqual(validateManifest(good), []));
test('missing fields are reported', () => {
  const errs = validateManifest({ name: 'x' });
  assert.ok(errs.some(e => e.includes('engine')));
  assert.ok(errs.some(e => e.includes('verbs')));
});
test('verb names must be kebab-case', () => {
  const errs = validateManifest({ ...good, verbs: [{ ...good.verbs[0], name: 'ListPets' }] });
  assert.ok(errs.some(e => e.includes('kebab')));
});
test('secrets in manifest are rejected', () => {
  const errs = validateManifest({ ...good, auth: { env: ['API_KEY'], API_KEY: 'sk-live-abc' } });
  assert.ok(errs.some(e => e.includes('secret')));
});
test('save then load then list roundtrip', () => {
  saveManifest(good);
  assert.equal(loadManifest('pet').verbs[0].name, 'list-pets');
  assert.deepEqual(listManifests(), ['pet']);
});
