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

export function writeLauncher(name, { force = false } = {}) {
  const hit = force ? null : shadows(name);
  if (hit) throw Object.assign(new Error(`${name} already resolves to ${hit}; pick another --name or pass --force`), { exit: 1 });
  const bin = binDir();
  mkdirSync(bin, { recursive: true });
  const cmd = join(bin, `${name}.cmd`);
  writeFileSync(cmd, `@echo off\r\nnode "${RUN}" ${name} %*\r\n`);
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nexec node "${RUN.replace(/\\/g, '/')}" ${name} "$@"\n`, { mode: 0o755 });
  if (!onPath()) process.stderr.write(`add to PATH once: ${pathHint()}   (or use: declick run ${name} <verb>)\n`);
  return cmd;
}

export function removeLauncher(name) {
  return [join(binDir(), `${name}.cmd`), join(binDir(), name)].filter(p => { if (!existsSync(p)) return false; rmSync(p, { force: true }); return true; });
}
