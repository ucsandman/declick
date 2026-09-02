import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.DECLICK_HOME || join(homedir(), '.declick');
export const MANIFEST_VERSION = 1;
const ENGINES = ['openapi', 'desktop', 'mcp', 'web'];
export const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// Prefixed vendor tokens anywhere in a string, or a bare 32+ char token that is the whole string.
const SECRETISH = /\b(sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|^[A-Za-z0-9]{32,}$/;
// Fields declick generates itself: names, paths and env key names are never secrets and often look like tokens.
const SKIP_KEYS = new Set(['name', 'path', 'source', 'window', 'env', 'builtAt', 'baseUrl', 'as', 'find', 'read', 'click', 'returns', 'tree']);

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
  if (!Array.isArray(m.verbs) || m.verbs.length === 0) errs.push('verbs must be a non-empty array');
  else m.verbs.forEach((v, i) => {
    if (!KEBAB.test(v.name || '')) errs.push(`verbs[${i}].name must be kebab-case`);
    if (typeof v.description !== 'string' || !v.description) errs.push(`verbs[${i}].description required`);
    else if (/[\r\n`]/.test(v.description)) errs.push(`verbs[${i}].description must be one line without backticks`);
    if (typeof v.mutating !== 'boolean') errs.push(`verbs[${i}].mutating must be boolean`);
    if (!Array.isArray(v.args)) errs.push(`verbs[${i}].args must be an array`);
  });
  if (!m.auth || !Array.isArray(m.auth.env)) errs.push('auth.env must be an array of key names');
  const scan = (obj, path) => {
    for (const [k, val] of Object.entries(obj || {})) {
      if (SKIP_KEYS.has(k) && typeof val === 'string') continue;
      if (typeof val === 'string' && SECRETISH.test(val)) errs.push(`possible secret at ${path}.${k}`);
      else if (val && typeof val === 'object') scan(val, `${path}.${k}`);
    }
  };
  scan(m, 'manifest');
  return errs;
}

export function manifestDir(name) { return join(HOME, assertName(name)); }

export function saveManifest(m) {
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
