import { existsSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnv, vaultPath, mintHint } from '../creds.mjs';
import { EXIT, RESERVED, camel, rowsPropertyOf } from '../output.mjs';
import { oneLine } from '../describe.mjs';
import { toOpenApi3 } from './swagger2.mjs';
import { isYaml, parseYaml } from '../yaml.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const isUrl = s => /^https?:\/\//.test(s);
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
const SENDABLE = new Set(['apiKey', 'http', 'oauth2', 'openIdConnect']);
const LOCATIONS = ['path', 'query', 'header', 'cookie'];
// Accept, Content-Type and Authorization are the response and body contract, not parameters an agent fills.
const NOT_A_FLAG = /^(accept|content-type|authorization)$/i;
// A header the API demands from every caller, even one modeled in the spec as an apiKey security scheme,
// is not a secret: it never gates a call behind auth, it is an ordinary flag.
const CONTRACT_HEADER = /^(user-agent|accept|content-type|accept-language)$/i;
// Read once, on first use: the engine layer does not touch the filesystem at import time.
let declickVersion;
const DECLICK_VERSION = () => (declickVersion ??= JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
const RETRY_STATUS = new Set([429, 502, 503, 504]);
// A body declick can read back as rows; anything else is bytes and needs --output.
const TEXTISH = /json|text|xml|urlencoded|javascript|csv|^$/i;
const KEEP_HEADERS = ['content-type', 'location', 'link', 'retry-after', 'x-request-id'];

// One spec text, two syntaxes: json first because most specs are json, yaml when it does not parse or the
// name says yaml. The source path itself never changes, so the manifest still points at the file it was built from.
function parseSpec(text, source) {
  const yamlish = /\.ya?ml($|\?)/i.test(source) || isYaml(text);
  if (!yamlish) { try { return JSON.parse(text); } catch (e) { if (!/^\s*[[{]/.test(text)) return parseYaml(text); throw fail(`${source} is not valid JSON (${e.message})`); } }
  try { return parseYaml(text); } catch (e) { throw fail(`${source} is not valid YAML (${e.message})`); }
}

async function loadSpec(source) {
  let spec;
  if (!isUrl(source)) spec = parseSpec(readFileSync(source, 'utf8'), source);
  else {
    const r = await fetch(source);
    if (!r.ok) throw fail(`fetch ${source}: ${r.status}`);
    spec = parseSpec(await r.text(), source);
  }
  return /^2\./.test(String(spec?.swagger ?? '')) ? toOpenApi3(spec, source) : spec;
}

// Local '#/a/b' pointers only. A remote or dangling ref becomes an empty node so one bad ref cannot fail the build.
function deref(spec, node) {
  for (let i = 0; node?.$ref && i < 8; i++) node = node.$ref.startsWith('#/') ? node.$ref.split('/').slice(1).reduce((o, k) => o?.[k], spec) : null;
  return node?.$ref ? {} : node || {};
}

function serversOf(spec, source) {
  // No servers at all means the spec never named its own host: per OpenAPI 3, the implied server url is
  // '/', resolved against the document's own url, i.e. the document's origin, not the document's directory.
  const noServers = !spec.servers?.length;
  const list = noServers ? [{}] : spec.servers;
  return list.map(server => {
    let url = server.url || '';
    for (const [k, v] of Object.entries(server.variables || {})) url = url.replaceAll(`{${k}}`, v.default ?? '');
    if (isUrl(source)) url = new URL(url || (noServers ? '/' : '.'), source).toString();
    else if (url && !isUrl(url)) throw fail(`server url ${url} is relative and ${source} is a file, so the host is unknown; add the spec by its URL instead`);
    return { url: url.replace(/\/$/, ''), ...(server.description ? { description: oneLine(server.description, 200) } : {}) };
  });
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

// The allowed set, the default and one example: enough for an agent to fill a value without a probe call.
function facetsOf(schema = {}, param = null) {
  const example = schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined)
    ?? (param?.examples ? Object.values(param.examples)[0]?.value : undefined) ?? param?.example ?? schema['x-example'] ?? param?.['x-example'];
  return {
    ...(Array.isArray(schema.enum) && schema.enum.length ? { enum: schema.enum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(example !== undefined ? { example } : {}),
  };
}

// A flag whose spec name is a contract flag is renamed; wire carries the name the API actually expects.
const flagOf = (name, description, required, type, extra = {}) => ({
  ...(RESERVED.includes(name) ? { name: `param-${name}`, wire: name } : { name }),
  description: description || '', required, type, ...extra,
});

// Nested body objects become dotted flags (--address.city) so an agent never hand-writes JSON for a known shape.
function bodyFlags(spec, schema, prefix = '', inherited = true, depth = 0) {
  const req = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).flatMap(([n, raw]) => {
    const s = deref(spec, raw);
    const required = inherited && req.has(n);
    if (depth < 2 && s.type === 'object' && s.properties) return bodyFlags(spec, s, `${prefix}${n}.`, required, depth + 1);
    return [flagOf(`${prefix}${n}`, s.description, required, s.type, { ...(s.format === 'binary' ? { format: 'binary' } : {}), ...facetsOf(s) })];
  });
}

// What a verb gives back, so an agent can pass --fields and --rows without calling the API blind first.
function returnsOf(spec, op) {
  const codes = Object.keys(op.responses || {});
  const code = codes.find(c => /^2/.test(c)) ?? (codes.includes('default') ? 'default' : null);
  const res = code ? deref(spec, op.responses[code]) : {};
  const type = Object.keys(res.content || {}).find(t => /json/.test(t));
  const schema = type ? deref(spec, res.content[type].schema) : {};
  const props = s => Object.entries(s.properties || {}).map(([n, x]) => ({ name: oneLine(n, 100), type: deref(spec, x).type }));
  const cap = f => ({ fields: f.slice(0, 30), ...(f.length > 30 ? { truncated: true } : {}) });
  const isList = s => s.type === 'array' || !!s.items;
  if (!type || !Object.keys(schema).length) return { shape: 'none', fields: [] };
  if (isList(schema)) return { shape: 'array', ...cap(props(deref(spec, schema.items))) };
  if (!schema.properties && schema.type !== 'object') return { shape: 'scalar', fields: [] };
  // Which property, if any, is the page of rows: the rule lives in output.mjs, shared with the runtime and the other engines.
  const resolved = Object.entries(schema.properties || {}).map(([n, x]) => [n, deref(spec, x)]);
  const rowsPath = rowsPropertyOf(resolved.map(([n, x]) => ({ name: n, isList: isList(x) })));
  if (rowsPath) return { shape: 'object', rowsPath: oneLine(rowsPath, 100), ...cap(props(deref(spec, resolved.find(([n]) => n === rowsPath)[1].items))) };
  return { shape: 'object', ...cap(props(schema)) };
}

export async function compile(source, { name, verbs: only, tag } = {}) {
  const spec = await loadSpec(source);
  const apiName = name || kebab(spec.info?.title || 'api');
  const schemes = spec.components?.securitySchemes || {};
  const envFor = s => `${upperSnake(apiName)}_${upperSnake(s)}`;
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const servers = serversOf(spec, source);
  const taken = new Set(); const available = []; const verbs = [];
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!METHODS.includes(method)) continue;
      const vname = uniqueName(op, method, path, taken);
      taken.add(vname); available.push(vname);
      if (tag && !(op.tags || []).includes(tag)) continue;
      if (wanted?.length && !wanted.includes(vname)) continue;
      const merged = [...(ops.parameters || []), ...(op.parameters || [])].map(p => deref(spec, p));
      // A dangling or remote $ref derefs to {}: no name, no in, nothing to report by name. That is not
      // a location declick refuses, it is a parameter declick never saw, so it is counted, not named.
      const named = merged.filter(p => p.name && p.in);
      const unresolved = merged.length - named.length;
      const params = [...new Map(named.map(p => [`${p.in}:${p.name}`, p])).values()];
      // A location declick cannot send is said out loud; silently dropping it would produce a wrong request.
      for (const p of params) if (!LOCATIONS.includes(p.in)) process.stderr.write(`${vname}: skipping parameter ${p.name} in ${p.in}; declick sends path, query, header and cookie\n`);
      if (unresolved) process.stderr.write(`${vname}: skipping ${unresolved} parameter${unresolved > 1 ? 's' : ''} that could not be resolved ($ref did not resolve to a parameter)\n`);
      const paramFlag = p => { const s = deref(spec, p.schema); return flagOf(p.in === 'header' ? p.name.toLowerCase() : p.name, p.description, !!p.required, s.type, { ...(p.in === 'query' ? {} : { in: p.in }), ...facetsOf(s, p) }); };
      const args = params.filter(p => p.in === 'path').map(p => { const s = deref(spec, p.schema); return { name: p.name, required: true, type: s.type, ...facetsOf(s, p) }; });
      const query = params.filter(p => p.in === 'query').map(paramFlag);
      const sent = params.filter(p => (p.in === 'header' && !NOT_A_FLAG.test(p.name)) || p.in === 'cookie').map(p => ({ ...paramFlag(p), ...(p.in === 'header' && p.name !== p.name.toLowerCase() ? { wire: p.name } : {}) }));
      const rb = deref(spec, op.requestBody);
      const types = Object.keys(rb.content || {});
      const bodyType = types.find(t => /json/.test(t)) ?? types[0];
      // Flags come from every declared body type, so --content-type can switch shapes without a rebuild.
      const body = [...new Map(types.flatMap(t => bodyFlags(spec, deref(spec, rb.content[t].schema))).map(f => [f.name, f])).values()];
      verbs.push({
        name: vname,
        description: (op.summary || op.description || `${method.toUpperCase()} ${path}`).slice(0, 80),
        args, mutating: !['get', 'head'].includes(method), returns: returnsOf(spec, op),
        flags: [...query, ...sent, ...(bodyType ? [{ name: 'body', description: `raw ${bodyType} body`, required: false, type: 'string' }] : []), ...body],
        http: {
          method, path, query: query.map(f => f.name), bodyProps: body.map(f => f.name),
          security: (op.security || spec.security || []).map(s => Object.keys(s)),
          ...(bodyType ? { bodyType } : {}), ...(types.length > 1 ? { bodyTypes: types } : {}),
        },
      });
    }
  }
  if ((tag || wanted?.length) && !verbs.length) {
    throw fail(`no verb matches ${tag ? `tag ${tag}` : wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}`);
  }
  const used = [...new Set(verbs.flatMap(v => v.http.security.flat()))].filter(s => schemes[s]);
  const contract = used.filter(s => schemes[s].type === 'apiKey' && schemes[s].in === 'header' && CONTRACT_HEADER.test(schemes[s].name || ''));
  const kept = used.filter(s => !contract.includes(s) && SENDABLE.has(schemes[s].type));
  for (const s of used) if (!kept.includes(s) && !contract.includes(s)) process.stderr.write(`skipping unsupported security scheme ${s} (${schemes[s].type})\n`);
  // A contract-header scheme stays in http.security (an unmet alternative simply drops out at request time,
  // same as any other scheme absent from auth.schemes) but every verb that references it also gets the
  // ordinary flag an agent can set, since the header still needs to reach the wire when they choose to.
  for (const v of verbs) {
    for (const s of new Set(v.http.security.flat())) {
      if (!contract.includes(s)) continue;
      const sch = schemes[s];
      const name = sch.name.toLowerCase();
      if (v.flags.some(f => f.name === name)) continue;
      v.flags.push(flagOf(name, sch.description, false, 'string', {
        in: 'header', ...(sch.name !== name ? { wire: sch.name } : {}),
        ...(name === 'user-agent' ? { default: `declick/${DECLICK_VERSION()}` } : {}),
      }));
    }
  }
  return {
    name: apiName, engine: 'openapi', source: isUrl(source) ? source : resolve(source), builtAt: new Date().toISOString(),
    baseUrl: servers[0]?.url || '', servers,
    auth: { env: kept.map(envFor), schemes: Object.fromEntries(kept.map(s => [s, { ...schemes[s], env: envFor(s) }])) },
    verbs,
  };
}

const descCmd = (m, v) => `run: declick describe ${m.name} --verb ${v.name}`;
const serverList = m => (m.servers?.length ? m.servers : [{ url: m.baseUrl }]);

// Flag beats env beats the compiled first server, so one adapter drives prod, sandbox and a local stub.
function baseOf(m, flags) {
  if (flags.baseUrl !== undefined && flags.baseUrl !== true) return String(flags.baseUrl);
  if (flags.server !== undefined && flags.server !== true) {
    const want = String(flags.server); const list = serverList(m);
    const hit = /^\d+$/.test(want) ? list[Number(want)] : list.find(s => s.url === want || (s.description || '').toLowerCase() === want.toLowerCase());
    if (!hit) throw fail(`no server ${want} for ${m.name}; known: ${list.map((s, i) => `${i}=${s.description || s.url}`).join(', ')}`);
    return hit.url;
  }
  return process.env[`DECLICK_${upperSnake(m.name)}_BASE_URL`] || m.baseUrl;
}

const TYPE_OK = {
  integer: x => /^-?\d+$/.test(x),
  number: x => x !== '' && Number.isFinite(Number(x)),
  boolean: x => ['true', 'false', '1', '0'].includes(x.toLowerCase()),
};

// The API never sees a value its own spec forbids: enum and type are settled here, on dry runs too.
function checkValue(label, decl, val, where) {
  const s = String(val);
  if (decl.enum?.length && !decl.enum.map(String).includes(s)) throw fail(`${label} must be one of ${decl.enum.join('|')}, got ${s}; ${where}`);
  if (TYPE_OK[decl.type] && !TYPE_OK[decl.type](s)) throw fail(`${label} must be ${decl.type}, got ${JSON.stringify(s)}; ${where}`);
  return val;
}

function coerce(label, decl, val, where) {
  if (decl.type === 'integer' || decl.type === 'number') { checkValue(label, decl, val, where); return Number(val); }
  if (decl.type === 'boolean') { const s = String(val).toLowerCase(); checkValue(label, decl, s === 'true' || s === '1' ? 'true' : s, where); return s === 'true' || s === '1'; }
  if (decl.type === 'object' || decl.type === 'array') {
    try { return JSON.parse(val); } catch (e) { throw fail(`${label} must be ${decl.type} JSON (${e.message}); ${where}`); }
  }
  if (decl.enum?.length) checkValue(label, decl, val, where);
  return val;
}

const setPath = (o, path, val) => {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {});
  cur[keys.at(-1)] = val;
};

