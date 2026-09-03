import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real ~/.creds/vault.env must not decide whether an auth assertion passes.
process.env.CREDS_VAULT = join(tmpdir(), 'declick-graphql-no-vault.env');
const { compile, execute } = await import('../src/engines/graphql.mjs');
const { lint } = await import('../src/lint.mjs');

const m = await compile('fixtures/graphql-schema.json', { name: 'petshop' });
const verb = name => m.verbs.find(v => v.name === name);
const flag = (v, name) => v.flags.find(f => f.name === name);
const SCHEMA = JSON.parse(readFileSync('fixtures/graphql-schema.json', 'utf8'));

const SDL = `"""A pet store."""
schema { query: Query mutation: Mutation }
directive @auth(requires: String = "ADMIN") on OBJECT
scalar DateTime
interface Node { id: ID! }
union Anything = Pet | Owner
type Query {
  "Pets matching a status"
  pets(status: Status!, limit: Int = 10): [Pet!]!
  pet(id: ID!): Pet
}
type Mutation {
  addPet(input: PetInput!): Pet
  deletePet(id: ID!): Boolean
}
type Pet implements Node @auth {
  id: ID!
  name: String!
  status: Status
  owner: Owner
}
type Owner { name: String! email: String }
enum Status { AVAILABLE PENDING SOLD }
input PetInput { name: String! status: Status }
`;

