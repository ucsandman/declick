import { readFileSync } from 'node:fs';
import { loadEnv } from '../creds.mjs';
import { EXIT } from '../output.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

async function loadSpec(source) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`fetch ${source}: ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

export async function compile(source, { name } = {}) {
  const spec = await loadSpec(source);
  const apiName = name || kebab(spec.info?.title || 'api');
  const schemes = Object.keys(spec.components?.securitySchemes || {});
  const envFor = s => `${upperSnake(apiName)}_${upperSnake(s)}`;
  const verbs = [];
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
      const params = [...(ops.parameters || []), ...(op.parameters || [])];
      const args = params.filter(p => p.in === 'path').map(p => ({ name: p.name, required: true }));
      const query = params.filter(p => p.in === 'query');
      const flags = query.map(p => ({ name: p.name, description: p.description || '' }));
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      const bodyProps = bodySchema?.type === 'object' ? Object.keys(bodySchema.properties || {}) : [];
      if (op.requestBody) flags.unshift({ name: 'body', description: 'raw JSON body' });
      for (const p of bodyProps) flags.push({ name: p, description: bodySchema.properties[p].description || '' });
      const security = (op.security || spec.security || []).flatMap(s => Object.keys(s));
      verbs.push({
        name: kebab(op.operationId || `${method} ${path}`),
        description: (op.summary || op.description || `${method.toUpperCase()} ${path}`).slice(0, 80),
        args, flags, mutating: !['get', 'head'].includes(method),
        http: { method, path, query: query.map(p => p.name), bodyProps, security },
      });
    }
  }
  const usedSchemes = [...new Set(verbs.flatMap(v => v.http.security))].filter(s => schemes.includes(s));
  return {
    name: apiName, engine: 'openapi', source, builtAt: new Date().toISOString(),
    baseUrl: spec.servers?.[0]?.url || '',
    auth: { env: usedSchemes.map(envFor), schemes: Object.fromEntries(usedSchemes.map(s => [s, { ...spec.components.securitySchemes[s], env: envFor(s) }])) },
    verbs,
  };
}

export async function execute(m, verbName, positional, flags = {}, { fetch: doFetch = globalThis.fetch } = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run describe` };
  if (positional.length < v.args.filter(a => a.required !== false).length) {
    return { ok: false, exit: EXIT.ERROR, error: `${verbName} needs ${v.args.map(a => `<${a.name}>`).join(' ')}` };
  }
  let path = v.http.path;
  v.args.forEach((a, i) => { path = path.replace(`{${a.name}}`, encodeURIComponent(positional[i])); });
  const url = new URL(m.baseUrl.replace(/\/$/, '') + path);
  for (const q of v.http.query) if (flags[q] !== undefined) url.searchParams.set(q, String(flags[q]));
  const headers = { accept: 'application/json' };
  let body;
  if (flags.body) body = String(flags.body);
  else if (v.http.bodyProps.length) {
    const o = {}; for (const p of v.http.bodyProps) if (flags[p] !== undefined) o[p] = flags[p];
    if (Object.keys(o).length) body = JSON.stringify(o);
  }
  if (body) headers['content-type'] = 'application/json';

  const envNames = v.http.security.map(s => m.auth.schemes?.[s]?.env).filter(Boolean);
  const { found, missing } = loadEnv(envNames);
  if (missing.length && !flags.dryRun) {
    return { ok: false, exit: EXIT.AUTH, error: `set ${missing.join(', ')} (creds mint ${m.name})` };
  }
  const masked = {};
  for (const s of v.http.security) {
    const sch = m.auth.schemes?.[s]; if (!sch) continue;
    const val = flags.dryRun ? `<${sch.env}>` : found[sch.env];
    if (sch.type === 'apiKey' && sch.in === 'header') { headers[sch.name] = val; masked[sch.name] = `<${sch.env}>`; }
    else if (sch.type === 'apiKey' && sch.in === 'query') url.searchParams.set(sch.name, val);
    else if (sch.type === 'http') { headers.authorization = `${sch.scheme === 'basic' ? 'Basic' : 'Bearer'} ${val}`; masked.authorization = `Bearer <${sch.env}>`; }
  }
  const method = v.http.method.toUpperCase();
  if (flags.dryRun) return { ok: true, data: { method, url: url.toString(), headers: { ...headers, ...masked }, body } };

  const res = await doFetch(url.toString(), { method, headers, body });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) return { ok: false, exit: res.status === 401 || res.status === 403 ? EXIT.AUTH : res.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR, error: `${method} ${url.pathname} -> ${res.status}`, data };
  return { ok: true, data };
}
