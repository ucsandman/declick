import { connect, createServer } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, loadManifest } from './manifest.mjs';
import { mcpClient } from './mcp-client.mjs';
import { EXIT } from './output.mjs';

// Spawning a stdio MCP server is what a call to one costs: seconds, almost all of it startup. The daemon keeps
// the server alive between runs, so only the first run pays. It is a cache, not a policy boundary: the guard,
// the local policy and the audit line all still run in bin/run.mjs, on this side of the socket.
export const SERVE_FLAG = '--daemon-serve';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'declick.mjs');
const CONNECT_MS = 300; // a daemon that is not up has to cost a run almost nothing before it spawns its own server
const idleMs = () => Number(process.env.DECLICK_DAEMON_IDLE_MS) || 600000;
// The first call through a cold daemon still waits for the server to start, so the client's budget is the tool's plus that.
const callMs = () => (Number(process.env.DECLICK_TIMEOUT_MS) || 30000) + 5000;
const sha = (v, n) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const quiet = fn => { try { fn(); } catch { /* the endpoint or the state file is already gone */ } };

export const statePath = () => join(HOME, 'daemon.json');

// A Windows pipe name is global, so it carries the user (no other account resolves it) and a hash of DECLICK_HOME
// (a test daemon and a real one are two daemons, not one name fought over). A unix socket sits in HOME already.
export function endpoint() {
  if (process.platform !== 'win32') return join(HOME, 'daemon.sock');
  let user = 'user';
  quiet(() => { user = userInfo().username || user; });
  return `\\\\.\\pipe\\declick-${user.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase().slice(0, 32)}-${sha(HOME, 8)}`;
}

// EPERM is a live process this user does not own; only ESRCH means the pid is really gone.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A daemon.json whose pid is gone is a crash, not a daemon: every caller reads it as not running.
export function daemonState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    return Number.isInteger(s?.pid) && s.endpoint && s.token && alive(s.pid) ? s : null;
  } catch { return null; }
}

// Constant time, length first because timingSafeEqual throws on a length mismatch.
const sameToken = (given, real) => {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
};

// One request, one newline-terminated JSON answer, one connection. Every failure is null, which every caller
// reads as "no daemon" and answers by doing the work itself.
export function send(path, msg, { connectMs = CONNECT_MS, timeout = 30000 } = {}) {
  return new Promise(resolve => {
    let sock = null, buf = '', done = false, timer = setTimeout(() => finish(null), connectMs);
    function finish(v) { if (done) return; done = true; clearTimeout(timer); quiet(() => sock?.destroy()); resolve(v); }
    try { sock = connect(path); } catch { return finish(null); }
    sock.on('connect', () => { clearTimeout(timer); timer = setTimeout(() => finish(null), timeout); sock.write(JSON.stringify(msg) + '\n'); });
    // An answer is a directory listing as often as a status line: read to the newline that ends it, never the first chunk.
    sock.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return; try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); } });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

// null: no daemon, spawn as before. {result}: a hit. {error, spawn}: the daemon never reached the tool, so the
// caller's own spawn is still the right next move. {error}: the tool call itself failed and must not be repeated.
export async function callViaDaemon(msg) {
  const s = daemonState();
  if (!s) return null;
  return send(s.endpoint, { ...msg, op: 'call', token: s.token }, { timeout: callMs() });
}

