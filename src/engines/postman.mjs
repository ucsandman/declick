import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, RESERVED } from '../output.mjs';
import { oneLine } from '../describe.mjs';

// A collection compiles to the verb shape the openapi engine executes, so the request path, auth,
// retries and dry-run are shared instead of written twice. The har engine reuses the helpers below.
export { execute } from './openapi.mjs';

export const kebab = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
export const upperSnake = s => String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
export const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
export const warn = s => process.stderr.write(`${s}\n`);
const isUrl = s => /^https?:\/\//.test(s);

export async function loadDoc(source) {
  if (!isUrl(source)) return JSON.parse(readFileSync(source, 'utf8'));
  const r = await fetch(source);
  if (!r.ok) throw fail(`fetch ${source}: ${r.status}`);
  return r.json();
}

export const sourceOf = source => (isUrl(source) ? source : resolve(source));
// Whatever the collection or the host was called, an adapter name is kebab-case and starts with a letter.
export const safeName = (raw, prefix) => { const n = kebab(raw) || prefix; return /^[a-z]/.test(n) ? n : `${prefix}-${n}`; };

// A captured value that looks like a credential never becomes a manifest example or a baked-in default.
export const secretish = v => /^[A-Za-z0-9_-]{20,}$/.test(v) || /\b(sk|pk|ghp|xox[abp])[-_]/.test(v) || /^(bearer|basic)\s/i.test(v);
// Recorded values are examples, never defaults: a verb sends only the flags the caller passes.
export const exampleOf = v => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s && !s.includes('{{') && !secretish(s) ? { example: oneLine(s, 100) } : {};
};
export const jsonType = v => (Array.isArray(v) ? 'array' : v === null ? 'string' : typeof v === 'object' ? 'object' : typeof v);

// A flag whose recorded name is a contract flag is renamed; wire carries the name the API expects.
export const flagOf = (name, description, value, type = 'string') => {
  const clean = String(name).replace(/[^A-Za-z0-9_.-]/g, '');
  return {
    name: RESERVED.includes(clean) ? `param-${clean}` : clean,
    description: oneLine(description || '', 200), required: false, type,
    ...(RESERVED.includes(clean) ? { wire: clean } : {}), ...exampleOf(value),
  };
};

export const AUTH_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-auth-token', 'api-key']);

// A captured auth header keeps its shape and loses its value: the value comes from the environment at run time.
export function headerScheme(name, value) {
  const n = String(name).toLowerCase();
  if (n === 'authorization') return /^basic\s/i.test(String(value)) ? { key: 'basic', scheme: { type: 'http', scheme: 'basic' } } : { key: 'bearer', scheme: { type: 'http', scheme: 'bearer' } };
  if (n === 'cookie') { const k = /^\s*([^=;\s]+)=/.exec(String(value))?.[1]; return k ? { key: 'cookie', scheme: { type: 'apiKey', in: 'cookie', name: k } } : null; }
  return { key: 'apikey', scheme: { type: 'apiKey', in: 'header', name: String(name) } };
}

// One env key per distinct auth kind, in the order the verbs first needed it.
export function authRegistry(apiName) {
  const schemes = {}; const order = [];
  return {
    add(found) {
      if (!found) return null;
      if (!schemes[found.key]) { schemes[found.key] = { ...found.scheme, env: `${upperSnake(apiName)}_${upperSnake(found.key)}` }; order.push(found.key); }
      return found.key;
    },
    manifest: () => ({ env: order.map(k => schemes[k].env), schemes }),
  };
}

// The busiest host is the API; anything else in a collection or a capture is a third party.
export function chooseOrigin(origins, host) {
  const count = new Map();
  for (const o of origins) count.set(o, (count.get(o) || 0) + 1);
  const seen = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (!seen.length) throw fail('nothing to compile: no request with a url declick can call');
  if (!host) return seen[0][0];
  const hit = seen.find(([o]) => o === host || new URL(o).host === host || new URL(o).hostname === host);
  if (!hit) throw fail(`no request for host ${host}; hosts here: ${seen.map(([o]) => new URL(o).hostname).join(', ')}`);
  return hit[0];
}

