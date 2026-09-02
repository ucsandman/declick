import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'declick-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, CREDS_VAULT: join(home, 'none.env') };
const run = (args) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env, encoding: 'utf8' });
const runtime = (args) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env, encoding: 'utf8' });

test('add compiles, lints, writes launcher and skill', () => {
  const r = run(['add', 'fixtures/petstore.json', '--name', 'petstore']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /petstore \(openapi\)/);
  assert.ok(existsSync(join(home, 'petstore', 'manifest.json')));
  assert.ok(existsSync(join(home, 'bin', 'petstore.cmd')));
  const skill = readFileSync(join(skills, 'petstore', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: petstore/);
  assert.match(skill, /petstore describe/);
});
test('list and describe', () => {
  assert.match(run(['list']).stdout, /petstore/);
  assert.match(run(['describe', 'petstore']).stdout, /find-pets-by-status/);
});
test('runtime dry-run emits json envelope', () => {
  const r = runtime(['petstore', 'get-pet-by-id', '7', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true); assert.equal(j.data.headers.api_key, '<PETSTORE_API_KEY>');
});
test('runtime unknown verb exits 2', () => assert.equal(runtime(['petstore', 'nope']).status, 2));
test('runtime missing auth exits 4', () => assert.equal(runtime(['petstore', 'get-pet-by-id', '7']).status, 4));
test('mutating without governance warns on stderr', () => {
  const r = runtime(['petstore', 'delete-pet', '7', '--dry-run']);
  assert.equal(r.status, 0);
});
test('remove deletes adapter', () => {
  assert.equal(run(['remove', 'petstore']).status, 0);
  assert.ok(!existsSync(join(home, 'petstore')));
});
test('add unknown adapter name exits 2 on describe', () => assert.equal(run(['describe', 'ghost']).status, 2));
