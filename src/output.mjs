export const EXIT = { OK: 0, ERROR: 1, NOT_FOUND: 2, BLOCKED: 3, AUTH: 4 };

// Contract flags that never take a value. Everything else takes the next token unless it starts with --.
export const BOOLS = new Set(['json', 'dryRun', 'full', 'help', 'version', 'open', 'force']);
export const RESERVED = ['json', 'fields', 'limit', 'dry-run', 'full', 'help'];
export const camel = s => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });

function pick(obj, fields) {
  if (!fields || !fields.length || !obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(fields.filter(f => f in obj).map(f => [f, obj[f]]));
}

export function shape(data, { fields, limit } = {}) {
  if (Array.isArray(data)) {
    const count = data.length;
    const lim = Number.isFinite(limit) ? limit : 50;
    const rows = data.slice(0, lim).map(r => pick(r, fields));
    return { data: rows, meta: { count, truncated: count > lim } };
  }
  return { data: pick(data, fields) ?? null, meta: { count: data === undefined ? 0 : 1, truncated: false } };
}

function asText(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.map(r => (r && typeof r === 'object')
    ? Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')
    : String(r)).join('\n');
}

export function emit(result, { json = !process.stdout.isTTY, fields, limit, dryRun } = {}) {
  if (!result.ok) {
    const exit = result.exit ?? EXIT.ERROR;
    const body = { ok: false, error: result.error, exit, ...(result.data !== undefined ? { data: result.data } : {}) };
    return { text: json ? JSON.stringify(body) : `error: ${result.error}${result.data !== undefined ? '\n' + asText(result.data) : ''}`, exit };
  }
  // A dry-run payload is a preview, not rows: never project it away with --fields.
  const { data, meta } = shape(result.data, dryRun ? { limit } : { fields, limit });
  if (dryRun) meta.dryRun = true;
  const text = json ? JSON.stringify({ ok: true, data, meta }) : asText(data) + (meta.truncated ? `\n(${meta.count} total, showing ${Array.isArray(data) ? data.length : 1})` : '');
  return { text, exit: EXIT.OK };
}

// Accepts --k v, --k=v, --bool, --bool true|false, --no-bool, repeated --k (becomes an array), and -- to end flags.
export function parseFlags(argv) {
  const positional = []; const flags = {}; let end = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' && !end) { end = true; continue; }
    if (end || !a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    let raw = eq > -1 ? a.slice(2, eq) : a.slice(2);
    let val = eq > -1 ? a.slice(eq + 1) : undefined;
    if (raw.startsWith('no-') && BOOLS.has(camel(raw.slice(3)))) { raw = raw.slice(3); val = 'false'; }
    const key = camel(raw);
    const next = argv[i + 1];
    if (val === undefined) {
      if (BOOLS.has(key)) { if (next === 'true' || next === 'false') { val = next; i++; } else val = true; }
      else if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
      else val = true;
    }
    if (BOOLS.has(key)) val = val === true || val === 'true' || val === '1';
    flags[key] = key in flags && !BOOLS.has(key) ? [].concat(flags[key], val) : val;
  }
  if (typeof flags.fields === 'string') flags.fields = flags.fields.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.limit === true) delete flags.limit;
  else if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 1) throw fail(`--limit must be a positive integer, got ${flags.limit}`);
    flags.limit = n;
  }
  return { positional, flags };
}
