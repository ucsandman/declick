import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.DECLICK_HOME || join(homedir(), '.declick');
const ENGINES = ['openapi', 'desktop', 'mcp', 'web'];
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SECRETISH = /^(sk|pk|ghp|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}|[A-Za-z0-9_-]{32,}$/;

export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest must be an object'];
  if (!KEBAB.test(m.name || '')) errs.push('name must be kebab-case');
  if (!ENGINES.includes(m.engine)) errs.push(`engine must be one of ${ENGINES.join(', ')}`);
  if (typeof m.source !== 'string' || !m.source) errs.push('source required');
  if (!Array.isArray(m.verbs) || m.verbs.length === 0) errs.push('verbs must be a non-empty array');
  else m.verbs.forEach((v, i) => {
    if (!KEBAB.test(v.name || '')) errs.push(`verbs[${i}].name must be kebab-case`);
    if (typeof v.description !== 'string' || !v.description) errs.push(`verbs[${i}].description required`);
    if (typeof v.mutating !== 'boolean') errs.push(`verbs[${i}].mutating must be boolean`);
    if (!Array.isArray(v.args)) errs.push(`verbs[${i}].args must be an array`);
  });
  if (!m.auth || !Array.isArray(m.auth.env)) errs.push('auth.env must be an array of key names');
  const scan = (obj, path) => {
    for (const [k, val] of Object.entries(obj || {})) {
      if (typeof val === 'string' && SECRETISH.test(val)) errs.push(`possible secret at ${path}.${k}`);
      else if (val && typeof val === 'object') scan(val, `${path}.${k}`);
    }
  };
  scan(m, 'manifest');
  return errs;
}

export function manifestDir(name) { return join(HOME, name); }

export function saveManifest(m) {
  const errs = validateManifest(m);
  if (errs.length) throw new Error(`invalid manifest: ${errs.join('; ')}`);
  const dir = manifestDir(m.name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'manifest.json');
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  return p;
}

export function loadManifest(name) {
  const p = join(manifestDir(name), 'manifest.json');
  if (!existsSync(p)) throw Object.assign(new Error(`no adapter named ${name}`), { exit: 2 });
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listManifests() {
  if (!existsSync(HOME)) return [];
  return readdirSync(HOME, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(HOME, d.name, 'manifest.json')))
    .map(d => d.name).sort();
}