const formEncode = o => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();

const readStdin = async () => { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); };

// A body is a path with @, stdin with -, or the literal text; either way it is read before anything is sent.
async function readBody(raw) {
  if (raw === '-') return readStdin();
  if (!raw.startsWith('@')) return raw;
  const p = raw.slice(1);
  if (!existsSync(p)) throw fail(`cannot read ${p} for --body`);
  return readFileSync(p, 'utf8');
}

function pickType(v, flags) {
  const declared = v.http.bodyTypes || (v.http.bodyType ? [v.http.bodyType] : []);
  if (flags.contentType === undefined || flags.contentType === true) return v.http.bodyType || 'application/json';
  const want = String(flags.contentType);
  const hit = declared.find(t => t === want || t.split(';')[0] === want);
  if (declared.length && !hit) throw fail(`--content-type ${want} is not declared for ${v.name}; declared: ${declared.join(', ')}`);
  return hit || want;
}

const qq = s => `'${String(s).replaceAll("'", `'\\''`)}'`;
const curlOf = (method, url, headers, body) => [
  `curl -X ${method}`,
  ...Object.entries(headers).map(([k, v]) => `-H ${qq(`${k}: ${v}`)}`),
  ...(typeof body === 'string' && body ? [`--data ${qq(body)}`] : body ? ['--form <multipart body>'] : []),
  qq(url),
].join(' ');

async function buildRequest(m, v, positional, flags) {
  const where = descCmd(m, v);
  const need = v.args.filter(a => a.required !== false);
  if (positional.length < need.length) throw fail(`${v.name} needs ${need.map(a => `<${a.name}>`).join(' ')}; ${where}`);
  let path = v.http.path;
  v.args.forEach((a, i) => {
    if (positional[i] === undefined) return;
    checkValue(`<${a.name}>`, a, positional[i], where);
    path = path.replace(`{${a.name}}`, encodeURIComponent(positional[i]));
  });
  if (path.includes('{')) throw fail(`unfilled path parameter in ${path}; ${where}`);
  const base = baseOf(m, flags);
  let url;
  try { url = new URL(base.replace(/\/$/, '') + path); }
  catch { throw fail(`bad base url ${base} for ${m.name}; run: declick build ${m.name}`); }
  const flagFor = n => (v.flags || []).find(f => f.name === n) || { name: n };
  const valueOf = f => {
    const x = flags[f.name] ?? flags[camel(f.name)];
    if (x === true && f.type !== 'boolean') throw fail(`flag --${f.name} needs a value; ${where}`);
    return x;
  };
  for (const q of v.http.query) {
    const f = flagFor(q); const x = valueOf(f);
    if (x === undefined) { if (f.required) throw fail(`${v.name} needs --${f.name}; ${where}`); continue; }
    const vals = (Array.isArray(x) ? x : [x]).map(one => checkValue(`--${f.name}`, f, one, where));
    if (Array.isArray(x)) for (const one of vals) url.searchParams.append(f.wire || f.name, String(one));
    else url.searchParams.set(f.wire || f.name, String(vals[0]));
  }

  const headers = { accept: 'application/json' };
  const masked = {};
  const maskedQuery = {};
  const cookies = [];
  for (const f of v.flags || []) {
    if (f.in !== 'header' && f.in !== 'cookie') continue;
    // A header with a compiled default (User-Agent) is sent when the flag is omitted; the flag still overrides it.
    const x = valueOf(f) ?? (f.in === 'header' ? f.default : undefined);
    if (x === undefined) { if (f.required) throw fail(`${v.name} needs --${f.name}; ${where}`); continue; }
    checkValue(`--${f.name}`, f, x, where);
    if (f.in === 'header') headers[(f.wire || f.name).toLowerCase()] = String(x);
    else cookies.push({ pair: `${f.wire || f.name}=${x}`, mask: `${f.wire || f.name}=${x}` });
  }
  // One repeatable escape hatch for whatever the spec forgot to declare.
  for (const h of [].concat(flags.header ?? [])) {
    if (h === true) throw fail(`--header must be 'Name: value'; ${where}`);
    const i = String(h).indexOf(':');
    if (i < 1) throw fail(`--header must be 'Name: value', got ${JSON.stringify(String(h))}; ${where}`);
    const key = String(h).slice(0, i).trim().toLowerCase();
    headers[key] = String(h).slice(i + 1).trim();
    if (/^(authorization|cookie|proxy-authorization)$|key|token|secret/i.test(key)) masked[key] = '***';
  }

  const type = pickType(v, flags);
  let body;
  const rawFlag = flags.bodyFile !== undefined && flags.bodyFile !== true ? `@${[].concat(flags.bodyFile).at(-1)}`
    : flags.body !== undefined && flags.body !== true ? String([].concat(flags.body).at(-1)) : undefined;
  if (rawFlag !== undefined) {
    body = await readBody(rawFlag);
    if (/json/.test(type) && body.trim()) { try { JSON.parse(body); } catch (e) { throw fail(`--body is not valid ${type} (${e.message}); ${where}`); } }
  } else if (v.http.bodyProps?.length) {
    if (/multipart/.test(type)) {
      const form = new FormData();
      for (const p of v.http.bodyProps) {
        const f = flagFor(p); const x = valueOf(f);
        if (x === undefined) continue;
        const s = String(x);
        if (f.format === 'binary' || s.startsWith('@')) {
          const file = s.startsWith('@') ? s.slice(1) : s;
          if (!existsSync(file)) throw fail(`cannot read ${file} for --${f.name}; ${where}`);
          form.append(f.wire || f.name, await openAsBlob(file), basename(file));
        } else form.append(f.wire || f.name, s);
      }
      if ([...form.keys()].length) body = form;
    } else {
      const o = {};
      for (const p of v.http.bodyProps) {
        const f = flagFor(p); const x = valueOf(f);
        if (x === undefined) continue;
        setPath(o, f.wire || f.name, coerce(`--${f.name}`, f, x, where));
      }
      if (Object.keys(o).length) body = /urlencoded/.test(type) ? formEncode(o) : JSON.stringify(o);
    }
  }
  // FormData carries its own boundary, so undici sets content-type; everything else declares it here.
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = type;

  // OpenAPI security is a list of alternatives; each alternative is a set of schemes that must all be present.
  const sec = v.http.security.map(a => (Array.isArray(a) ? a : [a])); // manifests built before 0.2 stored a flat list
  const alts = (sec.length ? sec : [[]]).map(a => a.filter(s => m.auth.schemes?.[s]));
  const envs = a => a.map(s => m.auth.schemes[s].env);
  const chosen = flags.dryRun ? alts[0] : alts.find(a => !loadEnv(envs(a)).missing.length);
  if (!chosen) throw fail(`set ${alts.map(a => envs(a).join(' + ')).join(' or ')} in the environment or ${vaultPath()}${mintHint(m.name)}`, EXIT.AUTH);
  const { found } = loadEnv(envs(chosen));
  for (const s of chosen) {
    const sch = m.auth.schemes[s];
    const val = flags.dryRun ? `<${sch.env}>` : found[sch.env];
    if (sch.type === 'apiKey' && sch.in === 'query') { url.searchParams.set(sch.name, val); maskedQuery[sch.name] = `<${sch.env}>`; }
    else if (sch.type === 'apiKey' && sch.in === 'cookie') cookies.push({ pair: `${sch.name}=${val}`, mask: `${sch.name}=<${sch.env}>`, secret: true });
    else if (sch.type === 'apiKey') { headers[sch.name] = val; masked[sch.name] = `<${sch.env}>`; }
    else { const kind = sch.scheme === 'basic' ? 'Basic' : 'Bearer'; headers.authorization = `${kind} ${val}`; masked.authorization = `${kind} <${sch.env}>`; }
  }
  if (cookies.length) {
    headers.cookie = cookies.map(c => c.pair).join('; ');
    if (cookies.some(c => c.secret)) masked.cookie = cookies.map(c => c.mask).join('; ');
  }
  // shownUrl is the only url that ever reaches the caller: a key that lives in the query string is masked
  // there the same way a header one is, while url itself (the real value) goes nowhere but the fetch.
  const maskedUrl = new URL(url);
  for (const [k, mask] of Object.entries(maskedQuery)) maskedUrl.searchParams.set(k, mask);
  return { method: v.http.method.toUpperCase(), url, shownUrl: maskedUrl.toString(), headers, masked, body, base };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => Math.min(250 * 2 ** n, 4000);
const retryAfterMs = h => {
  if (h == null) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(Math.max(n, 0) * 1000, 10000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.min(Math.max(t - Date.now(), 0), 10000) : null;
};
const numFlag = (raw, name, dflt, min) => {
  if (raw === undefined) return dflt;
  // A bare --retry at the end of a line is a typo, not a request for the default: every other value-taking
  // contract flag says so, and silently using the default hides which number the call actually ran with.
  if (raw === true) throw fail(`--${name} needs a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw fail(`--${name} must be an integer of at least ${min}, got ${raw}`);
  return n;
};

