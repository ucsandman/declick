import { oneLine } from '../describe.mjs';
import { AUTH_HEADERS, authRegistry, chooseOrigin, fail, flagOf, headerScheme, jsonType, loadDoc, returnsOfJson, safeName, sourceOf } from './postman.mjs';

// A capture compiles to the verb shape the openapi engine executes, so the request path, auth,
// retries and dry-run are shared. The recorded-request helpers come from the collection engine.
export { execute } from './openapi.mjs';

export const detect = doc => Array.isArray(doc?.log?.entries);

const ASSET = /\.(js|mjs|cjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|avif|mp4|pdf)$/i;
const BODYISH = /json|html/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idish = s => /^\d+$/.test(s) || UUID.test(s);
const jsonOf = text => { try { return JSON.parse(text); } catch { return undefined; } };

// An adapter is named for the site, not for its full hostname; an IP keeps every label.
const hostName = h => {
  if (/^[\d.]+$/.test(h) || h.includes(':')) return safeName(h, 'har');
  const labels = h.split('.').filter(l => !['www', 'api'].includes(l));
  return safeName(labels.length > 1 ? labels[0] : h, 'har');
};

// Every numeric or uuid segment is one recorded row, not a route: it becomes an arg.
function generalize(path) {
  const args = [];
  const out = path.split('/').map(seg => {
    if (!idish(seg)) return seg;
    const n = args.length ? `id${args.length + 1}` : 'id';
    args.push({ name: n, required: true, type: 'string' });
    return `{${n}}`;
  }).join('/');
  return { path: out || '/', args };
}

export async function compile(source, { name, verbs: only, tag, host } = {}) {
  const doc = await loadDoc(source);
  if (!detect(doc)) throw fail(`${sourceOf(source)} is not a HAR capture (no log.entries)`);
  if (tag) throw fail('--tag needs a spec or a collection with folders; a capture has none, use --verbs a,b');
  const rows = [];
  for (const e of doc.log.entries || []) {
    let u; try { u = new URL(e.request?.url); } catch { continue; }
    const mime = e.response?.content?.mimeType || '';
    if (ASSET.test(u.pathname) || (mime && !BODYISH.test(mime))) continue;
    rows.push({ e, u });
  }
  const origin = chooseOrigin(rows.map(r => r.u.origin), host);
  const apiName = name || hostName(new URL(origin).hostname);
  const auth = authRegistry(apiName);
  const groups = new Map();
  for (const { e, u } of rows) {
    if (u.origin !== origin) continue;
    const method = String(e.request.method || 'GET').toLowerCase();
    const { path, args } = generalize(u.pathname);
    const key = `${method} ${path}`;
    let g = groups.get(key);
    if (!g) { g = { method, path, args, query: new Map(), body: null, bodyType: null, keys: [], returns: null, status: null, at: null, samples: 0 }; groups.set(key, g); }
    g.samples++;
    for (const q of e.request.queryString || []) if (!g.query.has(q.name)) g.query.set(q.name, q.value ?? '');
    for (const [k, v] of u.searchParams) if (!g.query.has(k)) g.query.set(k, v);
    const post = e.request.postData;
    if (post && /urlencoded/i.test(post.mimeType || '')) { g.bodyType = 'application/x-www-form-urlencoded'; g.body = { ...g.body, ...Object.fromEntries((post.params || []).map(p => [p.name, p.value ?? ''])) }; }
    else if (post?.text) { const j = jsonOf(post.text); if (j && typeof j === 'object' && !Array.isArray(j)) { g.bodyType = 'application/json'; g.body = { ...g.body, ...j }; } }
    for (const h of e.request.headers || []) {
      if (!AUTH_HEADERS.has(String(h.name).toLowerCase())) continue;
      const k = auth.add(headerScheme(h.name, h.value));
      if (k && !g.keys.includes(k)) g.keys.push(k);
    }
    if (g.at === null) { g.status = e.response?.status ?? null; g.at = e.startedDateTime || null; }
    if (!g.returns) { const j = jsonOf(e.response?.content?.text || ''); if (j !== undefined) g.returns = returnsOfJson(j); }
  }
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const taken = new Set(); const available = []; const verbs = [];
  for (const g of groups.values()) {
    let vname = safeName(`${g.method} ${g.path.replace(/\{(\w+)\}/g, 'by-$1')}`, 'verb');
    if (vname === 'describe') vname = 'describe-op';
    for (let n = 2; taken.has(vname); n++) vname = `${vname.replace(/-\d+$/, '')}-${n}`;
    taken.add(vname); available.push(vname);
    if (wanted?.length && !wanted.includes(vname)) continue;
    const query = [...g.query].map(([k, v]) => flagOf(k, '', v));
    const props = Object.entries(g.body || {}).map(([k, v]) => flagOf(k, '', v, jsonType(v)));
    verbs.push({
      name: vname, description: oneLine(`${g.method.toUpperCase()} ${g.path}`, 80),
      mutating: !['get', 'head'].includes(g.method), args: g.args,
      flags: [...query, ...(g.bodyType ? [{ name: 'body', description: `raw ${g.bodyType} body`, required: false, type: 'string' }] : []), ...props],
      returns: g.returns || { shape: 'none', fields: [] },
      har: { sampleStatus: g.status, sampleAt: g.at, samples: g.samples },
      http: {
        method: g.method, path: g.path, query: query.map(f => f.name), bodyProps: props.map(f => f.name),
        security: g.keys.length ? [g.keys] : [], ...(g.bodyType ? { bodyType: g.bodyType } : {}),
      },
    });
  }
  if (!verbs.length) throw fail(wanted?.length ? `no verb matches ${wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}` : `no API calls in ${sourceOf(source)}; a capture needs at least one json or html response`);
  return {
    name: apiName, engine: 'har', source: sourceOf(source), builtAt: new Date().toISOString(),
    baseUrl: origin, auth: auth.manifest(), verbs,
  };
}
