import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function vaultPath() { return process.env.CREDS_VAULT || join(homedir(), '.creds', 'vault.env'); }

function readVault() {
  const p = vaultPath();
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function loadEnv(names) {
  const vault = names.length ? readVault() : {};
  const found = {}; const missing = [];
  for (const n of names) {
    const v = process.env[n] ?? vault[n];
    if (v) found[n] = v; else missing.push(n);
  }
  return { found, missing };
}