// A hung or rate-limited API must not hang the agent: bounded attempts, bounded wait, both reported in meta.
async function send(doFetch, req, ms, max, timeoutMsg) {
  const { method, url, headers, body } = req;
  let retries = 0, retryAfter;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await doFetch(url.toString(), { method, headers, body, signal: AbortSignal.timeout(ms) }); }
    catch (e) {
      // A timeout is the agent's own budget running out; retrying it would just spend the budget again.
      if (attempt < max && e.name !== 'TimeoutError') { retries++; await sleep(backoff(attempt)); continue; }
      throw fail(e.name === 'TimeoutError' ? timeoutMsg : `${method} ${url.pathname} failed (${e.cause?.message || e.message}); check ${req.base}`);
    }
    if (attempt < max && RETRY_STATUS.has(res.status)) {
      const ra = res.headers.get('retry-after');
      if (ra != null) retryAfter = ra;
      retries++; await sleep(retryAfterMs(ra) ?? backoff(attempt)); continue;
    }
    return { res, retries, retryAfter };
  }
}

const serializeForm = async form => {
  const r = new Request('http://declick.invalid/', { method: 'POST', body: form });
  return { type: r.headers.get('content-type'), text: await r.text() };
};

const statusExit = s => (s === 401 || s === 403 ? EXIT.AUTH : s === 404 ? EXIT.NOT_FOUND : EXIT.ERROR);

