import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here is mocked: a real detached daemon, a real socket, and the repo's real stdio MCP fixture server.
const home = mkdtempSync(join(tmpdir(), 'declick-daemon-'));
const skills = mkdtempSync(join(tmpdir(), 'declick-daemon-skills-'));
// A leaked daemon must not outlive the suite by ten minutes, so the default idle window is short for every test here.
const env = { ...process.env, DECLICK_HOME: home, DECLICK_SKILLS: skills, OPENCLAW_SKILLS: '', CREDS_VAULT: join(home, 'none.env'),
  DASHCLAW_API_KEY: '', DASHCLAW_URL: '', DECLICK_GUARD: '', DECLICK_DESK: join(home, 'no-desk'), DECLICK_DAEMON_IDLE_MS: '30000' };
const cli = (args, extra = {}) => spawnSync(process.execPath, ['bin/declick.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
const runVerb = (args, extra = {}) => spawnSync(process.execPath, ['bin/run.mjs', ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
const J = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`not json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); } };
const statePath = join(home, 'daemon.json');
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A raw client on the daemon's own endpoint: the wire, not a stub of it.
const ask = (path, msg) => new Promise((resolve, reject) => {
  const sock = connect(path);
  let buf = '';
  const t = setTimeout(() => { sock.destroy(); reject(new Error(`no answer from ${path} in 5s`)); }, 5000);
  sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
  sock.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return; clearTimeout(t); sock.destroy(); resolve(JSON.parse(buf.slice(0, nl))); });
  sock.on('error', e => { clearTimeout(t); reject(e); });
});

assert.equal(cli(['add', 'mcp:node fixtures/mcp-server.mjs', '--name', 'notes']).status, 0, 'the fixture adapter did not compile');
assert.equal(cli(['add', 'mcp:node fixtures/mcp-server.mjs --blob', '--name', 'blobs']).status, 0, 'the blob fixture adapter did not compile');
after(() => cli(['daemon', 'stop']));

test('a run with no daemon spawns its own server and claims nothing', () => {
  assert.equal(cli(['daemon', 'status']).status, 2, 'a fresh home reported a daemon');
  const r = J(runVerb(['notes', 'list-notes', '--json']));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.notes, [{ id: 'n1', title: 'A' }, { id: 'n2', title: 'B' }]);
  assert.ok(!r.meta.daemon, `no daemon is running, yet meta says ${JSON.stringify(r.meta)}`);
});

test('a started daemon answers every run from one pooled server, and stopping it puts the runs back on their own spawn', () => {
  const started = cli(['daemon', 'start']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(J(started).data.running, true);
  assert.ok(existsSync(statePath), 'daemon start wrote no daemon.json');

  const first = J(runVerb(['notes', 'list-notes', '--json']));
  assert.equal(first.ok, true, first.error);
  assert.equal(first.meta.daemon, true, 'the first run did not reach the daemon');
  const afterFirst = J(cli(['daemon', 'status'])).data;
  assert.equal(afterFirst.servers.length, 1, `one adapter, one server: ${JSON.stringify(afterFirst.servers)}`);

  const second = J(runVerb(['notes', 'list-notes', '--json']));
  assert.equal(second.meta.daemon, true, 'the second run did not reach the daemon');
  assert.deepEqual(second.data.notes, first.data.notes);
  // Two runs, one server: the pid has to be the same one, and there has to be exactly one of it.
  const up = J(cli(['daemon', 'status'])).data;
  assert.equal(up.running, true);
  assert.equal(up.servers.length, 1, `a second server was spawned: ${JSON.stringify(up.servers)}`);
  assert.equal(up.servers[0].adapter, 'notes');
  assert.equal(up.servers[0].pid, afterFirst.servers[0].pid, 'the second run got a different server');
  assert.equal(up.servers[0].calls, 2);
  assert.ok(up.servers[0].idleMs >= 0);

  // A mutating verb and a tool error travel the same socket, with the same envelope as the spawn path.
  const add = J(runVerb(['notes', 'add-note', 'Buy milk', '--count', '2', '--json']));
  assert.deepEqual(add.data, { id: 'n3', echo: { title: 'Buy milk', count: 2 } });
  assert.equal(add.meta.daemon, true);
  const boom = runVerb(['notes', 'boom', '--json']);
  assert.equal(boom.status, 1);
  assert.equal(J(boom).error, 'boom: the note book is on fire');
  assert.equal(J(cli(['daemon', 'status'])).data.servers.length, 1, 'a tool that said no killed the pooled server');

  const stopped = cli(['daemon', 'stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(J(stopped).data.stopped, true);
  assert.equal(existsSync(statePath), false, 'daemon.json outlived the daemon');
  assert.equal(cli(['daemon', 'status']).status, 2);
  assert.equal(cli(['daemon', 'stop']).status, 2, 'stopping nothing reported success');

  const cold = J(runVerb(['notes', 'list-notes', '--json']));
  assert.equal(cold.ok, true, cold.error);
  assert.deepEqual(cold.data.notes, first.data.notes);
  assert.ok(!cold.meta.daemon, 'a run after stop still claimed the daemon');
});

test('an answer bigger than one socket chunk arrives whole, and a second adapter is a second pooled server', () => {
  assert.equal(cli(['daemon', 'start']).status, 0);
  // --max-bytes 0: the default ceiling on data would replace the blob; this test is about the socket, not the cap.
  const r = J(runVerb(['blobs', 'blob', '400000', '--json', '--max-bytes', '0']));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.daemon, true);
  assert.equal(r.data.blob.length, 400000, 'the answer was cut at a chunk boundary');
  assert.equal(J(runVerb(['notes', 'list-notes', '--json'])).meta.daemon, true);
  // Two adapters spawned from two different commands are two servers, keyed apart, both alive at once.
  const up = J(cli(['daemon', 'status'])).data;
  assert.deepEqual(up.servers.map(s => s.adapter).sort(), ['blobs', 'notes']);
  assert.notEqual(up.servers[0].pid, up.servers[1].pid);
  assert.equal(cli(['daemon', 'stop']).status, 0);
});

test('runs racing a cold pool share one server instead of spawning one each', async () => {
  assert.equal(cli(['daemon', 'start']).status, 0);
  assert.equal(J(cli(['daemon', 'status'])).data.servers.length, 0, 'the pool was not cold');
  // Four runs reach a daemon with no server for this adapter at once, inside the window the server takes to
  // start. Whichever loses the race has to wait on the one being started, not start a second one of its own.
  const all = await Promise.all([0, 1, 2, 3].map(() => new Promise(res => {
    const p = spawn(process.execPath, ['bin/run.mjs', 'notes', 'list-notes', '--json'], { env });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => res(JSON.parse(out)));
  })));
  for (const r of all) { assert.equal(r.ok, true, r.error); assert.equal(r.meta.daemon, true); }
  const up = J(cli(['daemon', 'status'])).data;
  assert.equal(up.servers.length, 1, `four cold runs left ${up.servers.length} servers in the pool`);
  // The count is what catches a server the pool lost track of: an overwritten entry keeps its own calls.
  assert.equal(up.servers[0].calls, 4, 'a run was answered by a server the pool no longer holds');
  const pid = up.servers[0].pid;
  assert.equal(cli(['daemon', 'stop']).status, 0);
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, `pooled server ${pid} outlived the daemon`);
});

test('a pooled server answers faster than one spawned per run', t => {
  // This fixture starts in tens of milliseconds and a real MCP server takes seconds, so measuring the plain one
  // measures process noise. --slow-start gives the server a startup worth avoiding, which is the whole feature.
  assert.equal(cli(['add', 'mcp:node fixtures/mcp-server.mjs --slow-start 600', '--name', 'slow']).status, 0);
  // Best of three each way: one pair is a coin flip on a loaded machine, the floor is the cost being measured.
  const best = () => { let ms = Infinity; for (let i = 0; i < 3; i++) { const at = Date.now(); assert.equal(runVerb(['slow', 'list-notes', '--json']).status, 0); ms = Math.min(ms, Date.now() - at); } return ms; };
  const cold = best();
  assert.equal(cli(['daemon', 'start']).status, 0);
  assert.equal(J(runVerb(['slow', 'list-notes', '--json'])).meta.daemon, true, 'the pool never warmed');
  const warm = best();
  assert.equal(cli(['daemon', 'stop']).status, 0);
  t.diagnostic(`cold ${cold}ms, warm ${warm}ms (best of 3 each, against a server that takes 600ms to start)`);
  assert.ok(warm < cold / 2, `warm ${warm}ms is not meaningfully faster than cold ${cold}ms`);
});

test('a wrong token is refused, and nothing the daemon says carries the right one', async () => {
  assert.equal(cli(['daemon', 'start']).status, 0);
  const s = state();
  assert.deepEqual(await ask(s.endpoint, { token: 'not-the-token', op: 'status' }), { error: 'unauthorized' });
  assert.deepEqual(await ask(s.endpoint, { token: '', op: 'status' }), { error: 'unauthorized' }, 'a length mismatch is refused too');
  assert.deepEqual(await ask(s.endpoint, { token: 'x', op: 'stop' }), { error: 'unauthorized' });
  assert.deepEqual(await ask(s.endpoint, { token: 'x', adapter: 'notes', verb: 'list-notes', tool: 'list_notes', args: {} }), { error: 'unauthorized' });
  assert.ok(existsSync(statePath), 'an unauthorized stop went through');

  // The real token still works, so the refusals were the token and not a broken socket.
  const good = await ask(s.endpoint, { token: s.token, op: 'status' });
  assert.equal(good.status.running, true);
  assert.ok(!JSON.stringify(good).includes(s.token), 'status echoed the token back');
  assert.ok(!cli(['daemon', 'status']).stdout.includes(s.token), 'declick daemon status printed the token');
  assert.ok(!cli(['doctor']).stdout.includes(s.token), 'declick doctor printed the token');
  assert.ok(!readFileSync(join(home, 'audit.jsonl'), 'utf8').includes(s.token), 'the audit log carries the token');
  assert.equal(cli(['daemon', 'stop']).status, 0);
});

test('a daemon.json whose pid is gone is not a daemon', () => {
  // A pid that is certainly free: spawn a process, let it exit, then reuse its number.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  writeFileSync(statePath, JSON.stringify({ pid: dead, endpoint: 'declick-no-such-endpoint', token: 'stale', started: new Date().toISOString() }) + '\n');
  const st = cli(['daemon', 'status']);
  assert.equal(st.status, 2, st.stdout);
  assert.equal(J(st).data.running, false);
  const r = J(runVerb(['notes', 'list-notes', '--json']));
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.meta.daemon, 'a stale file made a run believe it had a daemon');
  // start overwrites the corpse instead of refusing because of it.
  assert.equal(cli(['daemon', 'start']).status, 0);
  assert.notEqual(state().pid, dead);
  assert.equal(cli(['daemon', 'stop']).status, 0);
});

test('an idle server is dropped and the daemon goes with it', async () => {
  // The window has to cover a start plus a run on a loaded CI runner, not just a quiet laptop.
  const short = { DECLICK_DAEMON_IDLE_MS: '8000' };
  assert.equal(cli(['daemon', 'start'], short).status, 0);
  const pid = state().pid;
  assert.equal(J(runVerb(['notes', 'list-notes', '--json'], short)).meta.daemon, true, 'the daemon went idle before the call');
  for (let i = 0; i < 400 && existsSync(statePath); i++) await sleep(100);
  assert.equal(existsSync(statePath), false, `daemon ${pid} never went idle`);
  assert.equal(cli(['daemon', 'status']).status, 2);
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, `daemon ${pid} dropped its file but stayed up`);
});
