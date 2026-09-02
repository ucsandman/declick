import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/engines/openapi.mjs';
import { lint } from '../src/lint.mjs';

test('compile petstore', async () => {
  const m = await compile('fixtures/petstore.json', { name: 'petstore' });
  assert.equal(m.engine, 'openapi');
  assert.equal(m.baseUrl, 'https://petstore3.swagger.io/api/v3');
  const names = m.verbs.map(v => v.name);
  assert.deepEqual(names, ['find-pets-by-status', 'get-pet-by-id', 'delete-pet', 'add-pet']);
  const get = m.verbs.find(v => v.name === 'get-pet-by-id');
  assert.deepEqual(get.args, [{ name: 'petId', required: true }]);
  assert.equal(get.mutating, false);
  assert.deepEqual(get.http, { method: 'get', path: '/pet/{petId}', query: [], bodyProps: [], security: ['api_key'] });
  const del = m.verbs.find(v => v.name === 'delete-pet');
  assert.equal(del.mutating, true);
  const add = m.verbs.find(v => v.name === 'add-pet');
  assert.deepEqual(add.flags.map(f => f.name), ['body', 'name', 'status']);
  const find = m.verbs.find(v => v.name === 'find-pets-by-status');
  assert.deepEqual(find.flags[0], { name: 'status', description: 'available|pending|sold' });
  assert.deepEqual(m.auth.env, ['PETSTORE_API_KEY']);
  assert.deepEqual(lint(m), []);
});
