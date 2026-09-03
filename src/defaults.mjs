import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, camel, RESERVED, EXIT } from './output.mjs';

// HOME and the name guard are copied from manifest.mjs on purpose: describe.mjs reads defaults so it can show
// them, and manifest.mjs already imports describe.mjs, so importing manifest.mjs here would close a cycle
// across the three files every command loads.
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });

// Beside manifest.json, never inside it: declick build rewrites the manifest and must not clobber what a user set.
export const defaultsPath = name => join(home(), String(name), 'defaults.json');

export function loadDefaults(name) {
  if (!KEBAB.test(String(name))) return null;
  const p = defaultsPath(name);
  if (!existsSync(p)) return null;
  let file;
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw fail(`${p} is not valid JSON (${e.message}); run: declick defaults ${name} --clear`); }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw fail(`${p} must be an object of scopes, e.g. {"*": {"limit": 20}}`);
  for (const [scope, entry] of Object.entries(file)) if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`${p}: scope ${scope} must be an object of flag values`);
  return file;
}

export function saveDefaults(name, file) {
  const p = defaultsPath(name);
  // An empty file is no file, so a --clear leaves nothing behind and the show command says "no defaults".
  if (!Object.keys(file).length) { rmSync(p, { force: true }); return null; }
  mkdirSync(join(home(), String(name)), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n');
  return p;
}

// What a verb accepts: the contract flags every verb carries, plus its own. The `*` scope applies to every verb,
// so it is checked against the union; a key only some verbs know still fails at run time on a verb that does not.
export function knownFlags(m, verb) {
  const verbs = verb && verb !== '*' ? m.verbs.filter(v => v.name === verb) : m.verbs;
  return new Set([...RESERVED.map(camel), ...verbs.flatMap(v => (v.flags || []).flatMap(f => [f.name, camel(f.name)]))]);
}

// A default is a flag typed on the command line, spelled in JSON: run it back through the same parser so --fields
// splits, --limit is validated and a bool is a bool. One call per scope, so a key in two scopes never becomes an array.
export function parseEntry(entry) {
  const tokens = Object.entries(entry || {}).flatMap(([k, v]) => [].concat(v).map(x => `--${k}=${x !== null && typeof x === 'object' ? JSON.stringify(x) : x}`));
  return parseFlags(tokens).flags;
}

// One line per scope for the human surface: declick defaults prints them, describe folds them onto one line.
export const defaultsLines = file => Object.entries(file || {})
  .map(([scope, entry]) => `${scope}: ${Object.entries(entry).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ')}`);
