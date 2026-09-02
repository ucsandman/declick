import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { manifestDir, assertName } from './manifest.mjs';

const STEP_KEYS = ['window', 'find', 'click', 'type', 'key', 'read', 'wait'];

// The checks a recipe must pass to be replayable at all. author.mjs adds the authoring-only
// checks (verb, description, example, expect) on top of this one.
export function validateStoredRecipe(r) {
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (!Array.isArray(r.steps) || !r.steps.length) return ['steps must be a non-empty array'];
  const errs = []; const found = new Set(); const reads = new Set();
  r.steps.forEach((s, i) => {
    const keys = Object.keys(s || {}).filter(k => STEP_KEYS.includes(k));
    if (keys.length !== 1) errs.push(`steps[${i}]: unknown step ${JSON.stringify(s)}`);
    if ((s.find || s.read) && typeof s.as !== 'string') errs.push(`steps[${i}]: find and read need "as"`);
    if (s.find && (!Array.isArray(s.find) || !s.find.every(seg => typeof seg === 'string' && seg.includes(':')))) errs.push(`steps[${i}]: find must be an array of Type:Name`);
    if (s.key && /\{\{/.test(String(s.key))) errs.push(`steps[${i}]: key steps must be literal`);
    const id = s.click || (Array.isArray(s.type) ? s.type[0] : undefined) || s.read;
    if (id && !found.has(id)) errs.push(`steps[${i}]: ${id} is not located by an earlier find`);
    if (typeof s.as === 'string') { if (s.find) found.add(s.as); if (s.read) reads.add(s.as); }
  });
  if (r.returns !== undefined && !reads.has(r.returns)) errs.push(`returns ${JSON.stringify(r.returns)} must name a read step's "as"`);
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