// One real server: it answers the introspection probe from the fixture and then runs the compiled operations.
function start({ requireAuth = false } = {}) {
  const seen = {};
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const send = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      seen.authorization = req.headers.authorization;
      if (requireAuth && !req.headers.authorization) return send({ errors: [{ message: 'unauthorized' }] }, 401);
      const { query, variables } = JSON.parse(raw);
      seen.query = query; seen.variables = variables;
      if (query.includes('__schema')) return send(SCHEMA);
      if (query.includes('addPet(')) return send({ data: { addPet: { id: '2', name: variables.input.name, status: variables.input.status ?? null, owner: null } } });
      if (query.includes('deletePet(')) return send({ data: { deletePet: true } });
      if (query.includes('pets(')) return send({ data: { pets: [{ id: '1', name: 'Rex', status: variables.status, owner: { name: 'Ann', email: 'ann@x.test' } }] } });
      if (query.includes('pet(')) return variables.id === 'missing' ? send({ errors: [{ message: 'no such pet' }] }) : send({ data: { pet: null } });
      send({ errors: [{ message: 'unknown operation' }] });
    });
  });
  return new Promise(done => srv.listen(0, '127.0.0.1', () => done({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/graphql`, close: async () => { srv.closeAllConnections(); await new Promise(r => srv.close(r)); } })));
}

test('compile turns query fields into verbs and mutation fields into mutating verbs', () => {
  assert.equal(m.engine, 'graphql');
  assert.deepEqual(m.verbs.map(v => v.name), ['pets', 'pet', 'add-pet', 'delete-pet']);
  assert.deepEqual(m.verbs.map(v => v.mutating), [false, false, true, true]);
  assert.equal(verb('pets').description, 'Pets matching a status');
  assert.deepEqual(verb('pets').graphql.kind, 'query');
  assert.equal(verb('add-pet').graphql.field, 'addPet');
  assert.deepEqual(m.auth, { env: [] });
});

test('scalar and enum arguments become flags and a contract name is renamed', () => {
  const v = verb('pets');
  assert.deepEqual(v.args, []);
  assert.deepEqual(v.flags.map(f => f.name), ['status', 'param-limit', 'select']);
  assert.deepEqual(flag(v, 'status'), { name: 'status', description: 'Status! argument', required: true, type: 'string', enum: ['AVAILABLE', 'PENDING', 'SOLD'] });
  assert.equal(flag(v, 'param-limit').required, false);
  assert.equal(flag(v, 'param-limit').type, 'number');
  assert.deepEqual(v.graphql.args, [
    { name: 'status', flag: 'status', type: 'Status!', required: true },
    { name: 'limit', flag: 'param-limit', type: 'Int', required: false },
  ]);
});

test('an input object argument becomes dotted flags plus a raw json flag', () => {
  const v = verb('add-pet');
  assert.deepEqual(v.flags.map(f => f.name), ['input', 'input.name', 'input.status', 'select']);
  assert.equal(flag(v, 'input').required, false);
  assert.equal(flag(v, 'input.name').required, true);
  assert.deepEqual(flag(v, 'input.status').enum, ['AVAILABLE', 'PENDING', 'SOLD']);
  assert.deepEqual(v.graphql.args[0].fields, [
    { name: 'name', flag: 'input.name', type: 'String!', required: true },
    { name: 'status', flag: 'input.status', type: 'Status', required: false },
  ]);
});

test('the default selection covers scalars and one level of nested objects', () => {
  assert.equal(verb('pets').graphql.selection, 'id name status owner { name email }');
  assert.equal(verb('delete-pet').graphql.selection, '');
  assert.equal(flag(verb('delete-pet'), 'select'), undefined);
});

test('returns come from the return type with array shape for lists', () => {
  assert.deepEqual(verb('pets').returns, { shape: 'array', fields: [{ name: 'id', type: 'ID' }, { name: 'name', type: 'String' }, { name: 'status', type: 'Status' }, { name: 'owner', type: 'Owner' }] });
  assert.equal(verb('pet').returns.shape, 'object');
  assert.deepEqual(verb('delete-pet').returns, { shape: 'scalar', fields: [] });
});

test('an sdl file compiles to the same verbs as introspection', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'declick-gql-')), 'schema.graphql');
  writeFileSync(p, SDL);
  const s = await compile(p, { name: 'petshop' });
  assert.deepEqual(s.verbs.map(v => v.name), m.verbs.map(v => v.name));
  assert.deepEqual(s.verbs.map(v => v.mutating), m.verbs.map(v => v.mutating));
  assert.deepEqual(s.verbs.map(v => v.graphql), m.verbs.map(v => v.graphql));
  assert.deepEqual(s.verbs.map(v => v.flags.map(f => f.name)), m.verbs.map(v => v.flags.map(f => f.name)));
  assert.deepEqual(flag(s.verbs[0], 'status').enum, ['AVAILABLE', 'PENDING', 'SOLD']);
});

test('dry-run shows the document and the variables', async () => {
  const q = await execute(m, 'pets', [], { dryRun: true, status: 'SOLD', paramLimit: '2' });
  assert.equal(q.ok, true);
  assert.equal(q.data.method, 'POST');
  assert.equal(q.data.document, 'query Pets($status: Status!, $limit: Int) { pets(status: $status, limit: $limit) { id name status owner { name email } } }');
  assert.deepEqual(q.data.variables, { status: 'SOLD', limit: 2 });
  const mu = await execute(m, 'add-pet', [], { dryRun: true, 'input.name': 'Rex', 'input.status': 'PENDING' });
  assert.equal(mu.data.document, 'mutation AddPet($input: PetInput!) { addPet(input: $input) { id name status owner { name email } } }');
  assert.deepEqual(mu.data.variables, { input: { name: 'Rex', status: 'PENDING' } });
  const raw = await execute(m, 'add-pet', [], { dryRun: true, input: '{"name":"Ada"}', 'input.status': 'SOLD' });
  assert.deepEqual(raw.data.variables, { input: { name: 'Ada', status: 'SOLD' } });
  const del = await execute(m, 'delete-pet', [], { dryRun: true, id: '7' });
  assert.equal(del.data.document, 'mutation DeletePet($id: ID!) { deletePet(id: $id) }');
  const sel = await execute(m, 'pets', [], { dryRun: true, status: 'SOLD', select: 'id name' });
  assert.equal(sel.data.document, 'query Pets($status: Status!) { pets(status: $status) { id name } }');
});

test('an off-enum value is rejected before any request', async () => {
  const boom = { fetch: () => { throw new Error('the request must not happen'); } };
  const r = await execute(m, 'pets', [], { status: 'GONE' }, boom);
  assert.equal(r.ok, false); assert.equal(r.exit, 1);
  assert.equal(r.error, '--status must be one of AVAILABLE, PENDING, SOLD, got GONE');
  const nested = await execute(m, 'add-pet', [], { 'input.name': 'Rex', 'input.status': 'nope' }, boom);
  assert.equal(nested.error, '--input.status must be one of AVAILABLE, PENDING, SOLD, got nope');
  const num = await execute(m, 'pets', [], { status: 'SOLD', paramLimit: 'ten' }, boom);
  assert.equal(num.error, '--param-limit must be a number, got ten');
});

test('a missing required flag names the flag and describe --full', async () => {
  const r = await execute(m, 'pets', [], { dryRun: true });
  assert.equal(r.exit, 1);
  assert.equal(r.error, 'pets needs --status; run: petshop describe --full');
  const inp = await execute(m, 'add-pet', [], { dryRun: true, 'input.status': 'SOLD' });
  assert.equal(inp.error, 'add-pet needs --input.name; run: petshop describe --full');
  const unknown = await execute(m, 'nope', [], {});
  assert.equal(unknown.exit, 2);
  assert.match(unknown.error, /run: declick describe petshop/);
});

test('a file-built adapter has no endpoint and says how to get one', async () => {
  const r = await execute(m, 'pets', [], { status: 'SOLD' });
  assert.equal(r.exit, 1);
  assert.match(r.error, /no endpoint; add it by URL: declick add graphql:<url> --name petshop/);
});

test('the compiled manifest passes lint and describe stays small', () => {
  // graphql joins ENGINES in src/manifest.mjs when the engine is registered; every other contract check must already hold.
  assert.deepEqual(lint(m).filter(e => !/^engine must be one of/.test(e)), []);
});

test('a real graphql server serves introspection, a query, a mutation and an error', async () => {
  const s = await start();
  try {
    const live = await compile(`graphql:${s.url}`, { name: 'petshop-live' });
    assert.equal(live.baseUrl, s.url);
    assert.equal(live.source, `graphql:${s.url}`);
    assert.deepEqual(live.verbs.map(v => v.name), ['pets', 'pet', 'add-pet', 'delete-pet']);
    const q = await execute(live, 'pets', [], { status: 'SOLD', paramLimit: '5' });
    assert.equal(q.ok, true, q.error);
    assert.deepEqual(q.data, [{ id: '1', name: 'Rex', status: 'SOLD', owner: { name: 'Ann', email: 'ann@x.test' } }]);
    assert.deepEqual(s.seen.variables, { status: 'SOLD', limit: 5 });
    const mu = await execute(live, 'add-pet', [], { 'input.name': 'Rex', 'input.status': 'PENDING' });
    assert.equal(mu.ok, true, mu.error);
    assert.deepEqual(mu.data, { id: '2', name: 'Rex', status: 'PENDING', owner: null });
    const del = await execute(live, 'delete-pet', [], { id: '7' });
    assert.deepEqual(del, { ok: true, data: true });
    const err = await execute(live, 'pet', [], { id: 'missing' });
    assert.equal(err.ok, false); assert.equal(err.exit, 1);
    assert.equal(err.error, 'no such pet');
    assert.deepEqual(err.data, { errors: [{ message: 'no such pet' }] });
    const gone = await execute(live, 'pet', [], { id: 'other' });
    assert.equal(gone.exit, 2);
    assert.match(gone.error, /pet returned null/);
  } finally { await s.close(); }
});

test('a 401 probe compiles with a bearer token and a runtime 401 is exit 4', async () => {
  const s = await start({ requireAuth: true });
  try {
    const bare = await compile(`graphql:${s.url}`, { name: 'secure' }).then(() => null, e => e);
    assert.equal(bare.exit, 4);
    assert.match(bare.message, /SECURE_TOKEN/);
    process.env.SECURE_TOKEN = 'tok-123';
    const live = await compile(`graphql:${s.url}`, { name: 'secure' });
    assert.deepEqual(live.auth.env, ['SECURE_TOKEN']);
    assert.equal(s.seen.authorization, 'Bearer tok-123');
    const dry = await execute(live, 'pets', [], { dryRun: true, status: 'SOLD' });
    assert.equal(dry.data.headers.authorization, 'Bearer <SECURE_TOKEN>');
    const ok = await execute(live, 'pets', [], { status: 'SOLD' });
    assert.equal(ok.ok, true, ok.error);
    delete process.env.SECURE_TOKEN;
    const missing = await execute(live, 'pets', [], { status: 'SOLD' });
    assert.equal(missing.exit, 4);
    assert.match(missing.error, /SECURE_TOKEN/);
    process.env.SECURE_TOKEN = 'tok-123';
    const rejected = await execute({ ...live, auth: { env: [] } }, 'pets', [], { status: 'SOLD' });
    assert.equal(rejected.exit, 4);
    assert.match(rejected.error, /-> 401/);
  } finally { delete process.env.SECURE_TOKEN; await s.close(); }
});
