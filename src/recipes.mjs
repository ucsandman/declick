import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { manifestDir, assertName } from './manifest.mjs';

export const STEP_KEYS = ['window', 'launch', 'find', 'read-all', 'click', 'type', 'key', 'read', 'wait', 'wait-for',
  'wait-for-text', 'scroll', 'expand', 'collapse', 'select', 'context', 'set', 'clipboard', 'assert', 'dismiss'];
// Steps whose only argument is the id of an element an earlier find located.
const ELEMENT_STEPS = ['scroll', 'expand', 'collapse', 'select', 'context'];
export const READ_PROPS = ['value', 'name', 'text', 'toggle', 'selected', 'enabled'];
const isPath = p => Array.isArray(p) && p.length && p.every(seg => typeof seg === 'string' && seg.includes(':'));
const isText = s => typeof s === 'string' && !!s.trim();

// A launch block starts a real process, so it is never templated: an argument that came from the caller
// and reached a command line is an injection, not a path.
function launchErrs(l, at) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return [`${at}: must be an object with a command`];
  const e = [];
  if (!isText(l.command)) e.push(`${at}: command required`);
  if (l.args !== undefined && (!Array.isArray(l.args) || l.args.some(x => typeof x !== 'string'))) e.push(`${at}: args must be an array of strings`);
  if (l.waitForWindow !== undefined && typeof l.waitForWindow !== 'string') e.push(`${at}: waitForWindow must be a window title`);
  if (l.timeout !== undefined && !Number.isFinite(l.timeout)) e.push(`${at}: timeout must be a number of milliseconds`);
  if (/\{\{/.test(JSON.stringify(l))) e.push(`${at}: must be literal, no {{args}}`);
  return e;
}

// The checks a recipe must pass to be replayable at all. author.mjs adds the authoring-only
// checks (verb, description, example, expect) on top of this one.
export function validateStoredRecipe(r) {
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (!Array.isArray(r.steps) || !r.steps.length) return ['steps must be a non-empty array'];
  const errs = []; const found = new Set(); const reads = new Set();
  if (r.launch !== undefined) errs.push(...launchErrs(r.launch, 'launch'));
  r.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    const keys = Object.keys(s || {}).filter(k => STEP_KEYS.includes(k));
    if (keys.length !== 1) { errs.push(`${at}: unknown step ${JSON.stringify(s)}; one of ${STEP_KEYS.join(', ')}`); return; }
    const k = keys[0], val = s[k];
    const needs = id => { if (typeof id !== 'string' || !found.has(id)) errs.push(`${at}: ${typeof id === 'string' ? id : JSON.stringify(id)} is not located by an earlier find`); };
    const needsAs = () => { if (typeof s.as !== 'string') errs.push(`${at}: ${k} needs "as"`); };
    if (s.optional !== undefined && typeof s.optional !== 'boolean') errs.push(`${at}: optional must be true or false`);
    if (k === 'window' && !isText(val)) errs.push(`${at}: window must be a title`);
    if (k === 'launch') errs.push(...launchErrs(val, `${at}: launch`));
    if (k === 'find' || k === 'read-all' || k === 'wait-for') {
      if (!isPath(val)) errs.push(`${at}: ${k} must be an array of Type:Name`);
      if (k !== 'wait-for') needsAs();
    }
    if (k === 'read-all' && s.fields !== undefined) {
      const f = s.fields;
      const ok = f && typeof f === 'object' && !Array.isArray(f) && Object.values(f).every(p => isPath(p) || (typeof p === 'string' && p.includes(':')));
      if (!ok) errs.push(`${at}: fields must be an object of name: Type:Name path`);
    }
    if (k === 'read') { needs(val); needsAs(); if (s.prop !== undefined && !READ_PROPS.includes(s.prop)) errs.push(`${at}: read prop must be one of ${READ_PROPS.join(', ')}`); }
    if (k === 'click') needs(val);
    if (k === 'type') { if (!Array.isArray(val) || val.length !== 2 || val.some(x => typeof x !== 'string')) errs.push(`${at}: type must be [element, text]`); else needs(val[0]); }
    if (k === 'key' && /\{\{/.test(String(val))) errs.push(`${at}: key steps must be literal`);
    if (k === 'wait' && !Number.isFinite(val)) errs.push(`${at}: wait must be a number of milliseconds`);
    if ((k === 'wait-for' || k === 'wait-for-text') && s.timeout !== undefined && !Number.isFinite(s.timeout)) errs.push(`${at}: timeout must be a number of milliseconds`);
    if (k === 'wait-for-text') {
      if (!val || typeof val !== 'object' || !isText(val.text)) errs.push(`${at}: wait-for-text needs a non-empty text`);
      else if (val.as !== undefined) needs(val.as);
    }
    if (ELEMENT_STEPS.includes(k)) needs(val);
    if (k === 'set') { if (!Array.isArray(val) || val.length !== 2 || !['on', 'off'].includes(val[1])) errs.push(`${at}: set must be [element, on|off]`); if (Array.isArray(val)) needs(val[0]); }
    if (k === 'clipboard') {
      if (val === 'get') needsAs();
      else if (val === 'set') { if (!isText(s.text)) errs.push(`${at}: clipboard set needs "text"`); }
      else errs.push(`${at}: clipboard must be "get" or "set"`);
    }
    if (k === 'assert') {
      if (!val || typeof val !== 'object') errs.push(`${at}: assert must be an object`);
      else {
        if (!found.has(val.as) && !reads.has(val.as)) errs.push(`${at}: ${typeof val.as === 'string' ? val.as : JSON.stringify(val.as)} is not located by an earlier find`);
        if (val.prop !== undefined && !READ_PROPS.includes(val.prop)) errs.push(`${at}: assert prop must be one of ${READ_PROPS.join(', ')}`);
        if (val.equals === undefined && val.matches === undefined) errs.push(`${at}: assert needs equals or matches`);
        if (val.matches !== undefined) { try { new RegExp(val.matches); } catch { errs.push(`${at}: assert matches is not a valid regex`); } }
      }
    }
    if (k === 'dismiss' && val !== true) errs.push(`${at}: dismiss must be true`);
    if (typeof s.as === 'string') { if (k === 'find') found.add(s.as); else if (k === 'read' || k === 'read-all' || (k === 'clipboard' && val === 'get')) reads.add(s.as); }
  });
  if (r.returns !== undefined && r.returns !== null && !reads.has(r.returns)) errs.push(`returns ${JSON.stringify(r.returns)} must name a read, read-all or clipboard step's "as"`);
  return errs;
}

export function recipesDir(name) { return join(manifestDir(name), 'recipes'); }

export function saveRecipe(name, verb, recipe) {
  const dir = recipesDir(name); mkdirSync(dir, { recursive: true });
  const p = join(dir, `${assertName(verb, 'verb')}.json`);
  writeFileSync(p, JSON.stringify(recipe, null, 2) + '\n');
  return p;
}

export function loadRecipe(name, verb) {
  const p = join(recipesDir(name), `${assertName(verb, 'verb')}.json`);
  if (!existsSync(p)) throw Object.assign(new Error(`no recipe ${verb} for ${name}`), { exit: 2 });
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listRecipes(name) {
  const dir = recipesDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).sort();
}

export function removeRecipe(name, verb) {
  rmSync(join(recipesDir(name), `${assertName(verb, 'verb')}.json`), { force: true });
  return listRecipes(name);
}

// src is a directory of recipes, a single .json file, or "-" for one recipe on stdin.
// Every recipe is parsed and validated before any of them lands in the store.
export function importRecipes(name, src, { verb } = {}) {
  let sources;
  if (src === '-') {
    if (!verb) throw Object.assign(new Error('importing from - needs a verb: --verb <name>'), { exit: 1 });
    sources = [[assertName(verb, 'verb'), readFileSync(0, 'utf8')]];
  } else if (statSync(src).isDirectory()) {
    sources = readdirSync(src).filter(f => f.endsWith('.json')).sort().map(f => [basename(f, '.json'), readFileSync(join(src, f), 'utf8')]);
  } else {
    sources = [[basename(src, '.json'), readFileSync(src, 'utf8')]];
  }
  const recipes = sources.map(([v, text]) => {
    const bad = why => { throw Object.assign(new Error(`invalid recipe ${v}.json: ${why}`), { exit: 1 }); };
    assertName(v, 'verb');
    let r; try { r = JSON.parse(text); } catch (e) { bad(e.message); }
    const errs = validateStoredRecipe(r);
    if (errs.length) bad(errs.join('; '));
    return [v, r];
  });
  const out = recipesDir(name); mkdirSync(out, { recursive: true });
  for (const [v, r] of recipes) writeFileSync(join(out, `${v}.json`), JSON.stringify(r, null, 2) + '\n');
  return recipes.map(([v]) => v);
}
