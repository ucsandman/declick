import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gatherMcpSources, parseCodexToml } from '../src/setup.mjs';

const abs = p => resolve(p);
const sha = buf => createHash('sha256').update(buf).digest('hex');

function freshHomes() {
  return { home: mkdtempSync(join(tmpdir(), 'declick-setup-')), skills: mkdtempSync(join(tmpdir(), 'skills-setup-')), clientHome: mkdtempSync(join(tmpdir(), 'client-setup-')) };
}
function envFor({ home, skills, clientHome }, extra = {}) {
  return { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, DECLICK_CLIENT_HOME: clientHome, CREDS_VAULT: join(home, 'none.env'),
    DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk'), ...extra };
}
const run = (args, env) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env, encoding: 'utf8', timeout: 30000 });
// A test that also serves http in this process cannot block its own event loop on spawnSync (the CLI child
// would never reach the server this same process is holding a synchronous wait on); spawn instead, async.
const runAsync = (args, env) => new Promise(res => { const c = spawn(process.execPath, ['bin/declick.mjs', ...args], { env }); let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d); c.on('close', status => res({ status, stdout, stderr })); });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };

// A recursive listing of relative paths and content hashes, so "wrote nothing" and "byte-identical" can be
// asserted against the whole tree instead of guessing which files matter.
function snapshotTree(dir) {
  const out = {};
  (function walk(d, rel) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name); const r = rel ? `${rel}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r); else out[r] = sha(readFileSync(p));
    }
  })(dir, '');
  return out;
}

function startAuthServer() {
  return new Promise(res => {
    const server = createServer((req, r) => { r.writeHead(401, { 'content-type': 'application/json' }); r.end('{}'); });
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

// --- Scenario 1/2/4: a fresh client home, setup, a second idempotent run, then an unedited revert. ---
let s1, authServer, authUrl;

test('setup: fresh client home adopts a stdio server, skips an http one needing a token, writes rules, hook and a snapshot', async () => {
  s1 = freshHomes();
  mkdirSync(join(s1.clientHome, '.claude'), { recursive: true });
  authServer = await startAuthServer();
  authUrl = `http://127.0.0.1:${authServer.address().port}/mcp`;
  writeFileSync(join(s1.clientHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'node', args: [abs('fixtures/mcp-server.mjs')] }, secured: { url: authUrl } } }));
  s1.env = envFor(s1);
  const r = await runAsync(['setup', '--no-path'], s1.env);
  assert.equal(r.status, 0, r.stderr);
  const d = J(r).data;
  assert.deepEqual(d.adapters.built, ['notes']);
  assert.equal(d.adapters.skipped.length, 1);
  assert.equal(d.adapters.skipped[0].server, 'secured');
  assert.match(d.adapters.skipped[0].why, /SECURED_TOKEN/);
  const claudeMd = readFileSync(join(s1.clientHome, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /declick:start/); assert.match(claudeMd, /declick setup --revert/);
  assert.equal(d.rules[0].action, 'added');
  assert.equal(d.hook.action, 'added');
  const settings = JSON.parse(readFileSync(join(s1.clientHome, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.PreToolUse.some(m => m.matcher === 'mcp__.*|WebFetch' && m.hooks.some(h => h.command.includes('declick-nudge'))));
  assert.ok(existsSync(join(s1.home, 'hooks', 'declick-nudge.cjs')));
  const servers = JSON.parse(readFileSync(join(s1.home, 'hooks', 'servers.json'), 'utf8'));
  assert.equal(servers.notes, 'notes');
  assert.ok(d.snapshot && existsSync(join(d.snapshot, 'manifest.json')));
  s1.snapshot = d.snapshot;
  const manifest = JSON.parse(readFileSync(join(d.snapshot, 'manifest.json'), 'utf8'));
  for (const f of manifest.files) assert.equal(f.after, existsSync(f.path) ? sha(readFileSync(f.path)) : null, f.path);
  s1.before = { claudeMd: readFileSync(join(s1.clientHome, '.claude', 'CLAUDE.md'), 'utf8'), settings: readFileSync(join(s1.clientHome, '.claude', 'settings.json'), 'utf8') };
});

test('setup: a second run is a no-op (rules unchanged, hook present, no new adapter, no new snapshot)', async () => {
  const r = await runAsync(['setup', '--no-path'], s1.env);
  assert.equal(r.status, 0, r.stderr);
  const d = J(r).data;
  assert.equal(d.rules[0].action, 'unchanged');
  assert.equal(d.hook.action, 'present');
  assert.deepEqual(d.adapters.built, []);
  assert.equal(d.snapshot, null);
});

test('setup --revert: unedited restores byte-for-byte, deletes files setup created, removes the adapter, clears latest', () => {
  const r = run(['setup', '--revert'], s1.env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(s1.clientHome, '.claude', 'CLAUDE.md')), 'CLAUDE.md did not exist before setup');
  assert.ok(!existsSync(join(s1.clientHome, '.claude', 'settings.json')), 'settings.json did not exist before setup');
  assert.ok(!existsSync(join(s1.home, 'notes', 'manifest.json')), 'the notes adapter should be removed');
  assert.ok(!existsSync(join(s1.home, 'hooks')));
  assert.ok(!existsSync(join(s1.home, 'setup', 'latest')));
  authServer.close();
});

