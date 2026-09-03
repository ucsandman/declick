export const EXIT = { OK: 0, ERROR: 1, NOT_FOUND: 2, BLOCKED: 3, AUTH: 4 };

// Contract flags that never take a value. Everything else takes the next token unless it starts with --.
export const BOOLS = new Set(['json', 'dryRun', 'full', 'help', 'version', 'open', 'force', 'verbose', 'curl', 'defaults']);
export const RESERVED = ['json', 'fields', 'limit', 'rows', 'where', 'dry-run', 'full', 'help',
  'header', 'output', 'content-type', 'base-url', 'server', 'retry', 'timeout', 'verbose', 'curl', 'body-file', 'each', 'defaults', 'max-bytes', 'cache'];
export const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });

// Levenshtein distance, so a typo costs one more command instead of a hunt through describe.
const editDistance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
// A candidate that starts with the typed word (or at least contains it) is the obvious match even past edit
// distance 3 (list -> list-notes), and outranks a same-distance candidate that shares no substring at all.
export const nearest = (name, candidates = []) => {
  const n = String(name);
  const rank = c => (n && c.startsWith(n)) ? 0 : (n && c.includes(n)) ? 1 : 2;
  return [...new Set(candidates)].map(String)
    .map(c => [c, rank(c), editDistance(n, c)])
    .filter(([, r, d]) => r < 2 || d <= 3)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]))
    .slice(0, 3).map(([c]) => c);
};

// A dotted path resolves per row; a miss is undefined so a real undefined value still counts as a hit.
const at = (obj, path) => {
  let cur = obj;
  for (const k of path.split('.')) { if (!cur || typeof cur !== 'object' || !(k in cur)) return undefined; cur = cur[k]; }
  return { v: cur };
};
const keysOf = o => (o && typeof o === 'object' ? Object.keys(o) : []).slice(0, 30).join(', ');

// data/items/etc are unambiguous row containers; anything else only counts if the array is nearly the whole
// object and everything beside it looks like pagination, so a 90-field resource with one array property
// (GitHub's repository shape and its topics) never gets treated as a page of rows. Shared with the openapi,
// mcp and postman engines so the manifest's compiled rowsPath and this runtime auto-detect agree.
export const ROWS_NAMES = new Set(['data', 'items', 'results', 'rows', 'entries', 'records', 'edges', 'nodes', 'values', 'list', 'hits', 'objects']);
export const PAGINATION_ISH = /^(cursor|next|next_cursor|total|count|page|has_more|object|url|limit|offset)$/;
export function rowsPropertyOf(props) {
  const lists = props.filter(p => p.isList);
  if (lists.length !== 1) return null;
  const [only] = lists;
  const names = props.map(p => p.name);
  const isRows = ROWS_NAMES.has(only.name) || (names.length <= 3 && names.filter(n => n !== only.name).every(n => PAGINATION_ISH.test(n)));
  return isRows ? only.name : null;
}

// --where k=v filters rows before --fields and --limit. The two-character operators are matched before the
// one-character ones so k>=5 is not read as k > "=5", and the leftmost operator wins, so a regex may hold an
// = of its own. Conditions split on commas the way --fields does, so a regex cannot contain one.
const OPS = [['!=', 'ne'], ['>=', 'ge'], ['<=', 'le'], ['=*', 'has'], ['~', 're'], ['>', 'gt'], ['<', 'lt'], ['=', 'eq']];
const WHERE_FORMS = 'k=v, k!=v, k~re, k>n, k>=n, k<n, k<=n, or k=* for present';
// A value typed on a command line is always a string; a number compares as a number and a bool as a bool, so
// --where id=7 finds 7 and --where done=true finds the boolean, and everything else is an exact string match.
const asNum = x => { const s = String(x).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const sameValue = (v, want) => typeof v === 'number' ? asNum(want) !== null && v === asNum(want)
  : v !== null && typeof v === 'object' ? JSON.stringify(v) === want : String(v) === want;

export function parseWhere(spec) {
  const conds = [];
  for (const raw of [].concat(spec ?? [])) {
    if (raw === true) throw fail(`--where needs a condition: ${WHERE_FORMS}`);
    for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
      let c = null;
      for (let i = 1; i < part.length && !c; i++) for (const [tok, op] of OPS) if (part.startsWith(tok, i)) { c = { key: part.slice(0, i), op, val: part.slice(i + tok.length) }; break; }
      if (!c) throw fail(`--where ${part} needs an operator: ${WHERE_FORMS}`);
      if (c.op === 're') { try { c.re = new RegExp(c.val, 'i'); } catch (e) { throw fail(`--where ${part} is not a valid regex (${e.message})`); } }
      conds.push(c);
    }
  }
  return conds;
}