// What a verb gives back, read off a recorded response body so an agent can pass --fields and --rows blind.
const propsOf = o => Object.entries(o).map(([n, v]) => ({ name: oneLine(n, 100), type: jsonType(v) }));
const cap = f => ({ fields: f.slice(0, 30), ...(f.length > 30 ? { truncated: true } : {}) });
const rowish = a => a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]);
export function returnsOfJson(body) {
  if (body === undefined || body === null) return { shape: 'none', fields: [] };
  if (Array.isArray(body)) return { shape: 'array', ...cap(rowish(body) ? propsOf(body[0]) : []) };
  if (typeof body !== 'object') return { shape: 'scalar', fields: [] };
  const lists = Object.entries(body).filter(([, v]) => Array.isArray(v) && rowish(v));
  if (lists.length === 1) return { shape: 'object', rowsPath: oneLine(lists[0][0], 100), ...cap(propsOf(lists[0][1][0])) };
  return { shape: 'object', ...cap(propsOf(body)) };
}

export const detect = doc => /getpostman/i.test(doc?.info?.schema || '') || (doc?._type === 'export' && Array.isArray(doc?.resources));

const VAR = /\{\{\s*(?:_\.)?([A-Za-z0-9_$.-]+?)\s*\}\}/g;
const PARAM = /\{\{\s*(?:_\.)?([A-Za-z0-9_$.-]+?)\s*\}\}|:([A-Za-z_][A-Za-z0-9_]*)/g;
const HOSTPATH = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^/?#]+)(\/[^?#]*)?$/;
const textOf = d => (typeof d === 'string' ? d : d?.content || '');
const subst = (s, vars) => String(s).replace(VAR, (m, k) => (k in vars ? vars[k] : m));
const argName = n => { const c = String(n).replace(/[^A-Za-z0-9_]/g, '') || 'id'; return RESERVED.includes(c) ? `path-${c}` : c; };
const kv = arr => (arr || []).filter(e => !e.disabled).map(e => [e.key ?? e.name, e.value ?? '']);

// Collection variables and Insomnia environments are defaults, so they are substituted at compile time.
// A value that looks like a credential is left as a placeholder instead, and becomes an arg or a flag.
function collectionVars(doc) {
  const out = {};
  const put = (k, v) => { if (k && typeof v === 'string' && v && !v.includes('{{') && !secretish(v)) out[k] = v; };
  for (const v of doc.variable || []) if (!v.disabled) put(v.key, v.value);
  for (const r of doc.resources || []) if (r._type === 'environment') for (const [k, v] of Object.entries(r.data || {})) put(k, v);
  return out;
}

export function schemeOf(a) {
  const t = String(a?.type || '').toLowerCase();
  if (!t || a.disabled || t === 'noauth' || t === 'none' || t === 'inherit') return null;
  if (t === 'bearer' || t === 'oauth2' || t === 'oauth1') return { key: 'bearer', scheme: { type: 'http', scheme: 'bearer' } };
  if (t === 'basic') return { key: 'basic', scheme: { type: 'http', scheme: 'basic' } };
  if (t === 'apikey') {
    const parts = Array.isArray(a.apikey) ? Object.fromEntries(kv(a.apikey)) : { key: a.key, in: a.addTo };
    return { key: 'apikey', scheme: { type: 'apiKey', in: /query/i.test(String(parts.in || '')) ? 'query' : 'header', name: String(parts.key || 'X-Api-Key') } };
  }
  warn(`skipping unsupported auth type ${t}`);
  return null;
}

function rawUrl(url) {
  if (typeof url === 'string') return url;
  if (url?.raw) return url.raw;
  const host = (url?.host || []).join('.');
  const path = (url?.path || []).map(p => (typeof p === 'string' ? p : p?.value ?? '')).join('/');
  return `${url?.protocol ? `${url.protocol}://` : ''}${host}${path ? `/${path}` : ''}`;
}

const queryOf = (url, raw) => (Array.isArray(url?.query) ? kv(url.query).map(([key, value], i) => ({ key, value, description: url.query[i]?.description }))
  : [...new URLSearchParams(String(raw).split('?')[1] || '')].map(([key, value]) => ({ key, value })));

function rawBody(text, lang, vars) {
  const t = subst(text || '', vars);
  let json; try { json = JSON.parse(t); } catch { json = undefined; }
  if (json && typeof json === 'object' && !Array.isArray(json)) return { type: 'application/json', props: Object.entries(json) };
  if (!t) return null;
  return { type: lang === 'xml' ? 'application/xml' : lang === 'json' ? 'application/json' : 'text/plain', props: [] };
}

function postmanBody(b, vars) {
  if (!b || b.disabled) return null;
  if (b.mode === 'urlencoded') return { type: 'application/x-www-form-urlencoded', props: kv(b.urlencoded).map(([k, v]) => [k, subst(v, vars)]) };
  if (b.mode === 'formdata') return { type: 'multipart/form-data', props: kv((b.formdata || []).filter(f => f.type !== 'file')).map(([k, v]) => [k, subst(v, vars)]) };
  if (b.mode === 'graphql') return { type: 'application/json', props: [['query', b.graphql?.query || ''], ['variables', '']] };
  return rawBody(b.raw, b.options?.raw?.language, vars);
}

function postmanRequests(doc, vars) {
  const out = [];
  const walk = (items, folder) => {
    for (const it of items || []) {
      if (Array.isArray(it.item)) { walk(it.item, it.name || folder); continue; }
      if (!it.request) continue;
      const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
      const raw = rawUrl(r.url);
      if (!raw) continue;
      const example = (it.response || []).find(x => /json/i.test(textOf(x?.header?.find(h => /content-type/i.test(h.key))?.value || 'json')) && x.body);
      out.push({
        name: it.name, folder, description: textOf(r.description) || textOf(it.description), method: String(r.method || 'GET').toLowerCase(),
        raw, query: queryOf(r.url, raw), headers: kv(r.header).map(([name, value]) => ({ name, value })),
        body: postmanBody(r.body, vars), auth: r.auth, example: example?.body,
      });
    }
  };
  walk(doc.item, '');
  return out;
}

function insomniaBody(b, vars) {
  if (!b || !Object.keys(b).length) return null;
  if (/urlencoded/i.test(b.mimeType || '')) return { type: 'application/x-www-form-urlencoded', props: kv(b.params).map(([k, v]) => [k, subst(v, vars)]) };
  if (/form-data/i.test(b.mimeType || '')) return { type: 'multipart/form-data', props: kv((b.params || []).filter(p => p.type !== 'file')).map(([k, v]) => [k, subst(v, vars)]) };
  return rawBody(b.text, /json/i.test(b.mimeType || '') ? 'json' : '', vars);
}

function insomniaRequests(doc, vars) {
  const res = doc.resources || [];
  const groups = new Map(res.filter(r => r._type === 'request_group').map(r => [r._id, r.name]));
  return res.filter(r => r._type === 'request' && r.url).map(r => ({
    name: r.name, folder: groups.get(r.parentId) || '', description: textOf(r.description), method: String(r.method || 'GET').toLowerCase(),
    raw: String(r.url).split('?')[0], query: (r.parameters || []).filter(p => !p.disabled).map(p => ({ key: p.name, value: p.value ?? '', description: p.description })),
    headers: (r.headers || []).filter(h => !h.disabled).map(h => ({ name: h.name, value: h.value ?? '' })),
    body: insomniaBody(r.body, vars), auth: r.authentication, example: null,
  }));
}

function splitUrl(raw, vars, what) {
  const s = subst(String(raw).split('#')[0].split('?')[0].trim(), vars);
  const m = HOSTPATH.exec(s);
  if (!m) throw fail(`${what}: cannot read the url ${oneLine(raw, 100)}`);
  const [, proto, host, path] = m;
  if (host.includes('{')) throw fail(`${what}: the host in ${oneLine(raw, 100)} is an undefined variable; define it in the collection or export the environment that holds it`);
  let origin;
  try { origin = new URL(`${proto || 'https://'}${host}`).origin; }
  catch { throw fail(`${what}: ${oneLine(raw, 100)} is not a url declick can call`); }
  return { origin, path: path || '/' };
}