export async function execute(m, verb, positional, flags = {}, { fetch: doFetch = globalThis.fetch } = {}) {
  const v = m.verbs.find(x => x.name === verb);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${m.name}` };
  let req, ms, max;
  try {
    req = await buildRequest(m, v, positional, flags);
    ms = numFlag(flags.timeout, 'timeout', Number(process.env.DECLICK_TIMEOUT_MS) || 30000, 1);
    max = numFlag(flags.retry, 'retry', v.mutating ? 0 : 2, 0);
  } catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  const { method, url, shownUrl, headers, masked, body } = req;
  const shown = { ...headers, ...masked };

  if (flags.dryRun) {
    const form = body instanceof FormData ? await serializeForm(body) : null;
    if (form) shown['content-type'] = form.type;
    const data = { method, url: shownUrl, headers: shown, body: form ? form.text : body };
    if (flags.curl) data.curl = curlOf(method, shownUrl, shown, data.body);
    return { ok: true, data };
  }

  const timeoutMsg = `${method} ${url.pathname} timed out after ${ms}ms; raise --timeout <ms> or DECLICK_TIMEOUT_MS`;
  let sent;
  try { sent = await send(doFetch, req, ms, max, timeoutMsg); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  const { res, retries, retryAfter } = sent;

  const meta = { status: res.status, ...(retries ? { retries } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) };
  // The curl line has to reproduce what went out, so a multipart body is serialized here exactly as dry-run does it.
  const form = flags.curl && body instanceof FormData ? await serializeForm(body) : null;
  if (flags.curl) meta.curl = curlOf(method, shownUrl, form ? { ...shown, 'content-type': form.type } : shown, typeof body === 'string' ? body : form ? form.text : undefined);
  if (flags.verbose) {
    const preview = typeof body === 'string' ? body.slice(0, 500) : body ? '<multipart body>' : undefined;
    meta.request = { method, url: shownUrl, headers: shown, ...(preview !== undefined ? { body: preview } : {}) };
    const keep = [...KEEP_HEADERS, ...[...res.headers.keys()].filter(k => k.startsWith('x-ratelimit-'))];
    meta.response = { status: res.status, headers: Object.fromEntries(keep.map(k => [k, res.headers.get(k)]).filter(([, x]) => x != null)) };
  }

  const ct = res.headers.get('content-type') || '';
  if (!TEXTISH.test(ct.split(';')[0])) {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) return { ok: false, exit: statusExit(res.status), error: `${method} ${url.pathname} -> ${res.status}`, meta };
    if (flags.output === undefined || flags.output === true) return { ok: false, exit: EXIT.ERROR, error: `${method} ${url.pathname} returned ${ct} (${bytes.length} bytes); pass --output <path> to save it`, meta };
    const out = resolve(String(flags.output));
    try { writeFileSync(out, bytes); } catch (e) { return { ok: false, exit: EXIT.ERROR, error: `cannot write ${out} (${e.message})`, meta }; }
    return { ok: true, data: { path: out, bytes: bytes.length, contentType: ct }, meta };
  }

  const text = await res.text();
  let data = text;
  // Only a json content-type with a body is worth parsing, and a lying content-type keeps its raw text.
  if (/json/.test(ct) && text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) return { ok: false, exit: statusExit(res.status), error: `${method} ${url.pathname} -> ${res.status}`, data, meta };
  return res.status === 204 || !text ? { ok: true, data: { status: res.status }, meta } : { ok: true, data, meta };
}
