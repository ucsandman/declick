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

// A key is scoped to the origin its adapter was built from. bin/run.mjs sets the scope before the engine
// builds a request, so one adapter cannot be pointed at another host and hand it this machine's credentials.
let scope = null; const used = new Map(); const crossed = new Map();
export function scopeCreds(s) { scope = s || null; used.clear(); crossed.clear(); }
export function credUsage() { return [...used.entries()].map(([name, u]) => ({ name, ...u })); }

const releasable = name => {
  if (!scope) return null;
  if (!scope.expected || !scope.actual || scope.expected === scope.actual) return null;
  // A release across origins is allowed two ways and both are recorded: stderr is not the contract, so the
  // envelope says where the key was scoped and where it went. The refusal never names the flag that skips it.
  if (scope.allow?.includes(name) || scope.explicit) { crossed.set(name, { scopedTo: scope.expected, sentTo: scope.actual }); if (scope.explicit) process.stderr.write(`warning: ${name} is scoped to ${scope.expected}; --base-url sends it to ${scope.actual}\n`); return null; }
  return `${name} is scoped to ${scope.expected} but this request goes to ${scope.actual}; rebuild the adapter for ${scope.actual} or set DECLICK_ENV_ALLOW=${name}`;
};

export function loadEnv(names) {
  const vault = names.length ? readVault() : {};
  const found = {}; const missing = [];
  for (const n of names) {
    const v = process.env[n] ?? vault[n];
    if (!v) { missing.push(n); continue; }
    const why = releasable(n);
    if (why) throw Object.assign(new Error(why), { exit: 4 });
    used.set(n, { from: process.env[n] ? 'env' : 'vault', ...(crossed.get(n) || {}) });
    found[n] = v;
  }
  return { found, missing };
}
