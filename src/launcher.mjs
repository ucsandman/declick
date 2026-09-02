import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './manifest.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run.mjs');

export function writeLauncher(name) {
  const bin = join(HOME, 'bin');
  mkdirSync(bin, { recursive: true });
  const cmd = join(bin, `${name}.cmd`);
  writeFileSync(cmd, `@echo off\r\nnode "${RUN}" ${name} %*\r\n`);
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nexec node "${RUN.replace(/\\/g, '/')}" ${name} "$@"\n`);
  if (!(process.env.PATH || '').split(/[;:]/).includes(bin)) {
    process.stderr.write(`add to PATH once: ${bin}\n`);
  }
  return cmd;
}