// --- Scenario 3: --dry-run on a fresh home writes nothing at all. ---
test('setup --dry-run writes nothing: the client home and declick home are byte-identical before and after', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  writeFileSync(join(s.clientHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'node', args: [abs('fixtures/mcp-server.mjs')] } } }));
  const env = envFor(s);
  const before = { client: snapshotTree(s.clientHome), home: snapshotTree(s.home) };
  const r = run(['setup', '--dry-run'], env);
  assert.equal(r.status, 0, r.stderr);
  const d = J(r).data;
  assert.ok(d.wouldBuild.includes('notes'));
  const after = { client: snapshotTree(s.clientHome), home: snapshotTree(s.home) };
  assert.deepEqual(after, before);
});

// --- Scenario 5: an edited rules file and settings.json keep the user's edit; revert strips only ours. ---
test('setup --revert: an edit since setup is kept, only the block/hook entry declick added is stripped', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  writeFileSync(join(s.clientHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: 'node', args: [abs('fixtures/mcp-server.mjs')] } } }));
  const env = envFor(s);
  const r = run(['setup', '--no-path'], env);
  assert.equal(r.status, 0, r.stderr);
  const claudeMdPath = join(s.clientHome, '.claude', 'CLAUDE.md');
  const settingsPath = join(s.clientHome, '.claude', 'settings.json');
  const myLine = '\n## my own project notes\nnever touch this.\n';
  writeFileSync(claudeMdPath, readFileSync(claudeMdPath, 'utf8') + myLine);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const rr = run(['setup', '--revert'], env);
  assert.equal(rr.status, 0, rr.stderr);
  const dd = J(rr).data;
  assert.ok(dd.files.some(f => f.path === claudeMdPath && f.action === 'block removed, later edits kept'));
  assert.ok(dd.files.some(f => f.path === settingsPath && f.action === 'hook entry removed, later edits kept'));
  const claudeMdAfter = readFileSync(claudeMdPath, 'utf8');
  assert.match(claudeMdAfter, /never touch this/);
  assert.ok(!claudeMdAfter.includes('declick:start'));
  const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(settingsAfter.hooks.PreToolUse.some(m => m.matcher === 'Bash'));
  assert.ok(!settingsAfter.hooks.PreToolUse.some(m => (m.hooks || []).some(h => String(h.command || '').includes('declick-nudge'))));
});

// --- Scenario 6: the standalone revert.mjs in the snapshot works with node builtins only. ---
test('standalone revert.mjs restores files without importing anything outside node:', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  const env = envFor(s);
  const r = run(['setup', '--no-path'], env);
  assert.equal(r.status, 0, r.stderr);
  const snapshot = J(r).data.snapshot;
  const revertSrc = readFileSync(join(snapshot, 'revert.mjs'), 'utf8');
  for (const m of revertSrc.matchAll(/^\s*import\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm)) assert.match(m[1], /^node:/, `non-node import: ${m[1]}`);
  const claudeMd = join(s.clientHome, '.claude', 'CLAUDE.md');
  assert.ok(existsSync(claudeMd));
  const standalone = spawnSync(process.execPath, [join(snapshot, 'revert.mjs')], { encoding: 'utf8' });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.stdout, /files restored/);
  assert.ok(!existsSync(claudeMd), 'CLAUDE.md did not exist before setup');
});

// --- Scenario 7: a symlinked CLAUDE.md -> AGENTS.md collapses to one block. ---
test('a symlinked CLAUDE.md pointing at AGENTS.md gets one block, not two', (t) => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  mkdirSync(join(s.clientHome, '.agents'), { recursive: true });
  writeFileSync(join(s.clientHome, '.agents', 'AGENTS.md'), '# agents notes\n');
  try { symlinkSync(join(s.clientHome, '.agents', 'AGENTS.md'), join(s.clientHome, '.claude', 'CLAUDE.md')); }
  catch { t.skip('symlink creation needs a privilege this runner does not have'); return; }
  const env = envFor(s);
  const r = run(['setup', '--no-path', '--no-adopt', '--no-hook'], env);
  assert.equal(r.status, 0, r.stderr);
  const agentsText = readFileSync(join(s.clientHome, '.agents', 'AGENTS.md'), 'utf8');
  const count = (agentsText.match(/declick:start/g) || []).length;
  assert.equal(count, 1, agentsText);
  assert.equal(J(r).data.rules.length, 1);
});

