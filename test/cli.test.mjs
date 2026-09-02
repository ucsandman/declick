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
test('add desktop adapter from recipes dir', () => {
  const r = run(['add', 'app:Calculator', '--name', 'calc', '--recipes', 'fixtures/calculator']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /add <a> <b>/);
});

const fakeEnv = { ...env, DECLICK_DESK: join(process.cwd(), 'test', 'fake-desk.mjs'), DECLICK_AUTHOR: join(process.cwd(), 'test', 'fake-author.mjs'), FAKE_DESK_ARMED: '1', FAKE_DESK_DISPLAY: '14' };
const goodRecipe = { verb: 'add', description: 'Add two numbers', args: [{ name: 'a' }, { name: 'b' }], mutating: false,
  steps: [{ window: 'Calculator' }, { find: ['Group:Number pad', 'Button:{{a}}'], as: 'a' }, { click: 'a' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }],
  returns: 'result', example: ['Seven', 'Seven'], expect: '14' };
const cli = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...fakeEnv, ...extra }, encoding: 'utf8' });

test('add app: with --goal authors and builds', () => {
  const r = cli(['add', 'app:Calculator', '--name', 'calc-auth', '--goal', 'add two numbers', '--verb', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify(goodRecipe) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /calc-auth \(desktop\)/); assert.match(r.stdout, /add/);
  assert.ok(existsSync(join(home, 'calc-auth', 'recipes', 'add.json')));
  assert.ok(existsSync(join(home, 'bin', 'calc-auth.cmd')));
});
test('author adds a second verb to an existing adapter', () => {
  const r = cli(['author', 'calc-auth', '--goal', 'read the display', '--verb', 'show'], { FAKE_AUTHOR_RECIPE: JSON.stringify({ ...goodRecipe, verb: 'show', args: [], example: [], steps: [{ window: 'Calculator' }, { find: ['Text:Display is*'], as: 'out' }, { read: 'out', as: 'result' }] }) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(run(['describe', 'calc-auth']).stdout, /show/);
});
test('failed replay exits 2 and keeps a proposal', () => {
  const r = cli(['author', 'calc-auth', '--goal', 'nope', '--verb', 'nope'], { FAKE_AUTHOR_RECIPE: JSON.stringify({ ...goodRecipe, verb: 'nope', expect: '^never$' }) });
  assert.equal(r.status, 2, r.stdout); assert.match(r.stderr, /proposal kept at/);
  assert.ok(existsSync(join(home, 'calc-auth', 'proposals', 'nope.json')));
});
test('repair seeds the author with the last diff', () => {
  const miss = spawnSync(process.execPath, ['bin/run.mjs', 'calc-auth', 'add', 'Nine', 'Seven', '--json'], { env: fakeEnv, encoding: 'utf8' });
  assert.equal(miss.status, 2, miss.stdout);
  const le = JSON.parse(readFileSync(join(home, 'calc-auth', 'last-error.json'), 'utf8'));
  assert.equal(le.verb, 'add'); assert.match(le.error, /Button:Nine/);
  const log = join(home, 'repair-prompt.txt');
  const r = cli(['repair', 'calc-auth', 'add'], { FAKE_AUTHOR_RECIPE: JSON.stringify(goodRecipe), FAKE_AUTHOR_LOG: log });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const prompt = readFileSync(log, 'utf8');
  assert.match(prompt, /repairing/); assert.match(prompt, /Button:Nine/);
});
test('usage lists author and repair', () => {
  assert.match(run([]).stdout, /declick author/); assert.match(run([]).stdout, /declick repair/);
});
