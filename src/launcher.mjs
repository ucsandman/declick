import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { HOME } from './manifest.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run.mjs');
const WIN = process.platform === 'win32';
export const binDir = () => join(HOME, 'bin');
const norm = p => (WIN ? resolve(p).toLowerCase() : resolve(p)).replace(/[\\/]+$/, '');
// Written into every launcher this file generates, so a launcher from a different DECLICK_HOME (a
// second install, or a temp dir a test suite points at) is still recognizable as declick's own, not
// a foreign binary collision -- checked either by content (below) or by living under a ".declick/bin"
// directory, the default HOME layout.
const MARKER = 'declick launcher';
const isDeclickLauncher = p => {
  if (/[\\/]\.declick[\\/]bin$/i.test(norm(dirname(p)))) return true;
  try { return readFileSync(p, 'utf8').includes(MARKER); } catch { return false; }
};

export function onPath() {
  const want = norm(binDir());
  return (process.env.PATH || '').split(delimiter).filter(Boolean).some(p => { try { return norm(p) === want; } catch { return false; } });
}

// zsh has been the macOS default login shell since Catalina (10.15) and never reads ~/.profile,
// so a launcher installed there is invisible to every new terminal a macOS user opens; bash on
// macOS prefers ~/.bash_profile when one already exists. Linux bash and any other shell still
// read ~/.profile, which is what every install before this one wrote unconditionally.
export function profileFile() {
  if (WIN) return null;
  const shell = process.env.SHELL || '';
  if (shell.endsWith('zsh')) return join(homedir(), '.zprofile');
  if (shell.endsWith('fish')) return join(homedir(), '.config', 'fish', 'config.fish');
  // bash reads the first of ~/.bash_profile, ~/.bash_login, ~/.profile that exists, on every platform: a line
  // appended to ~/.profile is dead once either of the other two is present (GitHub's Ubuntu runner has one).
  if (shell.endsWith('bash')) for (const f of ['.bash_profile', '.bash_login']) if (existsSync(join(homedir(), f))) return join(homedir(), f);
  return join(homedir(), '.profile');
}

export function pathHint() {
  const bin = binDir();
  if (WIN) return `setx PATH "%PATH%;${bin}"`;
  const file = profileFile();
  // fish_add_path is idempotent (checks membership before appending), unlike `set -gx PATH $PATH
  // <bin>` -- fish sources config.fish on every interactive shell, so a plain append would grow
  // PATH by one duplicate entry per shell opened.
  const line = file.endsWith('config.fish') ? `fish_add_path "${bin}"` : `export PATH="$PATH:${bin}"`;
  return `echo '${line}' >> ${file.replace(homedir(), '~')}`;
}

// A shim named git, node or claude would shadow the real tool once bin is on PATH.
export function shadows(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const hits = r.stdout.split(/\r?\n/).filter(Boolean).filter(p => !norm(dirname(p)).startsWith(norm(binDir())) && !isDeclickLauncher(p));
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
  let cmd;
  if (WIN) {
    cmd = join(bin, `${name}.cmd`);
    // %* forwards argv byte-for-byte -- except cmd.exe expands any %VAR% that matches a real environment
    // variable while it parses ITS OWN command line, before this batch file (or any command, batch or
    // not) even starts running; no shim content can intercept that (`cmd /c echo a%PATH%b` mangles it
    // identically with zero .cmd file involved). An argument like "a%PATH%b" reaches node as "a<PATH
    // value>b"; a % that doesn't pair up with a defined variable (a literal "%", "50%off", "%1", "%*")
    // passes through untouched. The bash shim below never goes through cmd.exe and has no such limitation.
    writeFileSync(cmd, `@echo off\r\nrem ${MARKER}\r\nnode "${RUN}" ${name} %*\r\n`);
  }
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n# ${MARKER}\nexec node "${RUN.replace(/\\/g, '/')}" ${name} "$@"\n`, { mode: 0o755 });
  if (!onPath()) process.stderr.write(`add to PATH once: ${pathHint()}   (or use: declick run ${name} <verb>)\n`);
  return cmd;
}

export function removeLauncher(name) {
  return [join(binDir(), `${name}.cmd`), join(binDir(), name)].filter(p => { if (!existsSync(p)) return false; rmSync(p, { force: true }); return true; });
}
