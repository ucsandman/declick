export const EXIT = { OK: 0, ERROR: 1, NOT_FOUND: 2, BLOCKED: 3, AUTH: 4 };

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
  return { data: pick(data, fields), meta: { count: data === undefined ? 0 : 1, truncated: false } };
}

function asText(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.map(r => (r && typeof r === 'object')
    ? Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')
    : String(r)).join('\n');
}

export function emit(result, { json = !process.stdout.isTTY, fields, limit } = {}) {
  if (!result.ok) {
    const exit = result.exit ?? EXIT.ERROR;
    const body = json ? JSON.stringify({ ok: false, error: result.error, exit }) : `error: ${result.error}`;
    return { text: body, exit };
  }
  const { data, meta } = shape(result.data, { fields, limit });
  const text = json ? JSON.stringify({ ok: true, data, meta }) : asText(data) + (meta.truncated ? `\n(${meta.count} total, showing ${Array.isArray(data) ? data.length : 1})` : '');
  return { text, exit: EXIT.OK };
}

export function parseFlags(argv) {
  const positional = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
  }
  if (typeof flags.fields === 'string') flags.fields = flags.fields.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.limit !== undefined) flags.limit = Number(flags.limit);
  return { positional, flags };
}
