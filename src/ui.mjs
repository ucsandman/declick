import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, manifestDir, loadManifest, listManifests, KEBAB } from './manifest.mjs';
import { guard } from './guard.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'declick.mjs');
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

export function adapterRows() {
  return listManifests().map(name => {
    try {
      const m = loadManifest(name);
      return { name, engine: m.engine, source: m.source, verbs: m.verbs.length,
        lastRun: readJson(join(manifestDir(name), 'last-run.json')),
        lastError: readJson(join(manifestDir(name), 'last-error.json')) };
    } catch (e) { return { name, error: e.message, engine: null, verbs: 0, lastRun: null, lastError: null }; }
  });
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8', timeout: 600000 });
  return { ok: r.status === 0, exit: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function rowHtml(r, authoring) {
  if (r.error) return `<tr data-name="${esc(r.name)}"><td><b>${esc(r.name)}</b><div class="err">${esc(r.error)}</div></td><td></td><td></td><td></td>
<td><button data-action="build" disabled>build</button> <button data-action="repair" disabled>repair</button> <button data-action="remove" class="danger">remove</button></td></tr>`;
  const run = r.lastRun ? `${esc(r.lastRun.verb)} ${r.lastRun.ok ? 'ok' : 'exit ' + r.lastRun.exit} <span class="dim">${esc(r.lastRun.at.slice(0, 16).replace('T', ' '))}</span>` : '<span class="dim">never run</span>';
  const err = r.lastError ? `<div class="err">${esc(r.lastError.verb)}: ${esc(r.lastError.error)}</div>` : '';
  const repair = !authoring ? ' disabled title="start with: declick ui --allow-authoring"' : r.lastError ? '' : ' disabled title="no recorded failure"';
  // Only a desktop adapter has a window to walk; the tree lands in the pre below instead of reloading the page.
  const tree = r.engine === 'desktop' ? '' : ' disabled title="desktop adapters only"';
  return `<tr data-name="${esc(r.name)}"><td><b>${esc(r.name)}</b><div class="dim">${esc(r.source)}</div>${err}</td><td>${esc(r.engine)}</td><td>${r.verbs}</td><td>${run}</td>
<td><button data-action="tree"${tree}>tree</button> <button data-action="build">build</button> <button data-action="repair"${repair}>repair</button> <button data-action="remove" class="danger">remove</button></td></tr>`;
}

function page(rows, { token, authoring }) {
  const tr = rows.map(r => rowHtml(r, authoring)).join('\n');
  const empty = rows.length ? '' : `<p class="dim">No adapters yet. Add one with the form below.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>declick</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.45 system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1a1a1a}h1{font-size:1.4rem;margin:0 0 .25rem}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid #e5e5e5;vertical-align:top}th{font-weight:600;color:#555}.dim{color:#777;font-size:.85em}.err{color:#a40000;font-size:.85em;margin-top:.25rem}button{font:inherit;padding:.3rem .7rem;border:1px solid #bbb;background:#fff;border-radius:6px;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.danger{border-color:#d33;color:#a40000}input{font:inherit;padding:.3rem .5rem;border:1px solid #bbb;border-radius:6px}form{margin-top:1rem}pre{background:#f5f5f5;padding:.75rem;border-radius:6px;white-space:pre-wrap;font-size:.85em}code{background:#f5f5f5;padding:0 .25rem;border-radius:3px}</style></head>
<body><h1>declick</h1><div class="dim">${esc(HOME)}</div>${empty}
<form id="add"><input name="source" placeholder="source: spec.json | https://... | app:window | mcp:server" size="40" required> <input name="name" placeholder="name (optional)"> <input name="engine" placeholder="engine (optional)" size="10"> <input name="goal" placeholder="goal (optional)"> <button>add</button></form>
<p class="dim">Every button here is a command: <code>declick commands</code> lists them all, <code>declick &lt;command&gt; --help</code> explains one. <a href="https://declick.dev" target="_blank" rel="noreferrer">docs</a></p>
<table><thead><tr><th>adapter</th><th>engine</th><th>verbs</th><th>last run</th><th></th></tr></thead><tbody>${tr}</tbody></table>
<pre id="out" hidden></pre>
<script>
const TOKEN = ${JSON.stringify(token)};
const show = r => { const out = document.getElementById('out'); out.hidden = false; out.textContent = (r.ok ? 'ok' : 'exit ' + r.exit) + '\\n' + (r.stdout || '') + (r.stderr || '') + (r.error || ''); return r.ok; };
document.addEventListener('click', async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  const name = b.closest('tr').dataset.name, action = b.dataset.action;
  if (action === 'remove' && !confirm('Remove ' + name + '?')) return;
  b.disabled = true; b.textContent = action + '...';
  const r = await fetch('/api/' + encodeURIComponent(name) + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-declick-token': TOKEN }, body: '{}' }).then(r => r.json());
  if (show(r) && action !== 'tree') return location.reload();
  b.disabled = false; b.textContent = action;
});
document.getElementById('add').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), body = { source: f.get('source') };
  if (f.get('name')) body.name = f.get('name');
  if (f.get('engine')) body.engine = f.get('engine');
  if (f.get('goal')) body.goal = f.get('goal');
  const r = await fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json', 'x-declick-token': TOKEN }, body: JSON.stringify(body) }).then(r => r.json());
  if (show(r)) location.reload();
});
</script></body></html>`;
}

// The page carries a per-start token and every POST has to echo it, so only the page declick printed
// can drive this server; authoring stays off unless it was asked for.
export function startUi({ port = 4870, host = '127.0.0.1', allowAuthoring = false } = {}) {
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8' }); res.end(body); };
    (async () => {
      const hostHeader = req.headers.host || '';
      if (!HOST_RE.test(hostHeader)) return send(403, JSON.stringify({ ok: false, error: 'bad host' }));
      let body = {};
      if (req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        if (req.headers.origin !== `http://${hostHeader}` || !ct.startsWith('application/json'))
          return send(403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
        if (req.headers['x-declick-token'] !== token) return send(401, JSON.stringify({ ok: false, error: 'missing or wrong X-Declick-Token; reload the page declick ui printed' }));
        const raw = await new Promise((resolve, reject) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); req.on('error', reject); });
        body = raw ? JSON.parse(raw) : {};
      }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return send(200, page(adapterRows(), { token, authoring: allowAuthoring }), 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/adapters') {
        const data = adapterRows();
        return send(200, JSON.stringify({ ok: true, data, meta: { count: data.length, truncated: false } }));
      }
      if (req.method === 'POST' && url.pathname === '/api/add') {
        if (typeof body.source !== 'string' || !body.source) return send(400, JSON.stringify({ ok: false, error: 'source required' }));
        if (body.name !== undefined && !KEBAB.test(body.name)) return send(400, JSON.stringify({ ok: false, error: 'name must be kebab-case' }));
        if (body.engine !== undefined && !KEBAB.test(body.engine)) return send(400, JSON.stringify({ ok: false, error: 'engine must be an engine name; see declick engines' }));
        if (body.goal && !allowAuthoring) return send(403, JSON.stringify({ ok: false, error: 'authoring is off; restart with: declick ui --allow-authoring' }));
        const g = await guard({ tool: 'declick-ui', action: 'add', engine: 'declick', target: String(body.source), args: { source: String(body.source), name: body.name } });
        if (!g.allowed) return send(403, JSON.stringify({ ok: false, error: `blocked by governance: ${g.reason}`, decision: g.decision }));
        const args = ['add', body.source];
        for (const [flag, key] of [['--name', 'name'], ['--engine', 'engine'], ['--goal', 'goal'], ['--verb', 'verb'], ['--recipes', 'recipes']]) if (body[key]) args.push(flag, body[key]);
        return send(200, JSON.stringify(runCli(args)));
      }
      const m = req.method === 'POST' && /^\/api\/([a-z0-9-]+)\/(tree|build|repair|remove)$/.exec(url.pathname);
      if (m) {
        const [, name, action] = m;
        if (!listManifests().includes(name)) return send(404, JSON.stringify({ ok: false, error: `no adapter named ${name}` }));
        // Walking a window reads it and changes nothing, so it never goes through governance.
        if (action === 'tree') {
          let adapter; try { adapter = loadManifest(name); } catch (e) { return send(400, JSON.stringify({ ok: false, error: e.message })); }
          if (adapter.engine !== 'desktop') return send(400, JSON.stringify({ ok: false, error: `${name} is a ${adapter.engine} adapter; tree walks a desktop window` }));
          return send(200, JSON.stringify(runCli(['desk', 'tree', adapter.window, '--json', 'false', '--limit', '200'])));
        }
        if (action === 'repair' && !allowAuthoring) return send(403, JSON.stringify({ ok: false, error: 'authoring is off; restart with: declick ui --allow-authoring' }));
        const g = await guard({ tool: 'declick-ui', action, engine: 'declick', target: name, args: { adapter: name } });
        if (!g.allowed) return send(403, JSON.stringify({ ok: false, error: `blocked by governance: ${g.reason}`, decision: g.decision }));
        if (action === 'repair') {
          const le = readJson(join(manifestDir(name), 'last-error.json'));
          if (!le?.verb) return send(400, JSON.stringify({ ok: false, error: 'no recorded failure to repair' }));
          return send(200, JSON.stringify(runCli(['repair', name, le.verb])));
        }
        return send(200, JSON.stringify(runCli([action, name])));
      }
      send(404, JSON.stringify({ ok: false, error: 'not found' }));
    })().catch(e => send(500, JSON.stringify({ ok: false, error: e.message })));
  });
  server.token = token;
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
