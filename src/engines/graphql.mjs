import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadEnv, vaultPath, mintHint } from '../creds.mjs';
import { EXIT, RESERVED, camel } from '../output.mjs';
import { oneLine } from '../describe.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const pascal = s => kebab(s).split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('') || 'Op';
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const isUrl = s => /^https?:\/\//.test(s);
// --select is a runtime flag on every verb that has a selection set, so a schema argument called select moves aside too.
const TAKEN = new Set([...RESERVED, 'select']);
const NUMERIC = new Set(['Int', 'Float']);

// SDL notation ("[Pet!]!") is the single representation: introspection type refs are folded into it on the way in.
const baseType = t => t.replace(/[[\]!]/g, '');
const isRequired = t => t.endsWith('!');
const isList = t => t.replace(/!+$/, '').startsWith('[');
const typeStr = ref => ref?.kind === 'NON_NULL' ? `${typeStr(ref.ofType)}!` : ref?.kind === 'LIST' ? `[${typeStr(ref.ofType)}]` : ref?.name || 'String';

const INTROSPECTION = 'query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { kind name description fields(includeDeprecated: false) { name description args { name description type { ...T } } type { ...T } } inputFields { name description type { ...T } } enumValues(includeDeprecated: false) { name } } } } fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';

async function post(url, query, variables, token, doFetch = globalThis.fetch) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  // A hung endpoint must not hang the agent: bounded by DECLICK_TIMEOUT_MS (default 30s).
  try { res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(Number(process.env.DECLICK_TIMEOUT_MS) || 30000) }); }
  catch (e) { throw fail(`POST ${url} ${e.name === 'TimeoutError' ? 'timed out' : 'failed'} (${e.cause?.message || e.message})`); }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, ok: res.ok, body, text };
}

function fromIntrospection(doc) {
  const s = doc?.data?.__schema || doc?.__schema || doc;
  if (!s || !Array.isArray(s.types)) throw fail('not an introspection result: no __schema.types');
  const types = new Map();
  for (const t of s.types) {
    if (!t.name || t.name.startsWith('__')) continue;
    types.set(t.name, {
      name: t.name, kind: t.kind,
      fields: (t.fields || []).map(f => ({ name: f.name, description: f.description, type: typeStr(f.type), args: (f.args || []).map(a => ({ name: a.name, description: a.description, type: typeStr(a.type) })) })),
      inputFields: (t.inputFields || []).map(f => ({ name: f.name, description: f.description, type: typeStr(f.type) })),
      values: (t.enumValues || []).map(v => v.name),
    });
  }
  return { query: s.queryType?.name || 'Query', mutation: s.mutationType?.name || null, types };
}

function braceBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return { body: src.slice(open + 1), end: src.length };
}

const FIELD = /(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([[\]\w!]+)/g;
const fieldsIn = body => [...body.replace(/@\w+(\([^)]*\))?/g, ' ').matchAll(FIELD)]
  .map(([, name, args, type]) => ({ name, description: null, type, args: args ? fieldsIn(args).map(a => ({ name: a.name, description: null, type: a.type })) : [] }));