export function serveDaemon() {
  return new Promise(resolve => {
    const token = randomBytes(24).toString('hex');
    const ep = endpoint();
    const started = new Date().toISOString();
    const pool = new Map(); const conns = new Set();
    let exitTimer = null, stopping = false;

    // No servers for one idle window and the daemon is a process holding a socket for nothing: it goes.
    const armExit = () => { if (stopping) return; clearTimeout(exitTimer); exitTimer = setTimeout(shutdown, idleMs()); };
    const touch = key => { const s = pool.get(key); clearTimeout(s.timer); s.timer = setTimeout(() => drop(key), idleMs()); };
    const drop = key => {
      const s = pool.get(key);
      if (!s) return;
      clearTimeout(s.timer); quiet(() => s.client.close()); pool.delete(key);
      if (!pool.size) armExit();
    };

    function shutdown() {
      if (stopping) return;
      stopping = true; clearTimeout(exitTimer);
      for (const key of [...pool.keys()]) drop(key);
      // The state file is what every other process reads; it goes before the socket, so nobody dials a corpse.
      quiet(() => rmSync(statePath(), { force: true }));
      for (const c of conns) quiet(() => c.destroy());
      srv.close(() => { if (process.platform !== 'win32') quiet(() => rmSync(ep, { force: true })); resolve(); });
    }

    const reply = (sock, body) => quiet(() => sock.write(JSON.stringify(body) + '\n'));
    const snapshot = () => ({
      running: true, pid: process.pid, started, endpoint: ep,
      servers: [...pool.values()].map(s => ({ adapter: s.adapter, pid: s.client.pid, calls: s.calls, idleMs: Date.now() - s.last })),
    });

    async function handle(sock, line) {
      let msg = null;
      try { msg = JSON.parse(line); } catch { return reply(sock, { error: 'bad request' }); }
      // A wrong token is refused and told nothing else; the right one is never written to a reply or a log.
      if (!sameToken(msg?.token, token)) return reply(sock, { error: 'unauthorized' });
      if (msg.op === 'status') return reply(sock, { status: snapshot() });
      if (msg.op === 'stop') return sock.end(JSON.stringify({ stopped: true, pid: process.pid }) + '\n', shutdown);
      const { adapter, verb, tool, args } = msg;
      const where = `${adapter} ${verb}`;
      let m;
      try { m = loadManifest(adapter); } catch (e) { return reply(sock, { error: `${where}: ${e.message}`, spawn: true }); }
      if (m.engine !== 'mcp' || m.mcp?.transport !== 'stdio') return reply(sock, { error: `${where}: not a stdio mcp adapter`, spawn: true });
      // One live server per adapter and per what it was spawned from: rebuild an adapter with a different
      // command, different arguments or different auth keys and the next call gets a new server, not the old one.
      const key = `${adapter} ${sha([m.mcp.command, m.mcp.args || [], m.auth?.env || []], 16)}`;
      let s = pool.get(key);
      if (s && !s.client.alive) { drop(key); s = undefined; }
      if (!s) {
        // Calls that race a cold pool must share one server, so the entry lands in the pool before the connect is
        // awaited and every one of them waits on the same promise. Awaiting first would spawn a server per caller
        // and leave all but the last orphaned: not in status, never idle-killed, never closed.
        const client = mcpClient({ ...m.mcp });
        s = { adapter, client, calls: 0, last: Date.now(), timer: null, ready: client.connect() };
        s.ready.catch(() => { /* the request awaiting it reports the failure; this only stops an unhandled rejection */ });
        pool.set(key, s); touch(key); clearTimeout(exitTimer); exitTimer = null;
      }
      try { await s.ready; } catch (e) { drop(key); return reply(sock, { error: e.message, spawn: true }); }
      try {
        const result = await s.client.callTool(tool, args || {});
        s.calls++; s.last = Date.now(); touch(key);
        reply(sock, { result });
      } catch (e) {
        // A server that died mid-call is dropped and respawned on the next one; a tool that merely said no is not.
        if (!s.client.alive) drop(key); else { s.last = Date.now(); touch(key); }
        reply(sock, { error: e.message });
      }
    }

    const srv = createServer(sock => {
      conns.add(sock);
      sock.on('close', () => conns.delete(sock));
      sock.on('error', () => { /* a client that hangs up mid-request is its own business */ });
      let buf = '', handled = false;
      sock.on('data', d => {
        if (handled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        handled = true;
        handle(sock, buf.slice(0, nl));
      });
    });

    mkdirSync(HOME, { recursive: true });
    // A hard-killed daemon leaves its socket file behind and listen() answers EADDRINUSE; daemonState already
    // said nobody is home, so the corpse goes first. A Windows pipe leaves no file to clean up.
    if (process.platform !== 'win32' && existsSync(ep)) quiet(() => rmSync(ep, { force: true }));
    srv.on('error', () => { process.exitCode = EXIT.ERROR; resolve(); });
    srv.listen(ep, () => {
      // 0600 is the real control on a unix socket; on Windows it is the per-user pipe name plus the token below.
      if (process.platform !== 'win32') quiet(() => chmodSync(ep, 0o600));
      writeFileSync(statePath(), JSON.stringify({ pid: process.pid, endpoint: ep, token, started }, null, 2) + '\n', { mode: 0o600 });
      armExit();
    });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
  });
}

const pub = s => ({ running: true, pid: s.pid, endpoint: s.endpoint, started: s.started });

export async function daemonStart() {
  const up = daemonState();
  if (up) return { ...pub(up), already: true };
  const child = spawn(process.execPath, [CLI, SERVE_FLAG], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // Started means it answers, not that it was spawned: poll for the file it writes once it is listening.
  for (let i = 0; i < 100; i++) {
    const s = daemonState();
    if (s && (await send(s.endpoint, { token: s.token, op: 'status' }))?.status) return { ...pub(s), already: false };
    await sleep(50);
  }
  throw fail('the daemon did not answer within 5s; run: declick doctor');
}

export async function daemonStop() {
  const s = daemonState();
  if (!s) return null;
  await send(s.endpoint, { token: s.token, op: 'stop' }, { timeout: 5000 });
  // Stopped means gone, not asked: daemon.json is what the next run reads, so wait for it to disappear.
  for (let i = 0; i < 60; i++) { if (!daemonState()) return { pid: s.pid }; await sleep(50); }
  quiet(() => process.kill(s.pid));
  quiet(() => rmSync(statePath(), { force: true }));
  return { pid: s.pid, killed: true };
}

const DOWN = { running: false, pid: null, started: null, servers: [] };

export async function daemonStatus() {
  const s = daemonState();
  if (!s) return DOWN;
  return (await send(s.endpoint, { token: s.token, op: 'status' }))?.status || DOWN;
}
