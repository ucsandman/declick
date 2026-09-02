import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, manifestDir, loadManifest, listManifests } from './manifest.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'declick.mjs');
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };

export function adapterRows() {
  return listManifests().map(name => {
    const m = loadManifest(name);
    return { name, engine: m.engine, source: m.source, verbs: m.verbs.length,
      lastRun: readJson(join(manifestDir(name), 'last-run.json')),
      lastError: readJson(join(manifestDir(name), 'last-error.json')) };
  });
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8', timeout: 600000 });
  return { ok: r.status === 0, exit: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(rows) {
  const tr = rows.map(r => {
    const run = r.lastRun ? `${esc(r.lastRun.verb)} ${r.lastRun.ok ? 'ok' : 'exit ' + r.lastRun.exit} <span class="dim">${esc(r.lastRun.at.slice(0, 16).replace('T', ' '))}</span>` : '<span class="dim">never run</span>';
    const err = r.lastError ? `<div class="err">${esc(r.lastError.verb)}: ${esc(r.lastError.error)}</div>` : '';
    const repair = r.lastError ? '' : ' disabled title="no recorded failure"';
    return `<tr data-name="${esc(r.name)}"><td><b>${esc(r.name)}</b><div class="dim">${esc(r.source)}</div>${err}</td><td>${esc(r.engine)}</td><td>${r.verbs}</td><td>${run}</td>
<td><button data-action="build">build</button> <button data-action="repair"${repair}>repair</button> <button data-action="remove" class="danger">remove</button></td></tr>`;
  }).join('\n');
  const empty = rows.length ? '' : `<p class="dim">No adapters yet. Run <code>declick add &lt;source&gt;</code> and refresh.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>declick</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.45 system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1a1a1a}h1{font-size:1.4rem;margin:0 0 .25rem}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid #e5e5e5;vertical-align:top}th{font-weight:600;color:#555}.dim{color:#777;font-size:.85em}.err{color:#a40000;font-size:.85em;margin-top:.25rem}button{font:inherit;padding:.3rem .7rem;border:1px solid #bbb;background:#fff;border-radius:6px;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.danger{border-color:#d33;color:#a40000}pre{background:#f5f5f5;padding:.75rem;border-radius:6px;white-space:pre-wrap;font-size:.85em}code{background:#f5f5f5;padding:0 .25rem;border-radius:3px}</style></head>
<body><h1>declick</h1><div class="dim">${esc(HOME)}</div>${empty}
<table><thead><tr><th>adapter</th><th>engine</th><th>verbs</th><th>last run</th><th></th></tr></thead><tbody>${tr}</tbody></table>
<pre id="out" hidden></pre>
<script>
document.addEventListener('click', async e => {
  const b = e.target.closest('button[data-action]'); if (!b) return;
  const name = b.closest('tr').dataset.name, action = b.dataset.action;
  if (action === 'remove' && !confirm('Remove ' + name + '?')) return;
  b.disabled = true; b.textContent = action + '...';
  const r = await fetch('/api/' + encodeURIComponent(name) + '/' + action, { method: 'POST' }).then(r => r.json());
  const out = document.getElementById('out'); out.hidden = false;
  out.textContent = (r.ok ? 'ok' : 'exit ' + r.exit) + '\\n' + (r.stdout || '') + (r.stderr || '') + (r.error || '');
  if (r.ok) location.reload(); else { b.disabled = false; b.textContent = action; }
});
</script></body></html>`;
}

export function startUi({ port = 4870, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8' }); res.end(body); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') return send(200, page(adapterRows()), 'text/html');
    if (req.method === 'GET' && url.pathname === '/api/adapters') return send(200, JSON.stringify(adapterRows()));
    const m = req.method === 'POST' && /^\/api\/([a-z0-9-]+)\/(build|repair|remove)$/.exec(url.pathname);
    if (m) {
      const [, name, action] = m;
      if (!listManifests().includes(name)) return send(404, JSON.stringify({ ok: false, error: `no adapter named ${name}` }));
      if (action === 'repair') {
        const le = readJson(join(manifestDir(name), 'last-error.json'));
        if (!le?.verb) return send(400, JSON.stringify({ ok: false, error: 'no recorded failure to repair' }));
        return send(200, JSON.stringify(runCli(['repair', name, le.verb])));
      }
      return send(200, JSON.stringify(runCli([action, name])));
    }
    send(404, JSON.stringify({ ok: false, error: 'not found' }));
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
