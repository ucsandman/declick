import { spawn } from 'node:child_process';
import { EXIT } from './output.mjs';

export const PROTOCOL = '2025-03-26';
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const ms = t => Number(process.env.DECLICK_TIMEOUT_MS) || t || 30000;
const rpcError = (e, where) => fail(`${where}: ${e.message || 'server error'}${e.code ? ` (${e.code})` : ''}`);
// cmd.exe splits on & | > < ^ outside quotes, so an argument handed to a shell is always quoted, never bare.
const cmdQuote = a => `"${String(a).replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;

// MCP stdio is one JSON object per line; some servers still use the LSP-style Content-Length framing, so accept both.
export function drain(buf, onMessage) {
  for (;;) {
    const cl = /^Content-Length:[ \t]*(\d+)/i.exec(buf.subarray(0, 64).toString('latin1'));
    if (cl) {
      const head = buf.indexOf('\r\n\r\n');
      const len = Number(cl[1]);
      if (head < 0 || buf.length < head + 4 + len) return buf;
      const body = buf.subarray(head + 4, head + 4 + len).toString('utf8');
      buf = buf.subarray(head + 4 + len);
      try { onMessage(JSON.parse(body)); } catch { /* a server that writes noise must not kill the session */ }
      continue;
    }
    const nl = buf.indexOf(10);
    if (nl < 0) return buf;
    const line = buf.subarray(0, nl).toString('utf8').trim();
    buf = buf.subarray(nl + 1);
    if (line) try { onMessage(JSON.parse(line)); } catch { /* same */ }
  }
}

// An SSE body is a sequence of frames; only the data lines carry the JSON-RPC message.
export function sseMessages(text) {
  return text.split(/\r?\n\r?\n/)
    .map(f => f.split(/\r?\n/).filter(l => /^data:/.test(l)).map(l => l.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map(d => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

function stdioClient({ command, args = [], timeout }) {
  const pending = new Map();
  let child = null, seq = 0, dead = null, stderr = '';
  const label = [command, ...args].join(' ');

  const onMessage = msg => {
    const p = msg?.id === undefined || msg?.id === null ? null : pending.get(msg.id);
    if (!p) return;
    if (msg.error) p.reject(rpcError(msg.error, label));
    else p.resolve(msg.result);
  };

  const rpc = (method, params, notify = false) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq;
    let timer;
    if (!notify) {
      timer = setTimeout(() => { pending.delete(id); reject(fail(`${command} did not answer ${method} within ${ms(timeout)}ms`)); }, ms(timeout));
      timer.unref?.();
      const settle = fn => v => { clearTimeout(timer); pending.delete(id); fn(v); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    }
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
    child.stdin.write(`${body}\n`, err => {
      if (!err) { if (notify) resolve(null); return; }
      const e = fail(`${command} stdin: ${err.message}`);
      if (notify) reject(e); else pending.get(id)?.reject(e);
    });
  });

  return {
    async connect() {
      if (child) return;
      // Windows resolves npx/npm/pnpm through .cmd shims, which node refuses to spawn directly since 20.19.
      const shell = process.platform === 'win32' && /^(npx|npm|pnpm|yarn|bunx)$/i.test(command);
      // Same rule as the cli engine: under a shell every argument is quoted, or a & or > in one starts a second command.
      child = spawn(command, shell ? args.map(cmdQuote) : args, { stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true });
      child.stdin.on('error', () => {}); // a server that exits mid-write surfaces as the exit below, not as EPIPE
      let buf = Buffer.alloc(0);
      child.stdout.on('data', d => { buf = drain(Buffer.concat([buf, d]), onMessage); });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-400); });
      const started = new Promise((ok, no) => {
        child.once('spawn', ok);
        child.once('error', e => { dead = fail(`cannot start ${command}: ${e.message}`); no(dead); });
      });
      child.on('exit', code => {
        dead = fail(`${label} exited ${code}${stderr.trim() ? `: ${stderr.trim().replace(/\s+/g, ' ')}` : ''}`);
        for (const p of pending.values()) p.reject(dead);
        pending.clear();
      });
      await started;
      await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'declick', version: '0' } });
      await rpc('notifications/initialized', {}, true);
    },
    async listTools() { return listAll(cursor => rpc('tools/list', cursor ? { cursor } : {})); },
    async callTool(name, args) { return rpc('tools/call', { name, arguments: args || {} }); },
    close() { if (!child) return; try { child.stdin.end(); child.kill(); } catch { /* already gone */ } child = null; },
  };
}

function httpClient({ url, bearer, timeout }) {
  let seq = 0, session = null;

  const post = async (method, params, notify = false) => {
    const id = ++seq;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (session) headers['mcp-session-id'] = session;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(ms(timeout)) }); }
    catch (e) { throw fail(`POST ${url} ${e.name === 'TimeoutError' ? 'timed out' : 'failed'} (${e.cause?.message || e.message})`); }
    const sid = r.headers.get('mcp-session-id');
    if (sid) session = sid;
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw fail(`${url} -> ${r.status}; the server wants a bearer token`, EXIT.AUTH);
    if (!r.ok) throw fail(`${url} -> ${r.status}${text ? `: ${text.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`);
    if (notify || !text.trim()) return null;
    let msgs;
    if (/text\/event-stream/.test(r.headers.get('content-type') || '')) msgs = sseMessages(text);
    else { try { msgs = [].concat(JSON.parse(text)); } catch { throw fail(`${url} answered ${method} with non-JSON: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); } }
    const res = msgs.find(x => x.id === id) ?? msgs.at(-1);
    if (!res) throw fail(`${url} answered ${method} with no JSON-RPC message`);
    if (res.error) throw rpcError(res.error, url);
    return res.result;
  };

  return {
    async connect() {
      await post('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'declick', version: '0' } });
      await post('notifications/initialized', {}, true);
    },
    async listTools() { return listAll(cursor => post('tools/list', cursor ? { cursor } : {})); },
    async callTool(name, args) { return post('tools/call', { name, arguments: args || {} }); },
    close() {},
  };
}

// tools/list is paged; a server that never stops paging is capped rather than trusted.
async function listAll(page) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await page(cursor);
    out.push(...(r?.tools || []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export function mcpClient({ transport, command, args, url, bearer, timeout } = {}) {
  return transport === 'http' ? httpClient({ url, bearer, timeout }) : stdioClient({ command, args, timeout });
}
