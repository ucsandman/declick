import { loadEnv, vaultPath, mintHint } from '../creds.mjs';
import { EXIT, RESERVED, camel, rowsPropertyOf } from '../output.mjs';
import { oneLine } from '../describe.mjs';
import { assertName } from '../manifest.mjs';
import { mcpClient } from '../mcp-client.mjs';
import { callViaDaemon } from '../daemon.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const upperSnake = s => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const firstLine = (s, n = 80) => oneLine(String(s).split(/\r?\n/)[0], n);
const SCALAR = ['string', 'number', 'integer'];

// mcp:<command with args> spawns a stdio server; mcp:https://host/mcp talks streamable http.
export function parseSource(source) {
  const rest = String(source).replace(/^mcp:/, '').trim();
  if (!rest) throw fail('usage: declick add mcp:<command args> | mcp:https://host/mcp');
  if (/^https?:\/\//.test(rest)) return { transport: 'http', command: null, args: [], url: rest };
  const tokens = (rest.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => (/^["']/.test(t) ? t.slice(1, -1) : t));
  return { transport: 'stdio', command: tokens[0], args: tokens.slice(1), url: null };
}

// A server command is usually "npx -y @scope/server-foo /some/path": nothing in it reliably names the
// adapter, so only a short command derives a name and anything longer has to say --name.
function deriveName(cfg) {
  const last = cfg.transport === 'http'
    ? (new URL(cfg.url).hostname.split('.').slice(0, -1).pop() || '')
    : [cfg.command, ...cfg.args].length > 2 ? '' : [cfg.command, ...cfg.args].at(-1).replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
  const name = kebab(last.replace(/\.[a-z0-9]+$/i, ''));
  return /^[a-z]/.test(name) ? name : null;
}

// A tool argument whose name is a contract flag is renamed; wire carries the name the server expects.
function flagsOf(tool) {
  const schema = tool.inputSchema || {};
  const required = new Set(schema.required || []);
  const used = new Set();
  return Object.entries(schema.properties || {}).map(([prop, s]) => {
    s = s || {};
    let n = kebab(prop) || 'arg';
    if (RESERVED.includes(n)) n = `param-${n}`;
    if (used.has(n)) { let i = 2; while (used.has(`${n}-${i}`)) i++; n = `${n}-${i}`; }
    used.add(n);
    const f = { name: n, description: oneLine(s.description || '', 200), required: required.has(prop), type: s.type || 'string' };
    if (n !== prop) f.wire = prop;
    if (Array.isArray(s.enum)) f.enum = s.enum.map(x => (typeof x === 'string' ? oneLine(x, 100) : x));
    if (s.default !== undefined) f.default = s.default;
    if (s.type === 'array' && s.items?.type) f.item = s.items.type;
    const ex = s.examples?.[0] ?? s.example ?? s.default ?? (Array.isArray(s.enum) ? s.enum[0] : undefined);
    if (ex !== undefined) f.example = typeof ex === 'string' ? oneLine(ex, 100) : ex;
    return f;
  });
}

// What a verb gives back, so an agent can pass --fields and --rows without calling the tool blind first.
function returnsOf(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const isList = s => s?.type === 'array' || !!s?.items;
  const props = s => Object.entries(s?.properties || {}).map(([n, x]) => ({ name: oneLine(n, 100), type: x?.type }));
  const cap = f => ({ fields: f.slice(0, 30), ...(f.length > 30 ? { truncated: true } : {}) });
  if (isList(schema)) return { shape: 'array', ...cap(props(schema.items)) };
  if (!schema.properties && schema.type !== 'object') return { shape: 'scalar', fields: [] };
  const propList = Object.entries(schema.properties || {}).map(([n, x]) => ({ name: n, isList: isList(x) }));
  const rowsPath = rowsPropertyOf(propList);
  if (rowsPath) return { shape: 'object', rowsPath: oneLine(rowsPath, 100), ...cap(props(schema.properties[rowsPath].items)) };
  return { shape: 'object', ...cap(props(schema)) };
}

export async function compile(source, { name, verbs: only, timeout } = {}) {
  const cfg = parseSource(source);
  const adapter = name || deriveName(cfg);
  if (!adapter) throw fail(`cannot derive a name from ${source}; pass --name <kebab-name>`);
  assertName(adapter);
  // Only the key name lands in the manifest; the value stays in the environment or the creds vault.
  const key = `${upperSnake(adapter)}_TOKEN`;
  const bearer = cfg.transport === 'http' ? loadEnv([key]).found[key] : undefined;
  const client = mcpClient({ ...cfg, bearer, timeout });
  let tools;
  try {
    await client.connect();
    tools = await client.listTools();
  } catch (e) {
    if (e.exit === EXIT.AUTH && !bearer) throw fail(`${cfg.url} wants a bearer token; set ${key} in the environment or ${vaultPath()}${mintHint(adapter)}`, EXIT.AUTH);
    throw e;
  } finally { client.close(); }
  if (!tools.length) throw fail(`${source} lists no tools; check the server command or its arguments`);

  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const taken = new Set(); const available = []; const verbs = [];
  for (const tool of tools) {
    let vname = kebab(tool.name) || 'tool';
    if (vname === 'describe') vname = 'describe-tool';
    if (/^[0-9]/.test(vname)) vname = `tool-${vname}`;
    if (taken.has(vname)) { let i = 2; while (taken.has(`${vname}-${i}`)) i++; vname = `${vname}-${i}`; }
    taken.add(vname); available.push(vname);
    if (wanted?.length && !wanted.includes(vname)) continue;
    const flags = flagsOf(tool);
    const first = (tool.inputSchema?.required || []).map(p => flags.find(f => (f.wire || f.name) === p)).find(f => f && SCALAR.includes(f.type));
    const returns = returnsOf(tool.outputSchema);
    verbs.push({
      name: vname,
      description: firstLine(tool.description || tool.title || tool.name) || tool.name,
      // A server that says nothing about a tool is assumed to change something.
      mutating: !(tool.annotations?.readOnlyHint === true),
      args: first ? [{ name: first.name, required: true, type: first.type, ...(first.example !== undefined ? { example: first.example } : {}) }] : [],
      flags,
      ...(returns ? { returns } : {}),
      mcp: { tool: tool.name, inputSchema: tool.inputSchema || { type: 'object' } },
    });
  }
  if (wanted?.length && !verbs.length) throw fail(`no verb matches ${wanted.join(', ')}; available: ${available.slice(0, 20).join(', ')}`);
  return {
    name: adapter, engine: 'mcp', source: oneLine(source, 500), builtAt: new Date().toISOString(),
    baseUrl: cfg.transport === 'http' ? oneLine(cfg.url, 500) : oneLine(`mcp:${[cfg.command, ...cfg.args].join(' ')}`, 500),
    auth: { env: bearer ? [key] : [] },
    mcp: cfg,
    verbs,
  };
}

const bad = (f, want, x) => fail(`--${f.name} must be ${want}, got ${x === true ? '(no value)' : x}`);
const json = (f, x, want) => { try { return JSON.parse(x); } catch { throw bad(f, want, x); } };

// A tool call is JSON, not a query string: every value is coerced to its declared type before it is sent,
// so a typo costs zero round trips instead of one real call.
function convert(f, x) {
  const t = f.type;
  if (x === true && t !== 'boolean') throw fail(`flag --${f.name} needs a value`);
  if (t === 'integer' || t === 'number') {
    const n = Number(x);
    if (x === '' || !Number.isFinite(n) || (t === 'integer' && !Number.isInteger(n))) throw bad(f, t === 'integer' ? 'an integer' : 'a number', x);
    return n;
  }
  if (t === 'boolean') {
    if (x === true || x === 'true' || x === '1') return true;
    if (x === false || x === 'false' || x === '0') return false;
    throw bad(f, 'true or false', x);
  }
  if (t === 'array') {
    const arr = Array.isArray(x) ? x : json(f, x, 'a JSON array');
    if (!Array.isArray(arr)) throw bad(f, 'a JSON array', x);
    return arr.map(one => convert({ ...f, type: f.item || 'string' }, one));
  }
  if (t === 'object') {
    // An element of an array flag arrives already parsed (the array branch maps this over the items), so only
    // a string still needs JSON.parse: an object handed to it here read as "[object Object]" and failed.
    const o = x && typeof x === 'object' ? x : json(f, x, 'a JSON object');
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad(f, 'a JSON object', x);
    return o;
  }
  return String(x);
}

function coerce(f, x) {
  const v = convert(f, x);
  if (f.enum?.length && !f.enum.includes(v)) throw fail(`--${f.name} must be one of ${f.enum.join(', ')}, got ${v}`);
  return v;
}

function buildArgs(m, v, positional, flags) {
  if (positional.length > v.args.length) throw fail(`${v.name} takes ${v.args.length ? v.args.map(a => `<${a.name}>`).join(' ') : 'no arguments'}; got ${positional.length}`);
  const out = {};
  for (const f of v.flags || []) {
    const at = v.args.findIndex(a => a.name === f.name);
    const pos = at > -1 ? positional[at] : undefined;
    let x = flags[f.name] ?? flags[camel(f.name)];
    if (pos !== undefined && x !== undefined) throw fail(`give ${f.name} as an argument or --${f.name}, not both`);
    if (x === undefined) x = pos;
    if (x === undefined) {
      if (f.required) throw fail(`${v.name} needs ${at > -1 ? `<${f.name}>` : `--${f.name}`}; run: ${m.name} describe --full`);
      continue;
    }
    out[f.wire || f.name] = coerce(f, x);
  }
  return out;
}

function tokenFor(m, dry) {
  const need = m.auth?.env || [];
  if (!need.length || dry) return undefined;
  const { found, missing } = loadEnv(need);
  if (missing.length) throw fail(`set ${missing.join(', ')} in the environment or ${vaultPath()}${mintHint(m.name)}`, EXIT.AUTH);
  return found[need[0]];
}

function result(res) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content.filter(p => p?.type === 'text' || p?.resource?.text).map(p => p.text ?? p.resource.text).join('\n');
  if (res?.isError) return { ok: false, exit: EXIT.ERROR, error: oneLine(text || 'the tool reported an error', 300), data: content };
  if (res?.structuredContent !== undefined) return { ok: true, data: res.structuredContent };
  if (text) { try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; } }
  // Images and audio are what declick exists to keep out of an agent's context: report the parts, not the bytes.
  if (content.length) return { ok: true, data: content.map(p => ({ type: p.type, mimeType: p.mimeType ?? null, bytes: typeof p.data === 'string' ? p.data.length : null })) };
  return { ok: true, data: { done: true } };
}

export async function execute(m, verbName, positional, flags = {}, { client, timeout } = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run: declick describe ${m.name}` };
  const cfg = m.mcp || {};
  let args, bearer;
  try { args = buildArgs(m, v, positional, flags); bearer = tokenFor(m, !!flags.dryRun); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  const server = cfg.transport === 'http' ? cfg.url : [cfg.command, ...(cfg.args || [])].join(' ');
  if (flags.dryRun) return { ok: true, data: { transport: cfg.transport, server, tool: v.mcp.tool, arguments: args } };
  // A warm daemon already has this server running, so a hit skips the spawn that is most of what an MCP call
  // costs. No daemon, or one that never reached the tool, and the run spawns its own server exactly as before.
  if (!client && cfg.transport === 'stdio') {
    const hit = await callViaDaemon({ adapter: m.name, verb: v.name, tool: v.mcp.tool, args });
    if (hit?.result !== undefined) return { ...result(hit.result), meta: { daemon: true } };
    if (hit?.error && !hit.spawn) return { ok: false, exit: EXIT.ERROR, error: hit.error, meta: { daemon: true } };
  }
  const c = client || mcpClient({ ...cfg, bearer, timeout });
  try {
    await c.connect();
    return result(await c.callTool(v.mcp.tool, args));
  } catch (e) {
    return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message };
  } finally { c.close(); }
}
