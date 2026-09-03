#!/usr/bin/env node
// Measure the context an agent pays to learn an MCP server versus what declick costs it for the same server:
// for every stdio mcp adapter in ~/.declick, spawn the real server once and count the bytes of its initialize
// result plus its full tools/list response (what a plain MCP client would put in a model's context), then
// compare that to the bytes of `declick describe <name>` and `declick describe <name> --verb <first verb>`.
// With --call, also compares one real tools/call to `declick run <name> <verb> --limit N`. Node built-ins only.
//
// Usage: node scripts/bench-tokens.mjs [--adapter n,n2] [--limit N] [--json] [--call]
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { drain, PROTOCOL } from '../src/mcp-client.mjs';
import { listManifests, loadManifest } from '../src/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECLICK_BIN = join(ROOT, 'bin', 'declick.mjs');
const TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const out = { adapter: null, limit: 5, json: false, call: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') out.adapter = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--adapter=')) out.adapter = a.slice(10).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8));
    else if (a === '--json') out.json = true;
    else if (a === '--call') out.call = true;
    else { console.error(`unknown flag ${a}; usage: node scripts/bench-tokens.mjs [--adapter n,n2] [--limit N] [--json] [--call]`); process.exit(1); }
  }
  if (!Number.isInteger(out.limit) || out.limit < 1) { console.error('--limit must be a positive integer'); process.exit(1); }
  return out;
}
const opts = parseArgs(process.argv.slice(2));

const bytesOf = s => Buffer.byteLength(String(s ?? ''), 'utf8');
// Tokens are never counted directly here; bytes/4 is the well-known rough approximation and nothing more.
const tokensOf = b => Math.round(b / 4);
const fmt = b => `${b} (~${tokensOf(b)}t)`;

// An error string must never carry this machine's paths or account name into docs/bench.md.
const PATH_RE = /[A-Za-z]:[\\/][^\s"'`)]+/g;
const USERNAME = userInfo().username;
function shortError(e) {
  const msg = String(e?.message || e);
  if (/did not answer|no answer within/i.test(msg)) return `no answer within ${TIMEOUT_MS / 1000}s`;
  const exited = msg.match(/exited (-?\d+|null)/);
  if (exited) return `exited ${exited[1]} before completing the handshake`;
  if (/^cannot start /i.test(msg)) { const code = msg.match(/\b([A-Z]{3,6})\b/); return `failed to start${code ? ` (${code[1]})` : ''}`; }
  return msg.replace(PATH_RE, '<path>').replace(new RegExp(USERNAME, 'gi'), '<user>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Duplicates the win32 spawn shim in src/mcp-client.mjs on purpose: that module never exposes the parsed
// `result` of initialize, nor the individual tools/list pages, and this script needs both, in bytes.
const cmdQuote = a => `"${String(a).replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;

function rawClient(command, args) {
  let child = null, buf = Buffer.alloc(0), seq = 0, dead = null, stderr = '';
  const pending = new Map();
  const label = [command, ...args].join(' ');
  const onMessage = msg => {
    const p = msg?.id == null ? null : pending.get(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error.message || 'server error'));
    else p.resolve(msg.result);
  };
  function rpc(method, params, notify = false) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = ++seq;
      if (!notify) pending.set(id, { resolve, reject });
      const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
      child.stdin.write(`${body}\n`, err => {
        if (err) { if (!notify) pending.delete(id); reject(err); return; }
        if (notify) resolve(null);
      });
    });
  }
  return {
    async connect() {
      const shell = process.platform === 'win32' && /^(npx|npm|pnpm|yarn|bunx)$/i.test(command);
      child = shell
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[command, ...args.map(cmdQuote)].join(' ')}"`], { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true })
        : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', d => { buf = drain(Buffer.concat([buf, d]), onMessage); });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-400); });
      const started = new Promise((ok, no) => {
        child.once('spawn', ok);
        child.once('error', e => { dead = new Error(`cannot start ${command}: ${e.message}`); no(dead); });
      });
      child.on('exit', code => {
        dead = new Error(`${label} exited ${code}${stderr.trim() ? `: ${stderr.trim().replace(/\s+/g, ' ')}` : ''}`);
        for (const p of pending.values()) p.reject(dead);
        pending.clear();
      });
      await started;
    },
    rpc,
    close() { if (!child) return; try { child.stdin.end(); child.kill(); } catch { /* already gone */ } child = null; },
  };
}

