import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { EXIT, RESERVED, camel } from '../output.mjs';

const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
// Identifiers here always come from sqlite_master/table_info or a manifest built from it, never from a caller.
const q = id => `"${String(id).replace(/"/g, '""')}"`;

// A real table has columns called limit, fields or output; the flag is renamed and wire keeps the column name,
// the same way every other engine handles it, so one such column cannot make the whole table unaddressable.
const flagName = n => (RESERVED.includes(n) ? `param-${n}` : n);
const colFlag = (c, description, required) => ({ name: flagName(c.name), ...(flagName(c.name) !== c.name ? { wire: c.name } : {}), description: description.slice(0, 80), required, type: c.type });

const typeOf = t => {
  const s = String(t || '').toUpperCase();
  if (/INT/.test(s)) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(s)) return 'string';
  if (/REAL|FLOA|DOUB/.test(s)) return 'number';
  if (/BOOL/.test(s)) return 'boolean';
  return 'string';
};

function pathOf(source) {
  const p = String(source || '').replace(/^sqlite:/, '');
  if (!p) throw fail('usage: declick add sqlite:<path>');
  return resolve(p);
}

// Tables and views only, in the tbl_name/pk shape PRAGMA table_info gives back.
function introspect(path) {
  if (!existsSync(path)) throw fail(`no sqlite file at ${path}`, EXIT.NOT_FOUND);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const objs = db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
    return objs.map(o => {
      const info = db.prepare(`PRAGMA table_info(${q(o.name)})`).all();
      const columns = info.map(c => ({ name: c.name, type: typeOf(c.type), notnull: !!c.notnull, hasDefault: c.dflt_value !== null, pkOrder: c.pk }));
      return { table: o.name, kind: o.type, columns };
    });
  } finally { db.close(); }
}

// Explicit PRIMARY KEY columns, in declared order; a rowid table with none falls back to the implicit rowid;
// a view has no key at all, so its first column stands in as a best-effort identifier for get-<view>.
function pkOf(columns, kind) {
  const explicit = columns.filter(c => c.pkOrder > 0).sort((a, b) => a.pkOrder - b.pkOrder).map(c => c.name);
  if (explicit.length) return explicit;
  if (kind === 'table') return ['rowid'];
  return columns[0] ? [columns[0].name] : [];
}

export async function compile(source, { name } = {}) {
  const path = pathOf(source);
  const objs = introspect(path);
  if (!objs.length) throw fail(`${path} has no tables or views`);
  const dbName = name || kebab(basename(path).replace(/\.[^.]+$/, '')) || 'db';
  const verbs = [];
  for (const { table, kind, columns } of objs) {
    const vt = kebab(table);
    const pk = pkOf(columns, kind);
    const pkCols = columns.filter(c => pk.includes(c.name));
    const nonPk = columns.filter(c => !pk.includes(c.name));
    const fields = columns.map(c => ({ name: c.name, type: c.type }));
    const sqlite = k => ({ table, kind: k, pk, columns: fields });

    verbs.push({
      name: `list-${vt}`, description: `List rows from ${table}`.slice(0, 80), mutating: false, args: [],
      returns: { shape: 'array', fields },
      flags: [
        ...columns.map(c => colFlag(c, `filter where ${c.name} equals value`, false)),
        { name: 'order', description: 'order by this column', required: false, type: 'string', enum: columns.map(c => c.name) },
        { name: 'desc', description: 'sort descending', required: false, type: 'boolean' },
      ],
      sqlite: sqlite('list'),
    });
    verbs.push({
      name: `get-${vt}`, description: `Get one row from ${table} by primary key`.slice(0, 80), mutating: false,
      args: pkCols.length ? pkCols.map(c => ({ name: c.name, required: true, type: c.type })) : [{ name: 'rowid', required: true, type: 'integer' }],
      returns: { shape: 'object', fields }, flags: [], sqlite: sqlite('get'),
    });
    if (kind !== 'table') continue;
    verbs.push({
      name: `insert-${vt}`, description: `Insert a row into ${table}`.slice(0, 80), mutating: true, args: [],
      flags: nonPk.map(c => colFlag(c, `${c.name} value`, c.notnull && !c.hasDefault)),
      sqlite: sqlite('insert'),
    });
    verbs.push({
      name: `update-${vt}`, description: `Update a row in ${table} by primary key`.slice(0, 80), mutating: true,
      args: pkCols.length ? pkCols.map(c => ({ name: c.name, required: true, type: c.type })) : [{ name: 'rowid', required: true, type: 'integer' }],
      flags: nonPk.map(c => colFlag(c, `new ${c.name} value`, false)),
      sqlite: sqlite('update'),
    });
    verbs.push({
      name: `delete-${vt}`, description: `Delete a row from ${table} by primary key`.slice(0, 80), mutating: true,
      args: pkCols.length ? pkCols.map(c => ({ name: c.name, required: true, type: c.type })) : [{ name: 'rowid', required: true, type: 'integer' }],
      flags: [], sqlite: sqlite('delete'),
    });
  }
  verbs.push({
    name: 'query', description: 'Run a read-only SELECT or WITH query', mutating: false, args: [],
    flags: [
      { name: 'sql', description: 'SELECT or WITH statement', required: true, type: 'string' },
      { name: 'param', description: 'bind value for each ? placeholder, repeatable', required: false, type: 'string' },
    ],
    sqlite: { table: null, kind: 'query', pk: [], columns: [] },
  });
  return { name: dbName, engine: 'sqlite', source: `sqlite:${path}`, builtAt: new Date().toISOString(), baseUrl: `sqlite:${path}`, auth: { env: [] }, verbs };
}