// Enough SDL for a schema someone pasted: type, input, enum and interface bodies with their argument lists.
// Directives, unions and bare scalars carry nothing a verb needs, so they are skipped instead of parsed.
function fromSdl(text) {
  const src = text.replace(/"""[\s\S]*?"""/g, ' ').replace(/#[^\n]*/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  const kinds = { type: 'OBJECT', input: 'INPUT_OBJECT', enum: 'ENUM', interface: 'INTERFACE' };
  const types = new Map();
  const sd = /(?:^|\n)\s*schema\b[^{]*\{([^}]*)\}/.exec(src);
  const query = sd ? /query\s*:\s*(\w+)/.exec(sd[1])?.[1] || 'Query' : 'Query';
  const mutation = sd ? /mutation\s*:\s*(\w+)/.exec(sd[1])?.[1] || null : 'Mutation';
  const defs = /(?:^|\n)\s*(?:extend\s+)?(type|input|enum|interface)\s+(\w+)[^{]*\{/g;
  for (let d; (d = defs.exec(src));) {
    const { body, end } = braceBody(src, defs.lastIndex - 1);
    defs.lastIndex = end;
    const kind = kinds[d[1]];
    const fields = kind === 'ENUM' ? [] : fieldsIn(body);
    types.set(d[2], {
      name: d[2], kind,
      fields: kind === 'INPUT_OBJECT' ? [] : fields,
      inputFields: kind === 'INPUT_OBJECT' ? fields : [],
      values: kind === 'ENUM' ? body.replace(/@\w+(\([^)]*\))?/g, ' ').match(/\w+/g) || [] : [],
    });
  }
  if (!types.size) throw fail('no type, input or enum definitions found; is this a GraphQL SDL file?');
  return { query, mutation, types };
}

function defaultName(src) {
  const raw = isUrl(src) ? new URL(src).hostname : basename(src).replace(/\.[^.]+$/, '');
  const nm = kebab(raw) || 'graphql';
  return /^[a-z]/.test(nm) ? nm : `gql-${nm}`;
}

async function loadSchema(src, apiName) {
  if (!isUrl(src)) {
    const text = readFileSync(src, 'utf8');
    return { schema: /^\s*[{[]/.test(text) ? fromIntrospection(JSON.parse(text)) : fromSdl(text), env: [] };
  }
  const key = `${upperSnake(apiName)}_TOKEN`;
  let env = [];
  let r = await post(src, INTROSPECTION, {});
  // A closed endpoint answers the first probe with 401/403; the bearer it wants is <NAME>_TOKEN.
  if (r.status === 401 || r.status === 403) {
    const { found, missing } = loadEnv([key]);
    if (missing.length) throw fail(`${src} returned ${r.status}; set ${key} in the environment or ${vaultPath()}${mintHint(apiName)}`, EXIT.AUTH);
    r = await post(src, INTROSPECTION, {}, found[key]);
    if (r.status === 401 || r.status === 403) throw fail(`${key} was rejected by ${src} (${r.status})`, EXIT.AUTH);
    env = [key];
  }
  if (!r.ok) throw fail(`introspecting ${src} returned ${r.status}${r.body?.errors?.length ? `: ${oneLine(r.body.errors[0].message, 120)}` : ''}`);
  if (r.body?.errors?.length) throw fail(`introspection refused by ${src}: ${oneLine(r.body.errors[0].message, 120)}`);
  if (!r.body) throw fail(`${src} did not return JSON; is it a GraphQL endpoint?`);
  return { schema: fromIntrospection(r.body), env };
}

const scalarType = t => (isList(t) ? 'string' : NUMERIC.has(baseType(t)) ? 'number' : baseType(t) === 'Boolean' ? 'boolean' : 'string');

// Every scalar and enum field of the return type, plus one level of nested objects with their scalars.
function selectionOf(schema, typeName, depth = 1, budget = { n: 40 }) {
  const t = schema.types.get(typeName);
  if (!t || (t.kind !== 'OBJECT' && t.kind !== 'INTERFACE')) return [];
  const out = [];
  for (const f of t.fields) {
    if (budget.n <= 0) break;
    if ((f.args || []).some(a => isRequired(a.type))) continue; // a field that demands arguments cannot sit in a default selection
    const ft = schema.types.get(baseType(f.type));
    if (!ft || ft.kind === 'ENUM' || ft.kind === 'SCALAR') { budget.n--; out.push({ name: f.name, type: baseType(f.type) }); }
    else if (depth > 0) {
      const sub = selectionOf(schema, baseType(f.type), 0, budget);
      if (sub.length) { budget.n--; out.push({ name: f.name, type: baseType(f.type), sub }); }
    }
  }
  return out;
}
const render = es => es.map(e => (e.sub ? `${e.name} { ${render(e.sub)} }` : e.name)).join(' ');

// What a verb gives back, so an agent can pass --fields without calling the endpoint blind first.
function returnsOf(type, sel) {
  if (!sel.length) return { shape: isList(type) ? 'array' : 'scalar', fields: [] };
  const fields = sel.map(e => ({ name: oneLine(e.name, 100), type: e.type }));
  return { shape: isList(type) ? 'array' : 'object', fields: fields.slice(0, 30), ...(fields.length > 30 ? { truncated: true } : {}) };
}

function verbOf(schema, kind, f, vname) {
  const flags = []; const gargs = [];
  const flagName = n => (TAKEN.has(n) ? `param-${n}` : n);
  const enumOf = t => (t?.kind === 'ENUM' ? { enum: t.values } : {});
  for (const a of f.args || []) {
    const at = schema.types.get(baseType(a.type));
    const fl = flagName(kebab(a.name));
    if (at?.kind === 'INPUT_OBJECT') {
      flags.push({ name: fl, description: oneLine(`raw JSON for ${a.name} (${a.type})`, 200), required: false, type: 'string' });
      const fields = at.inputFields.map(inf => {
        const it = schema.types.get(baseType(inf.type));
        const dotted = `${fl}.${kebab(inf.name)}`;
        flags.push({ name: dotted, description: oneLine(inf.description || `${inf.type} field of ${a.name}`, 200), required: isRequired(a.type) && isRequired(inf.type), type: scalarType(inf.type), ...enumOf(it) });
        return { name: inf.name, flag: dotted, type: inf.type, required: isRequired(inf.type) };
      });
      gargs.push({ name: a.name, flag: fl, type: a.type, required: isRequired(a.type), fields });
    } else {
      flags.push({ name: fl, description: oneLine(a.description || `${a.type} argument`, 200), required: isRequired(a.type), type: scalarType(a.type), ...enumOf(at) });
      gargs.push({ name: a.name, flag: fl, type: a.type, required: isRequired(a.type) });
    }
  }
  const sel = selectionOf(schema, baseType(f.type));
  if (sel.length) flags.push({ name: 'select', description: 'selection set to send instead of the default, e.g. --select "id name"', required: false, type: 'string' });
  return {
    name: vname, description: oneLine(f.description || `${kind} ${f.name}`, 80), mutating: kind === 'mutation',
    args: [], flags, returns: returnsOf(f.type, sel),
    graphql: { kind, field: f.name, args: gargs, selection: render(sel) },
  };
}

export async function compile(source, { name, verbs: only, tag, url } = {}) {
  const src = String(source).replace(/^graphql:/, '');
  const apiName = name || defaultName(src);
  if (tag && !['query', 'mutation'].includes(tag)) throw fail(`--tag on a graphql schema selects an operation kind: query or mutation, not ${tag}`);
  const { schema, env } = await loadSchema(src, apiName);
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const taken = new Set(); const available = []; const verbs = [];
  for (const [kind, root] of [['query', schema.query], ['mutation', schema.mutation]]) {
    for (const f of (root && schema.types.get(root)?.fields) || []) {
      let vname = kebab(f.name) || kind;
      if (vname === 'describe' || taken.has(vname)) vname = `${vname}-${kind}`;
      for (let n = 2; taken.has(vname); n++) vname = `${kebab(f.name)}-${kind}-${n}`;
      taken.add(vname); available.push(vname);
      if (tag && tag !== kind) continue;
      if (wanted?.length && !wanted.includes(vname)) continue;
      verbs.push(verbOf(schema, kind, f, vname));
    }
  }
  if (!available.length) throw fail(`no ${schema.query} or ${schema.mutation || 'Mutation'} fields in ${src}; nothing to turn into verbs`);
  if (!verbs.length) throw fail(`no verb matches ${tag ? `tag ${tag}` : wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}`);
  return {
    name: apiName, engine: 'graphql', source: isUrl(src) ? String(source) : resolve(src), builtAt: new Date().toISOString(),
    baseUrl: url || (isUrl(src) ? src : ''), auth: { env }, verbs,
  };
}

function buildOp(m, v, flags) {
  const g = v.graphql;
  const flagFor = n => (v.flags || []).find(f => f.name === n) || { name: n, type: 'string' };
  const valueOf = f => {
    const x = flags[f.name] ?? flags[camel(f.name)];
    if (x === true && f.type !== 'boolean') throw fail(`flag --${f.name} needs a value`);
    return x;
  };
  const coerce = (f, x) => {
    if (Array.isArray(x)) return x.map(one => coerce(f, one));
    if (f.type === 'boolean') return x === true || x === 'true' || x === '1';
    if (f.type !== 'number') return String(x);
    const n = Number(x);
    if (!Number.isFinite(n)) throw fail(`--${f.name} must be a number, got ${x}`);
    return n;
  };
  // An off-enum value is a typo worth catching here: the endpoint would only answer with a parse error after a round trip.
  const check = (f, x) => {
    if (Array.isArray(x)) return x.map(one => check(f, one));
    if (f.enum && !f.enum.includes(x)) throw fail(`--${f.name} must be one of ${f.enum.join(', ')}, got ${x}`);
    return x;
  };
  const variables = {}; const used = [];
  for (const a of g.args) {
    let value;
    if (a.fields) {
      const raw = valueOf(flagFor(a.flag));
      if (raw !== undefined) {
        try { value = JSON.parse(raw); } catch { throw fail(`--${a.flag} must be JSON, e.g. --${a.flag} {"a":1}`); }
      }
      for (const inf of a.fields) {
        const f = flagFor(inf.flag); const x = valueOf(f);
        if (x === undefined) continue;
        value ??= {};
        value[inf.name] = check(f, coerce(f, x));
      }
      const miss = value === undefined ? [] : a.fields.filter(inf => inf.required && value[inf.name] === undefined);
      if (miss.length) throw fail(`${v.name} needs --${miss[0].flag}; run: ${m.name} describe --full`);
    } else {
      const f = flagFor(a.flag); const x = valueOf(f);
      if (x !== undefined) value = check(f, coerce(f, x));
    }
    if (value === undefined) {
      if (a.required) throw fail(`${v.name} needs --${a.fields?.find(i => i.required)?.flag || a.flag}; run: ${m.name} describe --full`);
      continue;
    }
    variables[a.name] = value; used.push(a);
  }
  const sel = flags.select !== undefined && flags.select !== true ? oneLine(flags.select, 4000) : g.selection;
  const args = used.map(a => `${a.name}: $${a.name}`).join(', ');
  const defs = used.map(a => `$${a.name}: ${a.type}`).join(', ');
  const document = `${g.kind} ${pascal(v.name)}${defs ? `(${defs})` : ''} { ${g.field}${args ? `(${args})` : ''}${sel ? ` { ${sel} }` : ''} }`;
  return { document, variables };
}

export async function execute(m, verb, positional, flags = {}, { fetch: doFetch = globalThis.fetch } = {}) {
  const v = m.verbs.find(x => x.name === verb);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${m.name}` };
  let op;
  try { op = buildOp(m, v, flags); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  const key = m.auth?.env?.[0];
  if (flags.dryRun) return { ok: true, data: { url: m.baseUrl || null, method: 'POST', document: op.document, variables: op.variables, ...(key ? { headers: { authorization: `Bearer <${key}>` } } : {}) } };
  const { found, missing } = loadEnv(m.auth?.env || []);
  if (missing.length) return { ok: false, exit: EXIT.AUTH, error: `set ${missing.join(', ')} in the environment or ${vaultPath()}${mintHint(m.name)}` };
  if (!m.baseUrl) return { ok: false, exit: EXIT.ERROR, error: `${m.name} was built from a schema file and has no endpoint; add it by URL: declick add graphql:<url> --name ${m.name}` };
  let r;
  try { r = await post(m.baseUrl, op.document, op.variables, key ? found[key] : undefined, doFetch); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: `${e.message}; check ${m.baseUrl}` }; }
  if (r.status === 401 || r.status === 403) return { ok: false, exit: EXIT.AUTH, error: `POST ${m.baseUrl} -> ${r.status}; set ${key || `${upperSnake(m.name)}_TOKEN`} and run: declick build ${m.name}` };
  // GraphQL reports its own failures with 200 and an errors array, so that comes before the status check.
  if (r.body?.errors?.length) return { ok: false, exit: EXIT.ERROR, error: oneLine(r.body.errors[0]?.message || 'graphql error', 200), data: { errors: r.body.errors } };
  if (!r.ok) return { ok: false, exit: r.status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR, error: `POST ${m.baseUrl} -> ${r.status}`, data: r.body ?? oneLine(r.text, 200) };
  if (!r.body) return { ok: false, exit: EXIT.ERROR, error: `${m.baseUrl} did not return JSON`, data: oneLine(r.text, 200) };
  const data = r.body.data ?? {};
  if (!(v.graphql.field in data)) return { ok: true, data };
  const out = data[v.graphql.field];
  if (out === null && !v.mutating && v.returns?.shape === 'object') return { ok: false, exit: EXIT.NOT_FOUND, error: `${v.graphql.field} returned null; nothing matched` };
  return { ok: true, data: out };
}
