import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { manifestDir } from './manifest.mjs';

export function recipesDir(name) { return join(manifestDir(name), 'recipes'); }

export function saveRecipe(name, verb, recipe) {
  const dir = recipesDir(name); mkdirSync(dir, { recursive: true });
  const p = join(dir, `${verb}.json`);
  writeFileSync(p, JSON.stringify(recipe, null, 2) + '\n');
  return p;
}

export function loadRecipe(name, verb) {
  const p = join(recipesDir(name), `${verb}.json`);
  if (!existsSync(p)) throw Object.assign(new Error(`no recipe ${verb} for ${name}`), { exit: 2 });
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listRecipes(name) {
  const dir = recipesDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).sort();
}

export function importRecipes(name, dir) {
  const out = recipesDir(name); mkdirSync(out, { recursive: true });
  const names = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const f of names) copyFileSync(join(dir, f), join(out, f));
  return names.map(f => basename(f, '.json'));
}