// Every condition has to hold. A row with no value at the path fails a comparison instead of throwing: a list
// where only half the rows carry a field is something to filter on, not a run to stop.
function keeps(row, c) {
  const hit = at(row, c.key);
  const v = hit ? hit.v : undefined;
  if (c.op === 'has') return v !== undefined && v !== null;
  if (c.op === 're') return v !== undefined && v !== null && c.re.test(v && typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (c.op === 'eq') return sameValue(v, c.val);
  if (c.op === 'ne') return !sameValue(v, c.val);
  const a = asNum(v), b = asNum(c.val);
  if (a === null || b === null) return false;
  return c.op === 'gt' ? a > b : c.op === 'ge' ? a >= b : c.op === 'lt' ? a < b : a <= b;
}

function pick(obj, fields) {
  if (!fields || !fields.length || !obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(fields.map(f => [f, at(obj, f)]).filter(([, h]) => h).map(([f, h]) => [f, h.v]));
}

// A field list nothing matches is a typo the caller has to see; a partial miss is worth reporting, not failing.
function missing(rows, fields) {
  if (!fields?.length || !rows.length) return undefined;
  const miss = fields.filter(f => !rows.some(r => at(r, f)));
  if (miss.length === fields.length) throw fail(`no field matched ${fields.join(', ')}; available: ${keysOf(rows[0])}`);
  return miss.length ? miss : undefined;
}

function project(rows, fields, limit, conds = []) {
  const of = rows.length;
  // --where runs first: --limit caps what matched, and meta.count is the size of the answer, not of the page.
  const matched = conds.length ? rows.filter(r => conds.every(c => keeps(r, c))) : rows;
  const count = matched.length;
  const lim = Number.isFinite(limit) ? limit : 50;
  const kept = matched.slice(0, lim);
  const unknown = missing(kept, fields);
  return { data: kept.map(r => pick(r, fields)), meta: { count, truncated: count > lim, ...(conds.length ? { where: { matched: count, of } } : {}), ...(unknown ? { unknownFields: unknown } : {}) } };
}

// Row arrays live inside the body on most real APIs, so the cursors and totals beside them go to meta.extra.
function unwrap(body, path, rows, fields, limit, conds) {
  const { data, meta } = project(rows, fields, limit, conds);
  const head = path.split('.')[0];
  return { data, meta: { ...meta, rows: path, extra: Object.fromEntries(Object.entries(body).filter(([k]) => k !== head)) } };
}

export function shape(data, { fields, limit, rows, auto, where, verb } = {}) {
  const conds = parseWhere(where);
  if (Array.isArray(data)) return project(data, fields, limit, conds);
  if (rows && typeof rows !== 'string') throw fail('--rows needs a dotted path, e.g. --rows items');
  // Fields that already resolve on the object itself (top level or dotted) are the answer: an auto rows path,
  // whether typed with --rows or compiled from the manifest's returns.rowsPath, never unwraps them away.
  const onObject = auto && fields?.length && data && typeof data === 'object' && fields.some(f => at(data, f));
  if (rows && !onObject) {
    const hit = at(data, rows);
    if (!hit || !Array.isArray(hit.v)) throw fail(`no rows array at ${rows}; available: ${keysOf(data)}`);
    return unwrap(data, rows, hit.v, fields, limit, conds);
  }
  // Only a response body gets its rows guessed, and only for a caller that asked to filter: a manifest or a
  // describe payload is the resource itself, and its verbs array is not a page of rows.
  if (!onObject && auto && (fields?.length || limit !== undefined || conds.length) && data && typeof data === 'object') {
    const props = Object.keys(data).map(k => ({ name: k, isList: Array.isArray(data[k]) }));
    const rowsProp = rowsPropertyOf(props);
    if (rowsProp) return unwrap(data, rowsProp, data[rowsProp], fields, limit, conds);
  }
  // Every list-shaped answer was handled above, so a condition still standing here has no rows to filter.
  if (conds.length) throw fail(`where applies to lists; ${verb || 'this call'} returns an object`);
  const unknown = missing(data === undefined || data === null ? [] : [data], fields);
  return { data: pick(data, fields) ?? null, meta: { count: data === undefined ? 0 : 1, truncated: false, ...(unknown ? { unknownFields: unknown } : {}) } };
}

function asText(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.map(r => (r && typeof r === 'object')
    ? Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')
    : String(r)).join('\n');
}

// A ceiling on the bytes one envelope's data may carry, so a wide list cannot flood an agent's context before it
// has read a single field name. Arrays drop tail items, strings are sliced, and an object keeps every key: its
// biggest values go first, each replaced by its own size, so the shape needed to write --fields survives any cap.
export const jsonBytes = x => Buffer.byteLength(JSON.stringify(x) ?? 'null');
export const CAP_HINT = 'add --fields or --limit; declick describe <name> --verb <verb> shows the shape';
const capNote = n => `<${n} bytes; add --fields or --limit>`;

export function capData(data, max) {
  if (Array.isArray(data)) {
    // Sized once, not once per candidate slice: a JSON array is its items plus one comma between each.
    const sizes = data.map(jsonBytes);
    let used = 2, n = 0;
    while (n < data.length && used + sizes[n] + (n ? 1 : 0) <= max) { used += sizes[n] + (n ? 1 : 0); n++; }
    const kept = data.slice(0, Math.max(n, 1));
    // A single item over the cap on its own still has to come back, so it is capped in turn rather than dropped.
    return kept.length === 1 && jsonBytes(kept) > max ? [capData(kept[0], Math.max(max - 2, 1))] : kept;
  }
  if (typeof data === 'string') {
    let cut = data.slice(0, Math.max(max - 2, 0));
    while (cut.length && jsonBytes(cut) > max) cut = cut.slice(0, cut.length - 1);
    return cut;
  }
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  // Biggest first: replacing the one value that is most of the payload is what leaves the rest readable.
  for (const [k, n] of Object.entries(out).map(([k, v]) => [k, jsonBytes(v)]).sort((a, b) => b[1] - a[1])) {
    if (jsonBytes(out) <= max) break;
    out[k] = capNote(n);
  }
  return out;
}

export function emit(result, { json = !process.stdout.isTTY, fields, limit, rows, auto, dryRun, where, verb, maxBytes = 0 } = {}) {
  if (!result.ok) {
    const exit = result.exit ?? EXIT.ERROR;
    const body = { ok: false, error: result.error, exit, ...(result.data !== undefined ? { data: result.data } : {}), ...(result.meta ? { meta: result.meta } : {}) };
    return { text: json ? JSON.stringify(body) : `error: ${result.error}${result.data !== undefined ? '\n' + asText(result.data) : ''}`, exit };
  }
  // A dry-run payload is a preview, not rows: never project it away with --fields.
  let shaped;
  try { shaped = shape(result.data, dryRun ? { limit } : { fields, limit, rows, auto, where, verb }); }
  catch (e) { return emit({ ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR }, { json }); }
  let { data, meta } = shaped;
  // What the engine learned on the wire (status, retries, request/response, curl) rides beside the row counts.
  if (result.meta) Object.assign(meta, result.meta);
  if (dryRun) meta.dryRun = true;
  // The cap is the last thing to touch data: it measures what --where, --rows, --fields and --limit left behind.
  if (maxBytes > 0 && !dryRun) {
    const bytes = jsonBytes(data);
    if (bytes > maxBytes) { data = capData(data, maxBytes); meta.truncated = true; meta.capped = { bytes, max: maxBytes, hint: CAP_HINT }; }
  }
  const text = json ? JSON.stringify({ ok: true, data, meta }) : asText(data) + (meta.truncated ? `\n(${meta.count} total, showing ${Array.isArray(data) ? data.length : 1})` : '');
  return { text, exit: EXIT.OK };
}

// Accepts --k v, --k=v, --bool, --bool true|false, --no-bool, repeated --k (becomes an array), and -- to end flags.
// bools is a parameter because the management CLI has boolean flags of its own (--schema, --example,
// --install, --interactive): its COMMANDS table is the source of truth, and a bare one must not eat a token.
export function parseFlags(argv, bools = BOOLS) {
  const positional = []; const flags = {}; let end = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' && !end) { end = true; continue; }
    if (end || !a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    let raw = eq > -1 ? a.slice(2, eq) : a.slice(2);
    let val = eq > -1 ? a.slice(eq + 1) : undefined;
    if (raw.startsWith('no-') && bools.has(camel(raw.slice(3)))) { raw = raw.slice(3); val = 'false'; }
    const key = camel(raw);
    const next = argv[i + 1];
    if (val === undefined) {
      if (bools.has(key)) { if (next === 'true' || next === 'false') { val = next; i++; } else val = true; }
      else if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
      else val = true;
    }
    if (bools.has(key)) val = val === true || val === 'true' || val === '1';
    flags[key] = key in flags && !bools.has(key) ? [].concat(flags[key], val) : val;
  }
  if (typeof flags.fields === 'string') flags.fields = flags.fields.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.limit === true) delete flags.limit;
  else if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 1) throw fail(`--limit must be a positive integer, got ${flags.limit}`);
    flags.limit = n;
  }
  // A bare --max-bytes or --cache is a typo, not a silent default; both take a whole number and 0 turns them off.
  for (const [key, flag, unit] of [['maxBytes', 'max-bytes', 'a byte count'], ['cache', 'cache', 'a number of seconds']]) {
    if (flags[key] === undefined) continue;
    const n = flags[key] === true ? NaN : Number(flags[key]);
    if (!Number.isInteger(n) || n < 0) throw fail(`--${flag} needs ${unit}: 0 or a positive integer, got ${flags[key] === true ? 'nothing' : flags[key]}`);
    flags[key] = n;
  }
  return { positional, flags };
}
