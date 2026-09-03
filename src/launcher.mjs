import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './manifest.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run.mjs');
const WIN = process.platform === 'win32';
export const binDir = () => join(HOME, 'bin');
const norm = p => (WIN ? resolve(p).toLowerCase() : resolve(p)).replace(/[\\/]+$/, '');

export function onPath() {
  const want = norm(binDir());
  return (process.env.PATH || '').split(delimiter).filter(Boolean).some(p => { try { return norm(p) === want; } catch { return false; } });
}

export function pathHint() {
  const bin = binDir();
  return WIN ? `setx PATH "%PATH%;${bin}"` : `echo 'export PATH="$PATH:${bin}"' >> ~/.profile`;
}

// A shim named git, node or claude would shadow the real tool once bin is on PATH.
export function shadows(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const hits = r.stdout.split(/\r?\n/).filter(Boolean).filter(p => !norm(dirname(p)).startsWith(norm(binDir())));
  return hits[0] || null;
}

// The preflight callers run before they write anything else, so a refusal never leaves half an adapter.
export function canWriteLauncher(name, { force = false } = {}) {
  const hit = force ? null : shadows(name);
  if (hit) throw Object.assign(new Error(`${name} already resolves to ${hit}; pick another --name or pass --force`), { exit: 1 });
  return true;
}

export function writeLauncher(name, { force = false } = {}) {
  canWriteLauncher(name, { force });
  const bin = binDir();
  mkdirSync(bin, { recursive: true });
  const cmd = join(bin, `${name}.cmd`);
  // %* forwards argv byte-for-byte -- except cmd.exe expands any %VAR% that matches a real environment
  // variable while it parses ITS OWN command line, before this batch file (or any command, batch or
  // not) even starts running; no shim content can intercept that (`cmd /c echo a%PATH%b` mangles it
  // identically with zero .cmd file involved). An argument like "a%PATH%b" reaches node as "a<PATH
  // value>b"; a % that doesn't pair up with a defined variable (a literal "%", "50%off", "%1", "%*")
  // passes through untouched. The bash shim below never goes through cmd.exe and has no such limitation.
  writeFileSync(cmd, `@echo off\r\nnode "${RUN}" ${name} %*\r\n`);
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nexec node "${RUN.replace(/\\/g, '/')}" ${name} "$@"\n`, { mode: 0o755 });
  if (!onPath()) process.stderr.write(`add to PATH once: ${pathHint()}   (or use: declick run ${name} <verb>)\n`);
  return cmd;
}

export function removeLauncher(name) {
  return [join(binDir(), `${name}.cmd`), join(binDir(), name)].filter(p => { if (!existsSync(p)) return false; rmSync(p, { force: true }); return true; });
}
