import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const vault = join(mkdtempSync(join(tmpdir(), 'creds-')), 'vault.env');
writeFileSync(vault, 'PETSTORE_API_KEY=abc123\n');
process.env.CREDS_VAULT = vault;
const { compile, execute } = await import('../src/engines/openapi.mjs');
const m = await compile('fixtures/petstore.json', { name: 'petstore' });

test('dry-run builds request and masks secret', async () => {
  const r = await execute(m, 'get-pet-by-id', ['7'], { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.url, 'https://petstore3.swagger.io/api/v3/pet/7');
  assert.equal(r.data.headers.api_key, '<PETSTORE_API_KEY>');
});
test('query flags become querystring', async () => {
  const r = await execute(m, 'find-pets-by-status', [], { dryRun: true, status: 'sold' });
  assert.equal(r.data.url, 'https://petstore3.swagger.io/api/v3/pet/findByStatus?status=sold');
});
test('body props assemble a JSON body', async () => {
  const r = await execute(m, 'add-pet', [], { dryRun: true, name: 'Rex', status: 'available' });
  assert.deepEqual(JSON.parse(r.data.body), { name: 'Rex', status: 'available' });
  assert.equal(r.data.method, 'POST');
});
test('missing arg is an error', async () => {
  const r = await execute(m, 'get-pet-by-id', [], { dryRun: true });
  assert.equal(r.ok, false); assert.equal(r.exit, 1);
});
test('unknown verb is not found', async () => {
  const r = await execute(m, 'nope', [], {});
  assert.equal(r.exit, 2);
});
test('missing auth is exit 4', async () => {
  process.env.CREDS_VAULT = join(tmpdir(), 'nonexistent.env');
  const r = await execute(m, 'get-pet-by-id', ['7'], {});
  assert.equal(r.exit, 4); assert.match(r.error, /PETSTORE_API_KEY/);
  process.env.CREDS_VAULT = vault;
});
test('live call uses injected fetch and unwraps json', async () => {
  const fakeFetch = async (url, init) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ id: 7, name: 'Rex', hdr: init.headers.api_key }) });
  const r = await execute(m, 'get-pet-by-id', ['7'], {}, { fetch: fakeFetch });
  assert.deepEqual(r.data, { id: 7, name: 'Rex', hdr: 'abc123' });
});