// One deadline for the whole handshake, not per JSON-RPC call: a cold `npx -y` download is what actually
// blows a budget, and it blows it once, not once per message.
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function measureRaw(command, args) {
  const client = rawClient(command, args);
  try {
    const { init, pages } = await withDeadline((async () => {
      await client.connect();
      const init = await client.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'bench-tokens', version: '0' } });
      await client.rpc('notifications/initialized', {}, true);
      const pages = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const page = await client.rpc('tools/list', cursor ? { cursor } : {});
        pages.push(page);
        cursor = page?.nextCursor;
        if (!cursor) break;
      }
      return { init, pages };
    })(), TIMEOUT_MS);
    const initBytes = bytesOf(JSON.stringify(init ?? null));
    const listBytes = pages.reduce((s, p) => s + bytesOf(JSON.stringify(p ?? null)), 0);
    const toolCount = pages.reduce((s, p) => s + (p?.tools?.length || 0), 0);
    return { ok: true, client, initBytes, listBytes, bytes: initBytes + listBytes, toolCount };
  } catch (e) {
    client.close();
    return { ok: false, error: e };
  }
}

async function measureRawCall(client, toolName) {
  try {
    const res = await withDeadline(client.rpc('tools/call', { name: toolName, arguments: {} }), TIMEOUT_MS);
    return { ok: true, bytes: bytesOf(JSON.stringify(res ?? null)) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function runDeclick(args) {
  const r = spawnSync(process.execPath, [DECLICK_BIN, ...args], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = r.stdout ?? '';
  if (!out && r.stderr) throw new Error(r.stderr.trim().slice(0, 200));
  return out;
}

// A verb this script can call with zero setup: not documented as mutating, and no flag it must supply a value for.
const zeroArgReadOnly = v => !v.mutating && (v.flags || []).every(f => !f.required);

async function benchAdapter(name, m) {
  const cfg = m.mcp || {};
  const raw = await measureRaw(cfg.command, cfg.args || []);
  if (!raw.ok) return { name, error: shortError(raw.error) };

  let call = null;
  if (opts.call) {
    const candidate = m.verbs.find(zeroArgReadOnly);
    if (!candidate) call = { note: 'no read-only verb with zero required args' };
    else {
      const rawCall = await measureRawCall(raw.client, candidate.mcp.tool);
      call = !rawCall.ok ? { verb: candidate.name, error: shortError(rawCall.error) } : { verb: candidate.name, rawBytes: rawCall.bytes };
      if (call.rawBytes !== undefined) {
        const declickOut = runDeclick(['run', name, candidate.name, '--limit', String(opts.limit)]);
        call.declickBytes = bytesOf(declickOut);
        call.ratio = call.declickBytes ? call.rawBytes / call.declickBytes : null;
      }
    }
  }
  raw.client.close();

  const describeOut = runDeclick(['describe', name]);
  const firstVerb = m.verbs[0]?.name;
  const describeVerbOut = firstVerb ? runDeclick(['describe', name, '--verb', firstVerb]) : '';
  const describeBytes = bytesOf(describeOut);

  return {
    name, toolCount: raw.toolCount, rawInitBytes: raw.initBytes, rawListBytes: raw.listBytes, rawBytes: raw.bytes,
    describeBytes, describeVerbBytes: bytesOf(describeVerbOut),
    ratio: describeBytes ? raw.bytes / describeBytes : null,
    ...(call ? { call } : {}),
  };
}

function printTable(rows) {
  const headers = ['adapter', 'tools', 'raw (init+list)', 'describe', 'describe --verb', 'ratio raw/describe'];
  if (opts.call) headers.push('call raw', 'call declick', 'call ratio');
  const ok = rows.filter(r => !r.skipped && !r.error);
  const dataRows = ok.map(r => {
    const row = [r.name, String(r.toolCount), fmt(r.rawBytes), fmt(r.describeBytes), fmt(r.describeVerbBytes), r.ratio == null ? 'n/a' : `${r.ratio.toFixed(1)}x`];
    if (opts.call) {
      if (r.call?.rawBytes !== undefined) row.push(fmt(r.call.rawBytes), fmt(r.call.declickBytes), r.call.ratio == null ? 'n/a' : `${r.call.ratio.toFixed(1)}x`);
      else row.push(r.call?.error ? `error: ${r.call.error}` : (r.call?.note || 'n/a'), '', '');
    }
    return row;
  });
  const sum = k => ok.reduce((s, r) => s + r[k], 0);
  const totalRaw = sum('rawBytes'), totalDescribe = sum('describeBytes'), totalVerb = sum('describeVerbBytes');
  const totals = ['TOTAL', String(sum('toolCount')), fmt(totalRaw), fmt(totalDescribe), fmt(totalVerb), totalDescribe ? `${(totalRaw / totalDescribe).toFixed(1)}x` : 'n/a'];
  if (opts.call) {
    const callRows = ok.filter(r => r.call?.rawBytes !== undefined);
    const cRaw = callRows.reduce((s, r) => s + r.call.rawBytes, 0), cDec = callRows.reduce((s, r) => s + r.call.declickBytes, 0);
    totals.push(callRows.length ? fmt(cRaw) : 'n/a', callRows.length ? fmt(cDec) : 'n/a', cDec ? `${(cRaw / cDec).toFixed(1)}x` : 'n/a');
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...dataRows.map(r => r[i].length), totals[i].length));
  const line = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of dataRows) console.log(line(r));
  console.log(line(totals));
  for (const r of rows) if (r.skipped) console.log(`${r.name}\tskipped: ${r.skipped}`);
  for (const r of rows) if (r.error) console.log(`${r.name}\terror: ${r.error}`);
}

async function main() {
  const allNames = listManifests();
  const requested = opts.adapter || allNames;
  const unknown = requested.filter(n => !allNames.includes(n));
  if (unknown.length) console.error(`no such adapter(s), skipping: ${unknown.join(', ')}`);

  const manifests = requested.filter(n => allNames.includes(n)).map(n => ({ name: n, m: loadManifest(n) }));
  const nonMcp = manifests.filter(x => x.m.engine !== 'mcp');
  if (nonMcp.length) console.error(`out of scope (engine is not mcp): ${nonMcp.map(x => `${x.name} (${x.m.engine})`).join(', ')}`);
  const mcpOnes = manifests.filter(x => x.m.engine === 'mcp');

  const rows = [];
  for (const { name, m } of mcpOnes) {
    if (m.mcp?.transport === 'http') { rows.push({ name, skipped: 'mcp over http, not a stdio command' }); continue; }
    process.stderr.write(`benchmarking ${name}...\n`);
    try { rows.push(await benchAdapter(name, m)); }
    catch (e) { rows.push({ name, error: shortError(e) }); console.error(`${name}: ${e.message}`); }
  }

  const measured = rows.filter(r => !r.skipped && !r.error).length;
  const skipped = rows.filter(r => r.skipped).length;
  const failed = rows.filter(r => r.error).length;

  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(), timeoutMs: TIMEOUT_MS, limit: opts.limit, call: opts.call,
      method: 'tokens approximated as bytes/4; raw = a live server\'s initialize result + full tools/list response, in bytes; declick = declick describe/run stdout, in bytes',
      scanned: mcpOnes.length, measured, skipped, failed, rows,
    }, null, 2));
  } else {
    printTable(rows);
    console.log(`\nscanned=${mcpOnes.length} measured=${measured} skipped=${skipped} failed=${failed}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