// Builds { sql, params, mode } without touching the database, so dry-run and the real run share one path.
function buildStatement(v, positional, flags) {
  const { table, kind, pk, columns } = v.sqlite;
  const val = f => { const x = flags[f] ?? flags[camel(f)]; return x === true ? undefined : x; };
  if (kind === 'query') {
    const sql = String(val('sql') ?? '').trim();
    if (!/^(select|with)\b/i.test(sql)) throw fail('query --sql must start with SELECT or WITH');
    const raw = flags.param;
    return { sql, params: raw === undefined ? [] : [].concat(raw), mode: 'rows' };
  }
  const pkNames = pk.length ? pk : ['rowid'];
  if (['get', 'update', 'delete'].includes(kind) && positional.length < pkNames.length) {
    throw fail(`${v.name} needs ${pkNames.join(' ')}`);
  }
  const pkVals = pkNames.map((_, i) => positional[i]);
  if (kind === 'list') {
    const where = []; const params = [];
    for (const c of columns) { const x = val(flagName(c.name)); if (x !== undefined) { where.push(`${q(c.name)} = ?`); params.push(x); } }
    let sql = `SELECT * FROM ${q(table)}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    const order = val('order');
    if (order !== undefined) {
      if (!columns.some(c => c.name === order)) throw fail(`--order must be one of ${columns.map(c => c.name).join(', ')}`);
      sql += ` ORDER BY ${q(order)}${flags.desc ? ' DESC' : ''}`;
    }
    // --limit is the output contract's flag: shape() in src/output.mjs slices and reports the true count and
    // truncated. Cutting the rows here instead would report a page size as the total, with truncated always false.
    return { sql, params, mode: 'rows' };
  }
  if (kind === 'get') {
    return { sql: `SELECT * FROM ${q(table)} WHERE ${pkNames.map(n => `${q(n)} = ?`).join(' AND ')} LIMIT 1`, params: pkVals, mode: 'row' };
  }
  const nonPk = columns.filter(c => !pk.includes(c.name));
  if (kind === 'insert') {
    const cols = []; const params = [];
    for (const c of nonPk) { const x = val(flagName(c.name)); if (x !== undefined) { cols.push(c.name); params.push(x); } }
    const missing = (v.flags || []).filter(f => f.required && val(f.name) === undefined);
    if (missing.length) throw fail(`${v.name} needs ${missing.map(f => `--${f.name}`).join(' ')}`);
    if (!cols.length) throw fail(`${v.name} needs at least one column flag`);
    return { sql: `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params, mode: 'write' };
  }
  if (kind === 'update') {
    const sets = []; const params = [];
    for (const c of nonPk) { const x = val(flagName(c.name)); if (x !== undefined) { sets.push(`${q(c.name)} = ?`); params.push(x); } }
    if (!sets.length) throw fail(`${v.name} needs at least one column flag to update`);
    return { sql: `UPDATE ${q(table)} SET ${sets.join(', ')} WHERE ${pkNames.map(n => `${q(n)} = ?`).join(' AND ')}`, params: [...params, ...pkVals], mode: 'write' };
  }
  return { sql: `DELETE FROM ${q(table)} WHERE ${pkNames.map(n => `${q(n)} = ?`).join(' AND ')}`, params: pkVals, mode: 'write' };
}

export async function execute(m, verbName, positional, flags = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run describe` };
  let stmt;
  try { stmt = buildStatement(v, positional, flags); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  if (flags.dryRun) return { ok: true, data: { sql: stmt.sql, params: stmt.params } };
  const path = m.baseUrl.replace(/^sqlite:/, '');
  if (!existsSync(path)) return { ok: false, exit: EXIT.NOT_FOUND, error: `no sqlite file at ${path}` };
  let db;
  try { db = new DatabaseSync(path, { readOnly: !v.mutating }); }
  catch (e) { return { ok: false, exit: EXIT.ERROR, error: e.message }; }
  try {
    const prepared = db.prepare(stmt.sql);
    if (stmt.mode === 'rows') return { ok: true, data: prepared.all(...stmt.params) };
    if (stmt.mode === 'row') {
      const row = prepared.get(...stmt.params);
      return row ? { ok: true, data: row } : { ok: false, exit: EXIT.NOT_FOUND, error: `no row in ${v.sqlite.table} matching ${positional.join(', ')}` };
    }
    const info = prepared.run(...stmt.params);
    if (['update', 'delete'].includes(v.sqlite.kind) && info.changes === 0) {
      return { ok: false, exit: EXIT.NOT_FOUND, error: `no row in ${v.sqlite.table} matching ${positional.join(', ')}` };
    }
    return { ok: true, data: { changes: info.changes, lastInsertRowid: info.lastInsertRowid } };
  } catch (e) { return { ok: false, exit: EXIT.ERROR, error: e.message }; }
  finally { db.close(); }
}
