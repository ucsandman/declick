import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { oneLine } from './describe.mjs';

export const HOME = process.env.DECLICK_HOME || join(homedir(), '.declick');
export const MANIFEST_VERSION = 1;
const ENGINES = ['openapi', 'desktop', 'mcp', 'web', 'graphql', 'postman', 'har', 'sqlite', 'cli', 'compose'];
export const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// Prefixed vendor tokens anywhere in a string, or a bare 32+ char token that is the whole string.
const SECRETISH = /\b(sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|^[A-Za-z0-9]{32,}$/;
// Fields declick generates itself: names, paths, commands and env key names are never secrets and often look like tokens.
// Lists count too (auth.env, a cli argv, a desktop find path): a key name long enough to look like a token is still a key name.
const SKIP_KEYS = new Set(['name', 'path', 'source', 'window', 'env', 'builtAt', 'baseUrl', 'as', 'find', 'read', 'click', 'returns', 'tree',
  'argv', 'command', 'goto', 'table', 'sql', 'selection', 'wire', 'example', 'default']);

// Spec text lands verbatim in SKILL.md and in describe output, so every field an agent reads back
// has to be one bounded line: no newlines, no backticks, no leading # to open a markdown heading.
const textErr = (val, what, max) => {
  if (typeof val !== 'string') return null;
  if (/[\r\n]/.test(val)) return `${what} must be one line`;
  if (val.includes('`')) return `${what} must not contain backticks`;
  if (/^\s*#/.test(val)) return `${what} must not start with #`;
  if (val.length > max) return `${what} must be ${max} chars or fewer`;
  return null;
};

export const assertName = (name, what = 'adapter name') => {
  if (!KEBAB.test(String(name))) throw Object.assign(new Error(`bad ${what} ${JSON.stringify(name)}: must be kebab-case`), { exit: 1 });
  return name;
};

export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest must be an object'];
  if (!KEBAB.test(m.name || '')) errs.push(`name ${JSON.stringify(m.name)} must be kebab-case`);
  if (!ENGINES.includes(m.engine)) errs.push(`engine must be one of ${ENGINES.join(', ')}`);
  if (typeof m.source !== 'string' || !m.source) errs.push('source required');
  const text = (val, what, max) => { const e = textErr(val, what, max); if (e) errs.push(e); };
  text(m.source, 'source', 500); text(m.window, 'window', 500); text(m.baseUrl, 'baseUrl', 500);
  if (!Array.isArray(m.verbs) || m.verbs.length === 0) errs.push('verbs must be a non-empty array');
  else m.verbs.forEach((v, i) => {
    if (!KEBAB.test(v.name || '')) errs.push(`verbs[${i}].name must be kebab-case`);
    if (typeof v.description !== 'string' || !v.description) errs.push(`verbs[${i}].description required`);
    else text(v.description, `verbs[${i}].description`, 200);
    if (typeof v.mutating !== 'boolean') errs.push(`verbs[${i}].mutating must be boolean`);
    if (!Array.isArray(v.args)) errs.push(`verbs[${i}].args must be an array`);
    else v.args.forEach((a, j) => { text(a?.name, `verbs[${i}].args[${j}].name`, 100); text(a?.description, `verbs[${i}].args[${j}].description`, 200); });
    if (Array.isArray(v.flags)) v.flags.forEach((f, j) => { text(f?.name, `verbs[${i}].flags[${j}].name`, 100); text(f?.description, `verbs[${i}].flags[${j}].description`, 200); });
    if (v.returns) { text(v.returns.rowsPath, `verbs[${i}].returns.rowsPath`, 100); (v.returns.fields || []).forEach((f, j) => text(f?.name, `verbs[${i}].returns.fields[${j}].name`, 100)); }
  });
  if (!m.auth || !Array.isArray(m.auth.env)) errs.push('auth.env must be an array of key names');
  else m.auth.env.forEach((e, i) => text(e, `auth.env[${i}]`, 100));
  const scan = (obj, path) => {
    for (const [k, val] of Object.entries(obj || {})) {
      if (SKIP_KEYS.has(k) && (typeof val === 'string' || Array.isArray(val))) continue;
      if (typeof val === 'string' && SECRETISH.test(val)) errs.push(`possible secret at ${path}.${k}`);
      else if (val && typeof val === 'object') scan(val, `${path}.${k}`);
    }
  };
  scan(m, 'manifest');
  return errs;
}

// Real specs write descriptions no one bounded: multi-sentence, backticked, longer than an agent should
// read back. Collapse to one line, then prefer the first sentence; only a sentence that's still too long
// gets a hard cut, backed off to the last space so no word is sliced in half.
function normText(s, max) {
  if (typeof s !== 'string') return s;
  const flat = oneLine(s).replace(/^\s*#+\s*/, '');
  // A period between digits (2.5km, v3.1) is not a sentence end.
  const sentence = (flat.match(/^(?:[^.!?]|\.(?=\d))*[.!?](?!\d)/)?.[0] ?? flat).trim();
  if (sentence.length <= max) return sentence;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut).trimEnd();
}

// Applied before validateManifest on every save, so a spec that writes long or messy text still compiles;
// hand-edited manifests are still caught by the (unchanged) lint and validate limits.
export function normalizeManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.verbs)) return m;
  const field = (o, max) => (o && typeof o === 'object' && 'description' in o ? { ...o, description: normText(o.description, max) } : o);
  const verbs = m.verbs.map(v => (v && typeof v === 'object') ? {
    ...v,
    description: normText(v.description, 80),
    args: Array.isArray(v.args) ? v.args.map(a => field(a, 200)) : v.args,
    flags: Array.isArray(v.flags) ? v.flags.map(f => field(f, 200)) : v.flags,
    returns: v.returns && typeof v.returns === 'object' && Array.isArray(v.returns.fields)
      ? { ...v.returns, fields: v.returns.fields.map(f => field(f, 200)) } : v.returns,
  } : v);
  return { ...m, verbs };
}

export function manifestDir(name) { return join(HOME, assertName(name)); }

export function saveManifest(m) {
  m = normalizeManifest(m);
  const errs = validateManifest(m);
  if (errs.length) throw new Error(`invalid manifest: ${errs.join('; ')}`);
  const dir = manifestDir(m.name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'manifest.json');
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ manifestVersion: MANIFEST_VERSION, ...m }, null, 2) + '\n');
  renameSync(tmp, p);
  return p;
}

export function loadManifest(name) {
  const p = join(manifestDir(name), 'manifest.json');
  if (!existsSync(p)) throw Object.assign(new Error(`no adapter named ${name}; run: declick list`), { exit: 2 });
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw Object.assign(new Error(`${p} is not valid JSON (${e.message}); run: declick build ${name}`), { exit: 1 }); }
}

export function listManifests() {
  if (!existsSync(HOME)) return [];
  return readdirSync(HOME, { withFileTypes: true })
    .filter(d => d.isDirectory() && KEBAB.test(d.name) && existsSync(join(HOME, d.name, 'manifest.json')))
    .map(d => d.name).sort();
}
