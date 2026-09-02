#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { loadManifest, saveManifest, listManifests, manifestDir } from '../src/manifest.mjs';
import { describe } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';
import { parseFlags } from '../src/output.mjs';
import { engines, pickEngine } from '../src/engines/index.mjs';
import { writeLauncher } from '../src/launcher.mjs';
import { writeSkill } from '../src/skill.mjs';

const USAGE = `declick: turn anything into a CLI so your agents stop clicking
  declick add <source> [--name n] [--goal "..."]   source: spec.json | https://... | app:<window title> | mcp:<server>
  declick build <name>        recompile from stored source
  declick describe <name> [--full]
  declick lint <name>
  declick list
  declick remove <name>`;

async function build(source, flags) {
  const engine = pickEngine(source);
  const m = await engines[engine].compile(source, { name: flags.name, goal: flags.goal, recipes: flags.recipes });
  const errs = lint(m);
  if (errs.length) throw Object.assign(new Error(`lint failed:\n  ${errs.join('\n  ')}`), { exit: 1 });
  saveManifest(m); writeLauncher(m.name); writeSkill(m);
  return m;
}

const { positional, flags } = parseFlags(process.argv.slice(2));
const [cmd, arg] = positional;
try {
  switch (cmd) {
    case 'add': { const m = await build(arg, flags); console.log(describe(m)); break; }
    case 'build': { const old = loadManifest(arg); const m = await build(old.source, { ...flags, name: arg }); console.log(describe(m)); break; }
    case 'describe': console.log(describe(loadManifest(arg), { full: !!flags.full })); break;
    case 'lint': { const errs = lint(loadManifest(arg)); if (errs.length) { console.error(errs.join('\n')); process.exit(1); } console.log(`${arg}: contract ok (${loadManifest(arg).verbs.length} verbs)`); break; }
    case 'list': { const names = listManifests(); console.log(names.length ? names.map(n => { const m = loadManifest(n); return `${n}\t${m.engine}\t${m.verbs.length} verbs\t${m.source}`; }).join('\n') : 'no adapters yet; declick add <source>'); break; }
    case 'remove': loadManifest(arg); rmSync(manifestDir(arg), { recursive: true }); console.log(`removed ${arg}`); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error(e.message); process.exit(e.exit ?? 1); }
