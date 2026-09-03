import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, guardUrl, riskScore, redactArgs, stepsMutate, derivedMutating } from '../src/guard.mjs';
import { lint } from '../src/lint.mjs';
import { parseRecipe } from '../src/author.mjs';

const home = mkdtempSync(join(tmpdir(), 'declick-gov-'));
const skills = mkdtempSync(join(tmpdir(), 'skills-gov-'));
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, OPENCLAW_SKILLS: '', CREDS_VAULT: join(home, 'none.env'),
  DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_AUDIT: '', DECLICK_ENV_ALLOW: '', DECLICK_DESK: join(home, 'no-desk') };
const cli = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
// The servers below run in this process, so anything that calls back into them is spawned async:
// spawnSync would block this event loop and the child would wait forever for its own reply.
const async_ = (bin, args, extra = {}) => new Promise(res => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...env, ...extra } });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
  c.on('close', status => res({ status, stdout, stderr }));
});
const runtime = (args, extra) => async_('bin/run.mjs', args, extra);
const cliAsync = (args, extra) => async_('bin/declick.mjs', args, extra);
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const auditLines = () => readFileSync(join(home, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// Built at runtime so the shape reaches the redactor without a token-looking literal in the repo.
const FAKE_TOKEN = ['sk', 'live', 'abcdefghijklmnop'].join('-');
const FAKE_GH = ['ghp', 'abcdefghijklmnop'].join('_');

// One real server plays both roles: the governance endpoint and the API the adapter calls.
let mode = 'allow', lastGuard = null, lastHeaders = null, lastUrl = null, base, srv, apiCalls = 0;
const spec = url => ({
  openapi: '3.0.0', info: { title: 'Gov' }, servers: [{ url }],
  components: { securitySchemes: { api_key: { type: 'apiKey', in: 'header', name: 'x-api-key' } } }, security: [{ api_key: [] }],
  paths: { '/pet/{id}': {
    get: { operationId: 'getPet', summary: 'Get a pet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
    delete: { operationId: 'deletePet', summary: 'Delete a pet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } } },
});

test('setup: one governed adapter pointed at a real local server', async () => {
  srv = createServer((req, res) => {
    if (req.url.startsWith('/api/guard')) {
      let d = ''; req.on('data', c => d += c);
      return req.on('end', () => {
        lastGuard = JSON.parse(d || '{}'); lastHeaders = req.headers; lastUrl = req.url;
        if (mode === 'hang') return;
        if (mode === '500') { res.writeHead(500); return res.end('boom'); }
        if (mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"nope":1}'); }
        const body = { decision: mode, reason: `policy says ${mode}`, ...(mode === 'require_approval' ? { approvalId: 'apr_42' } : {}) };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
      });
    }
    apiCalls++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: '7', deleted: req.method === 'DELETE' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const p = join(home, 'gov-spec.json');
  writeFileSync(p, JSON.stringify(spec(base)));
  assert.equal(cli(['add', p, '--name', 'gov']).status, 0);
  assert.deepEqual(J(cli(['describe', 'gov', '--full'])).data.auth.env, ['GOV_API_KEY']);
});

test('guardUrl needs a url and refuses plain http off loopback', () => {
  const keep = process.env.DASHCLAW_URL;
  delete process.env.DASHCLAW_URL;
  assert.match(guardUrl().error, /DASHCLAW_URL is not set/);
  process.env.DASHCLAW_URL = 'http://guard.example.com';
  assert.match(guardUrl().error, /must be https unless the host is loopback/);
  process.env.DASHCLAW_URL = 'https://guard.example.com/';
  assert.deepEqual(guardUrl(), { url: 'https://guard.example.com' });
  process.env.DASHCLAW_URL = 'http://127.0.0.1:9/base/';
  assert.deepEqual(guardUrl(), { url: 'http://127.0.0.1:9/base' });
  if (keep === undefined) delete process.env.DASHCLAW_URL; else process.env.DASHCLAW_URL = keep;
});

test('riskScore ranks the verb and redactArgs keeps values short and secret-free', () => {
  assert.equal(riskScore({ engine: 'openapi', method: 'delete' }), 70);
  assert.equal(riskScore({ engine: 'desktop' }), 60);
  assert.equal(riskScore({ engine: 'openapi', method: 'get' }), 40);
  const r = redactArgs({ id: '7', token: FAKE_TOKEN, long: 'a sentence '.repeat(20), skip: undefined, n: 3 });
  assert.deepEqual(Object.keys(r), ['id', 'token', 'long', 'n']);
  assert.equal(r.token, '<redacted>');
  assert.equal(r.long.length, 67, r.long); assert.ok(r.long.endsWith('...'));
  assert.equal(r.n, '3');
});

test('the guard body carries the target, the risk score and redacted args', async () => {
  process.env.DASHCLAW_API_KEY = 'k'; process.env.DASHCLAW_URL = base; process.env.DASHCLAW_TIMEOUT_MS = '2000';
  mode = 'allow';
  const g = await guard({ tool: 'gov', action: 'delete-pet', engine: 'openapi', method: 'delete', target: `${base}/pet/{id}`, args: { id: '7', key: FAKE_GH } });
  assert.deepEqual(g, { allowed: true, decision: 'allow', reason: 'allow' });
  // DashClaw's guard input: action_type, agent_name, a tool object; the key travels as x-api-key, not a bearer.
  assert.equal(lastGuard.action_type, 'delete-pet'); assert.equal(lastGuard.action, 'delete-pet'); assert.equal(lastGuard.agent_name, 'declick');
  assert.equal(lastGuard.risk_score, 70); assert.equal(lastGuard.target, `${base}/pet/{id}`);
  assert.deepEqual(lastGuard.systems_touched, ['127.0.0.1']);
  assert.equal(lastGuard.agent_id, 'declick'); assert.equal(lastGuard.declared_goal, 'declick run gov delete-pet');
  assert.deepEqual(lastGuard.tool, { name: 'gov', engine: 'openapi', method: 'delete', source: 'declick', args: { id: '7', key: '<redacted>' } });
  assert.equal(lastHeaders['x-api-key'], 'k'); assert.equal(lastHeaders.authorization, undefined);
  assert.equal(lastUrl, '/api/guard?record=true');
});

test('warn allows, block and require_approval refuse, and an approval carries its id', async () => {
  mode = 'warn';
  const w = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.equal(w.allowed, true); assert.equal(w.decision, 'warn'); assert.equal(w.reason, 'policy says warn');
  mode = 'block';
  const b = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.deepEqual(b, { allowed: false, decision: 'block', reason: 'policy says block' });
  mode = 'require_approval';
  const a = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.deepEqual(a, { allowed: false, decision: 'require_approval', reason: 'policy says require_approval', approvalId: 'apr_42' });
});

test('a 500, a garbage body and a timeout block by default and only warn with DECLICK_GUARD=open', async () => {
  process.env.DASHCLAW_TIMEOUT_MS = '300';
  for (const m of ['500', 'garbage']) {
    mode = m;
    const strict = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
    assert.equal(strict.allowed, false, m); assert.equal(strict.decision, 'block', m); assert.match(strict.reason, /strict/);
    process.env.DECLICK_GUARD = 'open';
    const open = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
    assert.equal(open.allowed, true, m); assert.equal(open.decision, 'failed-open', m);
    delete process.env.DECLICK_GUARD;
  }
  mode = 'hang';
  const t = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.equal(t.allowed, false); assert.match(t.reason, /unreachable \(timeout\)/);
  const keep = process.env.DASHCLAW_URL;
  delete process.env.DASHCLAW_URL;
  const nourl = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.equal(nourl.allowed, false); assert.match(nourl.reason, /DASHCLAW_URL is not set/);
  process.env.DASHCLAW_URL = keep;
  mode = 'allow';
  for (const k of ['DASHCLAW_API_KEY', 'DASHCLAW_URL', 'DASHCLAW_TIMEOUT_MS']) delete process.env[k];
  const off = await guard({ tool: 'gov', action: 'x', engine: 'openapi', method: 'post' });
  assert.deepEqual(off, { allowed: true, decision: 'skipped', reason: 'no guard configured' });
});

const desktopVerb = mutating => ({ name: 'add', description: 'Add', mutating, args: [], flags: [],
  recipe: { steps: [{ window: 'Calculator' }, { find: ['Button:1'], as: 'a' }, { click: 'a' }, { find: ['Text:D'], as: 'o' }, { read: 'o', as: 'r' }], returns: 'r', tree: null } });
const desktopM = mutating => ({ name: 'calc', engine: 'desktop', source: 'app:Calculator', window: 'Calculator', builtAt: 'now', auth: { env: [] }, verbs: [desktopVerb(mutating)] });
const webM = mutating => ({ name: 'shop', engine: 'web', source: 'web:https://shop.test', window: 'https://shop.test', builtAt: 'now', auth: { env: [] },
  verbs: [{ name: 'search', description: 'Search', mutating, args: [], flags: [], recipe: { steps: [{ goto: '/' }, { find: '#q', as: 'q' }, { type: ['q', 'hat'] }] } }] });

test('mutating is derived from the steps and from the method', () => {
  assert.equal(stepsMutate('desktop', [{ window: 'C' }, { find: ['Text:D'], as: 'o' }, { read: 'o', as: 'r' }, { wait: 10 }]), false);
  assert.equal(stepsMutate('desktop', [{ window: 'C' }, { find: ['Button:1'], as: 'a' }, { click: 'a' }]), true);
  assert.equal(stepsMutate('desktop', [{ find: ['Edit:x'], as: 'e' }, { type: ['e', 'hi'] }]), true);
  assert.equal(stepsMutate('desktop', [{ key: '{ENTER}' }]), true);
  assert.equal(stepsMutate('web', [{ goto: '/' }, { find: '#q', as: 'q' }, { 'read-all': '.row', as: 'r', fields: { t: 'h2' } }]), false);
  assert.equal(stepsMutate('web', [{ goto: '/' }, { find: '#b', as: 'b' }, { click: 'b' }]), true);
  assert.equal(derivedMutating(desktopM(false), desktopM(false).verbs[0]), true);
  assert.equal(derivedMutating(webM(false), webM(false).verbs[0]), true);
  assert.equal(derivedMutating({ engine: 'openapi' }, { http: { method: 'get' } }), false);
  assert.equal(derivedMutating({ engine: 'openapi' }, { http: { method: 'PATCH' } }), true);
  // No steps and no method: nothing to derive from, so the manifest keeps what its engine compiled.
  assert.equal(derivedMutating({ engine: 'mcp' }, { name: 'x', mutating: false }), null);
});

test('lint rejects a manifest that lowered mutating below its steps', () => {
  assert.ok(lint(desktopM(false)).some(e => /add: mutating false, but its steps change state/.test(e)), JSON.stringify(lint(desktopM(false))));
  assert.deepEqual(lint(desktopM(true)), []);
  assert.ok(lint(webM(false)).some(e => /mutating false/.test(e)));
  assert.deepEqual(lint(webM(true)), []);
  const readOnly = { ...desktopM(false), verbs: [{ ...desktopVerb(false), recipe: { steps: [{ window: 'C' }, { find: ['Text:D'], as: 'o' }, { read: 'o', as: 'r' }], returns: 'r', tree: null } }] };
  assert.deepEqual(lint(readOnly), [], 'a recipe that only reads may say mutating false');
});

test('a desktop recipe that claims mutating false still compiles as mutating', async () => {
  const { compile } = await import('../src/engines/desktop.mjs');
  const dir = join(home, 'recipes-in');
  mkdirSync(dir, { recursive: true });
  const { name, mutating, flags, recipe, ...rest } = desktopVerb(false);
  writeFileSync(join(dir, 'add.json'), JSON.stringify({ ...rest, mutating: false, steps: recipe.steps, returns: recipe.returns }));
  const m = await compile('app:Calculator', { name: 'calc-derive', recipes: dir });
  assert.equal(m.verbs[0].mutating, true);
});

test('parseRecipe defaults mutating to true and leaves an explicit value alone', () => {
  const body = { verb: 'add', description: 'Add', args: [], steps: [{ window: 'C' }], returns: 'r', example: [], expect: '1' };
  assert.equal(parseRecipe('```json\n' + JSON.stringify(body) + '\n```').mutating, true);
  assert.equal(parseRecipe('```json\n' + JSON.stringify({ ...body, mutating: false }) + '\n```').mutating, false);
});

test('every envelope from bin/run.mjs carries meta.governance', async () => {
  const d = await runtime(['gov']);
  assert.equal(J(d).meta.governance.decision, 'skipped');
  assert.equal(J(d).meta.governance.reason, 'describe');
  assert.equal(J(d).meta.governance.enabled, false);
  const unknown = await runtime(['gov', 'nope']);
  assert.equal(unknown.status, 2); assert.equal(J(unknown).meta.governance.decision, 'skipped');
  const dry = await runtime(['gov', 'delete-pet', '7', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(J(dry).meta.governance.decision, 'dry-run');
  const read = await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k' });
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(J(read).meta.governance.reason, 'read-only verb');
  assert.deepEqual(J(read).meta.credentials, [{ name: 'GOV_API_KEY', from: 'env' }]);
});

test('a blocked run is exit 3 with the decision in meta; require_approval carries the id', async () => {
  const g = { DASHCLAW_API_KEY: 'k', DASHCLAW_URL: base, DASHCLAW_TIMEOUT_MS: '2000', GOV_API_KEY: 'k' };
  mode = 'block';
  const b = await runtime(['gov', 'delete-pet', '7'], g);
  assert.equal(b.status, 3, b.stdout + b.stderr);
  assert.match(J(b).error, /blocked by governance: policy says block/);
  assert.deepEqual(J(b).meta.governance, { enabled: true, decision: 'block', reason: 'policy says block' });
  mode = 'require_approval';
  const a = await runtime(['gov', 'delete-pet', '7'], g);
  assert.equal(a.status, 3);
  assert.match(J(a).error, /needs approval: policy says require_approval \(approvalId apr_42\)/);
  assert.equal(J(a).meta.governance.decision, 'require_approval');
  assert.deepEqual(J(a).data, { approvalId: 'apr_42' });
  mode = 'allow';
  const before = apiCalls;
  const ok = await runtime(['gov', 'delete-pet', '7'], g);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(J(ok).data.deleted, true);
  assert.equal(apiCalls, before + 1, 'an allowed call really reaches the api');
  assert.equal(J(ok).meta.governance.decision, 'allow');
  // The guard saw the resolved path and the argument values, not just the verb name.
  assert.equal(lastGuard.target, `${base}/pet/{id}`);
  assert.deepEqual(lastGuard.tool.args, { id: '7' });
});

test('an unreachable guard blocks by default and warns only with DECLICK_GUARD=open', async () => {
  const g = { DASHCLAW_API_KEY: 'k', DASHCLAW_URL: base, DASHCLAW_TIMEOUT_MS: '300', GOV_API_KEY: 'k' };
  mode = 'hang';
  const s = await runtime(['gov', 'delete-pet', '7'], g);
  assert.equal(s.status, 3, s.stdout + s.stderr);
  assert.match(J(s).error, /unreachable \(timeout\)/);
  const o = await runtime(['gov', 'delete-pet', '7'], { ...g, DECLICK_GUARD: 'open' });
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.match(o.stderr, /proceeding ungoverned/);
  assert.equal(J(o).meta.governance.decision, 'failed-open');
  mode = 'allow';
});

test('a failing run writes last-error.json and the next good one clears it', async () => {
  const p = join(home, 'gov', 'last-error.json');
  const bad = await runtime(['gov', 'get-pet', '7']);
  assert.equal(bad.status, 4, bad.stdout);
  const le = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(le.verb, 'get-pet'); assert.equal(le.exit, 4); assert.match(le.error, /GOV_API_KEY/);
  assert.equal(JSON.parse(readFileSync(join(home, 'gov', 'last-run.json'), 'utf8')).error, le.error);
  const ok = await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!existsSync(p), 'a success clears last-error.json');
});

test('every invocation appends one audit line, and DECLICK_AUDIT=off writes none', async () => {
  const before = auditLines().length;
  await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k' });
  const rows = auditLines();
  assert.equal(rows.length, before + 1);
  const last = rows.at(-1);
  assert.equal(last.adapter, 'gov'); assert.equal(last.verb, 'get-pet'); assert.equal(last.ok, true); assert.equal(last.exit, 0);
  assert.equal(last.mutating, false); assert.equal(last.dryRun, false);
  assert.deepEqual(last.args, { id: '7' });
  assert.equal(last.governance.decision, 'skipped');
  assert.ok(typeof last.ms === 'number' && last.ms >= 0);
  assert.ok(Date.parse(last.at) > 0);
  const del = await runtime(['gov', 'delete-pet', FAKE_TOKEN, '--dry-run', '--json']);
  assert.equal(del.status, 0, del.stderr);
  const dry = auditLines().at(-1);
  assert.equal(dry.dryRun, true); assert.equal(dry.mutating, true);
  assert.deepEqual(dry.args, { id: '<redacted>' }, 'a secret-looking argument never reaches the log');
  assert.deepEqual(dry.flags, { dryRun: true, json: true }, 'only contract flags are logged');
  const n = auditLines().length;
  await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k', DECLICK_AUDIT: 'off' });
  assert.equal(auditLines().length, n);
});

test('a key is scoped to the origin its adapter was built from', async () => {
  const elsewhere = `http://127.0.0.1:${srv.address().port + 1}`;
  const blocked = await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k', DECLICK_GOV_BASE_URL: elsewhere });
  assert.equal(blocked.status, 4, blocked.stdout + blocked.stderr);
  assert.match(J(blocked).error, new RegExp(`GOV_API_KEY is scoped to ${base}`));
  assert.match(J(blocked).error, /rebuild the adapter for .* or set DECLICK_ENV_ALLOW=GOV_API_KEY/);
  assert.doesNotMatch(J(blocked).error, /--base-url/, 'the refusal must not teach the flag that skips it');
  const allowed = await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k', DECLICK_GOV_BASE_URL: elsewhere, DECLICK_ENV_ALLOW: 'GOV_API_KEY' });
  assert.notEqual(allowed.status, 4, allowed.stdout);
  const explicit = await runtime(['gov', 'get-pet', '7', '--base-url', elsewhere], { GOV_API_KEY: 'k' });
  assert.notEqual(explicit.status, 4, explicit.stdout);
  assert.match(explicit.stderr, new RegExp(`GOV_API_KEY is scoped to ${base}; --base-url sends it to ${elsewhere}`));
  // stderr is not the contract: an agent that reads --json has to see that the key left its origin.
  assert.deepEqual(J(explicit).meta.credentials, [{ name: 'GOV_API_KEY', from: 'env', scopedTo: base, sentTo: elsewhere }]);
  assert.deepEqual(J(allowed).meta.credentials, [{ name: 'GOV_API_KEY', from: 'env', scopedTo: base, sentTo: elsewhere }]);
  const same = await runtime(['gov', 'get-pet', '7'], { GOV_API_KEY: 'k' });
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.deepEqual(J(same).meta.credentials, [{ name: 'GOV_API_KEY', from: 'env' }]);
});

test('an adapter may not ask for a key outside its own prefix', async () => {
  const p = join(home, 'gov', 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  const patched = JSON.parse(JSON.stringify(m));
  patched.auth.env = ['OPENAI_API_KEY'];
  patched.auth.schemes.api_key.env = 'OPENAI_API_KEY';
  writeFileSync(p, JSON.stringify(patched, null, 2));
  const r = await runtime(['gov', 'get-pet', '7'], { OPENAI_API_KEY: 'not-a-real-key' });
  assert.equal(r.status, 4, r.stdout);
  assert.match(J(r).error, /gov asks for OPENAI_API_KEY, outside GOV_\*/);
  const allowed = await runtime(['gov', 'get-pet', '7'], { OPENAI_API_KEY: 'not-a-real-key', DECLICK_ENV_ALLOW: 'OPENAI_API_KEY' });
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  writeFileSync(p, JSON.stringify(m, null, 2));
});

test('doctor reports governance strictness and reachability', async () => {
  const off = J(cli(['doctor'])).data.governance;
  assert.deepEqual(off, { enabled: false, url: null, strict: false, reachable: null });
  const on = J(await cliAsync(['doctor'], { DASHCLAW_API_KEY: 'k', DASHCLAW_URL: base })).data.governance;
  assert.equal(on.enabled, true); assert.equal(on.strict, true); assert.equal(on.url, base); assert.equal(on.reachable, true);
  const open = J(await cliAsync(['doctor'], { DASHCLAW_API_KEY: 'k', DASHCLAW_URL: base, DECLICK_GUARD: 'open' })).data.governance;
  assert.equal(open.strict, false);
  const bad = cli(['doctor'], { DASHCLAW_API_KEY: 'k', DASHCLAW_URL: 'http://guard.example.com' });
  assert.equal(bad.status, 1);
  assert.match(J(bad).data.governance.error, /must be https unless the host is loopback/);
  assert.ok(J(bad).data.blocking.some(b => /https/.test(b)));
});

test('teardown', () => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });
