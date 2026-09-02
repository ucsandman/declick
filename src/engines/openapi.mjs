import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, vaultPath } from '../creds.mjs';
import { EXIT, RESERVED, camel } from '../output.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const isUrl = s => /^https?:\/\//.test(s);
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
const SENDABLE = new Set(['apiKey', 'http', 'oauth2', 'openIdConnect']);

async function loadSpec(source) {
  if (!isUrl(source)) return JSON.parse(readFileSync(source, 'utf8'));
  const r = await fetch(source);
  if (!r.ok) throw fail(`fetch ${source}: ${r.status}`);
  return r.json();
}

// Local '#/a/b' pointers only. A remote or dangling ref becomes an empty node so one bad ref cannot fail the build.
function deref(spec, node) {
  for (let i = 0; node?.$ref && i < 8; i++) node = node.$ref.startsWith('#/') ? node.$ref.split('/').slice(1).reduce((o, k) => o?.[k], spec) : null;
  return node?.$ref ? {} : node || {};
}

function baseUrlOf(spec, source) {
  const server = spec.servers?.[0] || {};
  let url = server.url || '';
  for (const [k, v] of Object.entries(server.variables || {})) url = url.replaceAll(`{${k}}`, v.default ?? '');
  if (isUrl(source)) url = new URL(url || '.', source).toString();
  else if (url && !isUrl(url)) throw fail(`server url ${url} is relative and ${source} is a file, so the host is unknown; add the spec by its URL instead`);
  return url.replace(/\/$/, '');
}

function uniqueName(op, method, path, taken) {
  let name = kebab(op.operationId || `${method} ${path}`) || method;
  if (/^[0-9]/.test(name)) name = `${method}-${name}`;
  if (name === 'describe') name = 'describe-op';
  if (!taken.has(name)) return name;
  const bySegment = path.split('/').map(kebab).filter(s => s && !name.includes(s)).map(s => `${name}-${s}`).find(c => !taken.has(c));
  if (bySegment) return bySegment;
  let n = 2; while (taken.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

// A flag whose spec name is a contract flag is renamed; wire carries the name the API actually expects.
const flagOf = (name, description, required, type) => RESERVED.includes(name)
  ? { name: `param-${name}`, description: description || '', required, type, wire: name }
  : { name, description: description || '', required, type };

export async function compile(source, { name, verbs: only, tag } = {}) {
  const spec = await loadSpec(source);
  const apiName = name || kebab(spec.info?.title || 'api');
  const schemes = spec.components?.securitySchemes || {};
  const envFor = s => `${upperSnake(apiName)}_${upperSnake(s)}`;
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const taken = new Set(); const available = []; const verbs = [];
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!METHODS.includes(method)) continue;
      const vname = uniqueName(op, method, path, taken);
      taken.add(vname); available.push(vname);
      if (tag && !(op.tags || []).includes(tag)) continue;
      if (wanted?.length && !wanted.includes(vname)) continue;
      const merged = [...(ops.parameters || []), ...(op.parameters || [])].map(p => deref(spec, p));
      const params = [...new Map(merged.map(p => [`${p.in}:${p.name}`, p])).values()];
      const args = params.filter(p => p.in === 'path').map(p => ({ name: p.name, required: true, type: deref(spec, p.schema).type }));
      const query = params.filter(p => p.in === 'query').map(p => flagOf(p.name, p.description, !!p.required, deref(spec, p.schema).type));
      const rb = deref(spec, op.requestBody);
      const bodyType = Object.keys(rb.content || {})[0];
      const schema = deref(spec, rb.content?.[bodyType]?.schema);
      const body = Object.entries(schema.properties || {}).map(([n, s]) => [n, deref(spec, s)])
        .map(([n, s]) => flagOf(n, s.description, (schema.required || []).includes(n), s.type));
      verbs.push({
        name: vname,
        description: (op.summary || op.description || `${method.toUpperCase()} ${path}`).slice(0, 80),
        args, mutating: !['get', 'head'].includes(method),
        flags: [...query, ...(bodyType ? [{ name: 'body', description: `raw ${bodyType} body`, required: false, type: 'string' }] : []), ...body],
        http: {
          method, path, query: query.map(f => f.name), bodyProps: body.map(f => f.name),
          security: (op.security || spec.security || []).map(s => Object.keys(s)), ...(bodyType ? { bodyType } : {}),
        },
      });
    }
  }
  if ((tag || wanted?.length) && !verbs.length) {
    throw fail(`no verb matches ${tag ? `tag ${tag}` : wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}`);
  }
  const used = [...new Set(verbs.flatMap(v => v.http.security.flat()))].filter(s => schemes[s]);
  const kept = used.filter(s => SENDABLE.has(schemes[s].type));
  for (const s of used) if (!kept.includes(s)) process.stderr.write(`skipping unsupported security scheme ${s} (${schemes[s].type})\n`);
  return {
    name: apiName, engine: 'openapi', source: isUrl(source) ? source : resolve(source), builtAt: new Date().toISOString(),
    baseUrl: baseUrlOf(spec, source),
    auth: { env: kept.map(envFor), schemes: Object.fromEntries(kept.map(s => [s, { ...schemes[s], env: envFor(s) }])) },
    verbs,
  };
}

function buildRequest(m, v, positional, flags) {
  const need = v.args.filter(a => a.required !== false);
  if (positional.length < need.length) throw fail(`${v.name} needs ${need.map(a => `<${a.name}>`).join(' ')}; run: ${m.name} describe --full`);
  let path = v.http.path;
  v.args.forEach((a, i) => { if (positional[i] !== undefined) path = path.replace(`{${a.name}}`, encodeURIComponent(positional[i])); });
  if (path.includes('{')) throw fail(`unfilled path parameter in ${path}; run: ${m.name} describe --full`);
  let url;
  try { url = new URL(m.baseUrl.replace(/\/$/, '') + path); }
  catch { throw fail(`bad base url ${m.baseUrl} for ${m.name}; run: declick build ${m.name}`); }
  const flagFor = n => (v.flags || []).find(f => f.name === n) || { name: n };
  const valueOf = f => {
    const x = flags[f.name] ?? flags[camel(f.name)];
    if (x === true && f.type !== 'boolean') throw fail(`flag --${f.name} needs a value`);
    return x;
  };
  for (const q of v.http.query) {
    const f = flagFor(q); const x = valueOf(f);
    if (x === undefined) { if (f.required) throw fail(`${v.name} needs --${f.name}; run: ${m.name} describe --full`); continue; }
    if (Array.isArray(x)) for (const one of x) url.searchParams.append(f.wire || f.name, String(one));
    else url.searchParams.set(f.wire || f.name, String(x));
  }
  const headers = { accept: 'application/json' };
  const type = v.http.bodyType || 'application/json';
  let body;
  if (flags.body !== undefined && flags.body !== true) body = String(flags.body);
  else if (v.http.bodyProps.length) {
    const o = {};
    for (const p of v.http.bodyProps) { const f = flagFor(p); const x = valueOf(f); if (x !== undefined) o[f.wire || f.name] = x; }
    if (Object.keys(o).length) body = type.includes('urlencoded') ? new URLSearchParams(o).toString() : JSON.stringify(o);
  }
  if (body !== undefined) headers['content-type'] = type;

  // OpenAPI security is a list of alternatives; each alternative is a set of schemes that must all be present.
  const sec = v.http.security.map(a => (Array.isArray(a) ? a : [a])); // manifests built before 0.2 stored a flat list
  const alts = (sec.length ? sec : [[]]).map(a => a.filter(s => m.auth.schemes?.[s]));
  const envs = a => a.map(s => m.auth.schemes[s].env);
  const chosen = flags.dryRun ? alts[0] : alts.find(a => !loadEnv(envs(a)).missing.length);
  if (!chosen) throw fail(`set ${alts.map(a => envs(a).join(' + ')).join(' or ')} in the environment or ${vaultPath()} (or run: creds mint ${m.name})`, EXIT.AUTH);
  const { found } = loadEnv(envs(chosen));
  const masked = {};
  for (const s of chosen) {
    const sch = m.auth.schemes[s];
    const val = flags.dryRun ? `<${sch.env}>` : found[sch.env];
    if (sch.type === 'apiKey' && sch.in === 'query') url.searchParams.set(sch.name, val);
    else if (sch.type === 'apiKey' && sch.in === 'cookie') { headers.cookie = `${sch.name}=${val}`; masked.cookie = `${sch.name}=<${sch.env}>`; }
    else if (sch.type === 'apiKey') { headers[sch.name] = val; masked[sch.name] = `<${sch.env}>`; }
    else { const kind = sch.scheme === 'basic' ? 'Basic' : 'Bearer'; headers.authorization = `${kind} ${val}`; masked.authorization = `${kind} <${sch.env}>`; }
  }
  return { method: v.http.method.toUpperCase(), url, headers, masked, body };
}

export async function execute(m, verb, positional, flags = {}, { fetch: doFetch = globalThis.fetch } = {}) {
  const v = m.verbs.find(x => x.name === verb);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${m.name}` };
  let req;
  try { req = buildRequest(m, v, positional, flags); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  const { method, url, headers, masked, body } = req;
  if (flags.dryRun) return { ok: true, data: { method, url: url.toString(), headers: { ...headers, ...masked }, body } };

  // A hung API must not hang the agent: bounded by DECLICK_TIMEOUT_MS (default 30s), reported as exit 1.
  let res;
  try { res = await doFetch(url.toString(), { method, headers, body, signal: AbortSignal.timeout(Number(process.env.DECLICK_TIMEOUT_MS) || 30000) }); }
  catch (e) { return { ok: false, exit: EXIT.ERROR, error: `${method} ${url.pathname} ${e.name === 'TimeoutError' ? 'timed out' : 'failed'} (${e.cause?.message || e.message}); check ${m.baseUrl}` }; }
  const text = await res.text();
  let data = text;
  // Only a json content-type with a body is worth parsing, and a lying content-type keeps its raw text.
  if (/json/.test(res.headers.get('content-type') || '') && text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) return { ok: false, exit: res.status === 401 || res.status === 403 ? EXIT.AUTH : res.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR, error: `${method} ${url.pathname} -> ${res.status}`, data };
  return res.status === 204 || !text ? { ok: true, data: { status: res.status } } : { ok: true, data };
}
