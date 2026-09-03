import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXIT } from './output.mjs';

// The offline floor under DashClaw: three decisions, one file, first match wins. src/guard.mjs calls this on
// every mutating action, so home() is copied from defaults.mjs rather than imported from manifest.mjs: the guard
// stays out of the manifest/describe import chain the way it always has.
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const DECISIONS = ['allow', 'warn', 'block'];
const FIELDS = ['adapter', 'verb', 'mutating', 'decision', 'reason'];

export const policyPath = () => process.env.DECLICK_POLICY || join(home(), 'policy.json');

// The file an agent can copy: declick policy --example prints exactly this.
export const EXAMPLE_POLICY = { rules: [
  { adapter: 'petstore', verb: 'delete-*', decision: 'block', reason: 'no deletes from agents' },
  { adapter: '*', mutating: true, decision: 'warn', reason: 'writes are logged' },
  { adapter: 'crm', decision: 'allow' },
] };

// A pattern is `*`, a name, or a glob like delete-*; every other character is a literal, so a rule can never
// widen itself by accident with a regex metacharacter in an adapter name.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const matchGlob = (pattern, value) => new RegExp(`^${String(pattern ?? '*').split('*').map(esc).join('.*')}$`).test(String(value ?? ''));

// Fails closed: a file that cannot be read or does not say what it means stops every run, because the one thing
// worse than no policy is a policy the owner believes is running. No file at all is not an error, it is no policy.
export function loadPolicy() {
  const path = policyPath();
  if (!existsSync(path)) return null;
  const bad = why => { throw Object.assign(new Error(`policy file ${path} is invalid: ${why}; fix it or unset DECLICK_POLICY`), { exit: EXIT.ERROR }); };
  let file;
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { bad(`not valid JSON (${e.message})`); }
  if (!file || typeof file !== 'object' || Array.isArray(file)) bad('must be an object with a rules array, e.g. {"rules": []}');
  for (const k of Object.keys(file)) if (k !== 'rules') bad(`unknown field ${k}; the only field is rules`);
  if (!Array.isArray(file.rules)) bad('rules must be an array');
  file.rules.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`rules[${i}] must be an object`);
    for (const k of Object.keys(r)) if (!FIELDS.includes(k)) bad(`rules[${i}] has unknown field ${k}; allowed: ${FIELDS.join(', ')}`);
    for (const k of ['adapter', 'verb', 'reason']) if (r[k] !== undefined && typeof r[k] !== 'string') bad(`rules[${i}].${k} must be a string`);
    if (r.mutating !== undefined && typeof r.mutating !== 'boolean') bad(`rules[${i}].mutating must be true or false`);
    if (!DECISIONS.includes(r.decision)) bad(`rules[${i}].decision must be allow, warn or block`);
  });
  return { path, rules: file.rules };
}

// First match wins. No file and no matching rule are both "allow", and both answer null, so every caller reads
// the same: a rule that says something is the only thing that changes a run.
export function policyDecision({ adapter, verb, mutating }) {
  const file = loadPolicy();
  if (!file) return null;
  const i = file.rules.findIndex(r => matchGlob(r.adapter, adapter) && matchGlob(r.verb, verb) && (r.mutating === undefined || r.mutating === !!mutating));
  return i === -1 ? null : { decision: file.rules[i].decision, reason: file.rules[i].reason ?? null, rule: i };
}