// {{var}} and :param in a path become args; a variable the collection defines was already substituted above.
function pathArgs(path) {
  const args = [];
  const out = path.replace(PARAM, (_, v, p) => { const n = argName(v || p); args.push({ name: n, required: true, type: 'string' }); return `{${n}}`; });
  return { path: out, args };
}

function uniqueName(r, taken) {
  const base = safeName(r.name || `${r.method} ${r.path}`, 'verb');
  const first = base === 'describe' ? 'describe-op' : base;
  const free = [first, r.folder ? `${safeName(r.folder, 'f')}-${first}` : null].filter(Boolean).find(c => !taken.has(c));
  if (free) return free;
  let n = 2; while (taken.has(`${first}-${n}`)) n++;
  return `${first}-${n}`;
}

export async function compile(source, { name, verbs: only, tag, host } = {}) {
  const doc = await loadDoc(source);
  if (!detect(doc)) throw fail(`${sourceOf(source)} is not a postman collection or an insomnia export`);
  const insomnia = doc._type === 'export';
  const vars = collectionVars(doc);
  const reqs = (insomnia ? insomniaRequests(doc, vars) : postmanRequests(doc, vars)).map(r => ({ ...r, ...splitUrl(r.raw, vars, r.name || r.raw) }));
  if (!reqs.length) throw fail(`no requests in ${sourceOf(source)}`);
  const apiName = name || safeName(insomnia ? doc.resources.find(r => r._type === 'workspace')?.name || 'api' : doc.info?.name || 'api', 'api');
  const origin = chooseOrigin(reqs.map(r => r.origin), host);
  const auth = authRegistry(apiName);
  const collectionAuth = doc.auth || null;
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const taken = new Set(); const available = []; const verbs = [];
  for (const r of reqs) {
    if (r.origin !== origin) { warn(`skipping ${r.name}: ${r.origin} is not ${origin}`); continue; }
    const vname = uniqueName(r, taken);
    taken.add(vname); available.push(vname);
    if (tag && kebab(r.folder) !== kebab(tag)) continue;
    if (wanted?.length && !wanted.includes(vname)) continue;
    const { path, args } = pathArgs(r.path);
    const query = r.query.map(q => flagOf(q.key, q.description, subst(q.value, vars)));
    const props = (r.body?.props || []).map(([k, v]) => flagOf(k, '', v, jsonType(v)));
    const keys = [];
    for (const found of [schemeOf(r.auth || collectionAuth), ...r.headers.filter(h => AUTH_HEADERS.has(String(h.name).toLowerCase())).map(h => headerScheme(h.name, h.value))]) {
      const k = auth.add(found);
      if (k && !keys.includes(k)) keys.push(k);
    }
    verbs.push({
      name: vname, description: oneLine(r.description || `${r.method.toUpperCase()} ${path}`, 80),
      mutating: !['get', 'head'].includes(r.method), args,
      flags: [...query, ...(r.body ? [{ name: 'body', description: `raw ${r.body.type} body`, required: false, type: 'string' }] : []), ...props],
      returns: returnsOfJson(r.example ? (() => { try { return JSON.parse(r.example); } catch { return undefined; } })() : undefined),
      http: {
        method: r.method, path, query: query.map(f => f.name), bodyProps: props.map(f => f.name),
        security: keys.length ? [keys] : [], ...(r.body ? { bodyType: r.body.type } : {}),
      },
    });
  }
  if ((tag || wanted?.length) && !verbs.length) throw fail(`no verb matches ${tag ? `folder ${tag}` : wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}`);
  return {
    name: apiName, engine: 'postman', source: sourceOf(source), builtAt: new Date().toISOString(),
    baseUrl: origin, auth: auth.manifest(), verbs,
  };
}
