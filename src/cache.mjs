import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// home() is copied from defaults.mjs for the reason given there: bin/run.mjs loads this on every call, and
// importing manifest.mjs would pull describe.mjs and the defaults file in behind it.
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Beside manifest.json and defaults.json: declick build clears it, declick remove deletes the directory with it.
export const cacheDir = name => join(home(), String(name), 'cache');

// What would change the answer: the adapter, the verb, its positional args and its own flags. The contract flags
// are filtered out by the caller, so --fields id and --fields id,name read the same stored response.
export const cacheKey = ({ name, verb, args, flags }) =>
  createHash('sha256').update(JSON.stringify([name, verb, args ?? [], flags ?? {}])).digest('hex');

// A hit is an entry younger than the TTL this call asked for. An unreadable entry, or one written by a clock
// that has since moved on, is a miss and never an error: the wire is still there to ask again.
export function cacheRead(name, key, ttl) {
  if (!KEBAB.test(String(name))) return null;
  const p = join(cacheDir(name), `${key}.json`);
  if (!existsSync(p)) return null;
  let entry;
  try { entry = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  const age = Math.floor((Date.now() - Date.parse(entry?.at)) / 1000);
  if (!Number.isFinite(age) || age > ttl) return null;
  return { result: entry.result, age: Math.max(age, 0) };
}

export function cacheWrite(name, key, entry) {
  if (!KEBAB.test(String(name))) return false;
  try {
    mkdirSync(cacheDir(name), { recursive: true });
    writeFileSync(join(cacheDir(name), `${key}.json`), JSON.stringify(entry) + '\n');
    return true;
  } catch { return false; }
}

// declick build recompiles the verbs a stored answer belongs to, so what it stored is no longer about this adapter.
export const cacheClear = name => { try { rmSync(cacheDir(name), { recursive: true, force: true }); return true; } catch { return false; } };