// --- Scenario 8: settings.json that is not JSON is left untouched. ---
test('a settings.json that is not valid JSON skips the hook and never gets touched', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  writeFileSync(join(s.clientHome, '.claude', 'settings.json'), 'not { json');
  const env = envFor(s);
  const r = run(['setup', '--no-path', '--no-adopt', '--no-rules'], env);
  assert.equal(r.status, 0, r.stderr);
  const d = J(r).data;
  assert.equal(d.hook.action, 'skipped');
  assert.match(d.hook.reason, /not valid JSON/);
  assert.equal(readFileSync(join(s.clientHome, '.claude', 'settings.json'), 'utf8'), 'not { json');
});

// --- Scenario 9: uninstall needs --yes; --dry-run and a bare call touch nothing. ---
test('uninstall refuses without --yes and touches nothing; --yes removes the home and prints the npm line', () => {
  const s = freshHomes();
  const env = envFor(s);
  const bare = run(['uninstall'], env);
  assert.equal(bare.status, 1);
  assert.match(J(bare).error, /--yes/);
  assert.ok(existsSync(s.home));
  const dry = run(['uninstall', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(existsSync(s.home));
  const yes = run(['uninstall', '--yes'], env);
  assert.equal(yes.status, 0, yes.stderr);
  assert.ok(!existsSync(s.home));
  assert.match(yes.stdout.includes('"ok"') ? J(yes).data.next : yes.stdout, /npm rm -g declick/);
});

// --- Scenario 10: doctor reports integration before and after setup. ---
test('doctor reports integration before and after setup', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.claude'), { recursive: true });
  const env = envFor(s);
  const before = J(run(['doctor'], env)).data.integration;
  assert.equal(before.setup, null);
  assert.equal(before.revertAvailable, false);
  assert.equal(before.clients.find(c => c.client === 'claude').rules, false);
  const r = run(['setup', '--no-path', '--no-adopt'], env);
  assert.equal(r.status, 0, r.stderr);
  const after = J(run(['doctor'], env)).data.integration;
  assert.ok(after.setup);
  assert.equal(after.revertAvailable, true);
  assert.equal(after.clients.find(c => c.client === 'claude').rules, true);
  assert.equal(after.clients.find(c => c.client === 'claude').hook, true);
});

// --- Scenario 11: codex config.toml with two mcp_servers tables parses into two sources. ---
test('gatherMcpSources reads two [mcp_servers.*] tables out of a codex config.toml', () => {
  const s = freshHomes();
  mkdirSync(join(s.clientHome, '.codex'), { recursive: true });
  const script = abs('fixtures/mcp-server.mjs');
  writeFileSync(join(s.clientHome, '.codex', 'config.toml'), [
    '[mcp_servers.alpha]', `command = "node"`, `args = ["${script.replace(/\\/g, '\\\\')}"]`, '',
    '[mcp_servers.beta]', `url = "https://example.test/mcp"`,
  ].join('\n'));
  const parsed = parseCodexToml(join(s.clientHome, '.codex', 'config.toml'));
  assert.deepEqual(Object.keys(parsed).sort(), ['alpha', 'beta']);
  assert.equal(parsed.alpha.command, 'node');
  assert.equal(parsed.beta.url, 'https://example.test/mcp');
  const sources = gatherMcpSources(s.clientHome, process.cwd());
  assert.deepEqual(sources.map(x => x.serverName).sort(), ['alpha', 'beta']);
});

// --- DECLICK_PATH_PROFILE: the one case that exercises the PATH edit, on every platform including CI. ---
test('setup --no-adopt --no-rules --no-hook: the PATH edit writes to DECLICK_PATH_PROFILE and setup --revert removes exactly that line', () => {
  const s = freshHomes();
  const profile = join(s.home, 'fake-profile');
  writeFileSync(profile, '# existing profile content\n');
  const env = envFor(s, { DECLICK_PATH_PROFILE: profile });
  const r = run(['setup', '--no-adopt', '--no-rules', '--no-hook'], env);
  assert.equal(r.status, 0, r.stderr);
  const d = J(r).data;
  assert.equal(d.path.kind, 'profile');
  assert.equal(d.path.file, profile);
  assert.equal(d.path.added, true);
  const after = readFileSync(profile, 'utf8');
  assert.match(after, /export PATH=/);
  assert.match(after, /existing profile content/);
  const rr = run(['setup', '--revert'], env);
  assert.equal(rr.status, 0, rr.stderr);
  const restored = readFileSync(profile, 'utf8');
  assert.match(restored, /existing profile content/);
  assert.ok(!restored.includes('export PATH='), restored);
});
