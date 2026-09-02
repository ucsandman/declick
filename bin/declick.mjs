#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadManifest, saveManifest, listManifests, manifestDir } from '../src/manifest.mjs';
import { describe } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';
import { parseFlags } from '../src/output.mjs';
import { engines, pickEngine } from '../src/engines/index.mjs';
import { writeLauncher } from '../src/launcher.mjs';
import { writeSkill } from '../src/skill.mjs';
import { importRecipes, loadRecipe } from '../src/recipes.mjs';
import { author } from '../src/author.mjs';
import { startUi } from '../src/ui.mjs';

const USAGE = `declick: turn anything into a CLI so your agents stop clicking
  declick add <source> [--name n] [--goal "..."] [--verb v]   source: spec.json | https://... | app:<window title> | mcp:<server>
  declick author <name> --goal "..." [--verb v]   add a verb to a desktop adapter (Claude explores, replays once, saves on success)
  declick repair <name> <verb>                    re-author a verb whose element path stopped resolving
  declick build <name>        recompile from stored source
  declick describe <name> [--full]
  declick lint <name>
  declick list
  declick remove <name>
  declick ui [--port N] [--open]   local page: every adapter, last run, build / repair / remove buttons`;

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
const adapterName = (source, flags) => flags.name || slug(source.replace(/^app:/, ''));

async function build(source, flags) {
  const engine = pickEngine(source);
  const name = engine === 'desktop' ? adapterName(source, flags) : flags.name;
  if (engine === 'desktop' && flags.recipes) importRecipes(name, flags.recipes);
  const m = await engines[engine].compile(source, { name, goal: flags.goal, recipes: engine === 'desktop' ? undefined : flags.recipes });
  const errs = lint(m);
  if (errs.length) throw Object.assign(new Error(`lint failed:\n  ${errs.join('\n  ')}`), { exit: 1 });
  saveManifest(m); writeLauncher(m.name); writeSkill(m);
  return m;
}

async function authorVerb(name, window, flags, seed) {
  if (!flags.goal && !seed) throw Object.assign(new Error('--goal "what the verb should do" is required'), { exit: 1 });
  const verb = flags.verb || (seed ? seed.verb : slug(flags.goal));
  const goal = flags.goal || seed.recipe.description;
  const out = await author({ name, window, goal, verb, seed });
  process.stderr.write(`saved ${out.path} (replay returned ${JSON.stringify(out.result)})\n`);
  return build(`app:${window}`, { ...flags, name });
}

const { positional, flags } = parseFlags(process.argv.slice(2));
const [cmd, arg] = positional;
try {
  switch (cmd) {
    case 'add': {
      const m = pickEngine(arg) === 'desktop' && flags.goal && !flags.recipes
        ? await authorVerb(adapterName(arg, flags), arg.replace(/^app:/, ''), flags)
        : await build(arg, flags);
      console.log(describe(m)); break;
    }
    case 'author': {
      const old = loadManifest(arg);
      if (old.engine !== 'desktop') throw Object.assign(new Error(`${arg} is a ${old.engine} adapter; author works on desktop adapters`), { exit: 1 });
      console.log(describe(await authorVerb(arg, old.window, { ...flags, name: arg }))); break;
    }
    case 'repair': {
      const [, verb] = positional.slice(1);
      if (!verb) throw Object.assign(new Error('usage: declick repair <name> <verb>'), { exit: 1 });
      const old = loadManifest(arg);
      const recipe = loadRecipe(arg, verb);
      const lePath = join(manifestDir(arg), 'last-error.json');
      const le = existsSync(lePath) ? JSON.parse(readFileSync(lePath, 'utf8')) : { error: 'no recorded failure', diff: { missing: [], added: [] } };
      const m = await authorVerb(arg, old.window, { ...flags, name: arg, verb }, { verb, recipe, diff: le.diff, error: le.error });
      console.log(describe(m)); break;
    }
    case 'build': { const old = loadManifest(arg); const m = await build(old.source, { ...flags, name: arg }); console.log(describe(m)); break; }
    case 'describe': console.log(describe(loadManifest(arg), { full: !!flags.full })); break;
    case 'lint': { const errs = lint(loadManifest(arg)); if (errs.length) { console.error(errs.join('\n')); process.exit(1); } console.log(`${arg}: contract ok (${loadManifest(arg).verbs.length} verbs)`); break; }
    case 'list': { const names = listManifests(); console.log(names.length ? names.map(n => { const m = loadManifest(n); return `${n}\t${m.engine}\t${m.verbs.length} verbs\t${m.source}`; }).join('\n') : 'no adapters yet; declick add <source>'); break; }
    case 'remove': loadManifest(arg); rmSync(manifestDir(arg), { recursive: true }); console.log(`removed ${arg}`); break;
    case 'ui': {
      const server = await startUi({ port: flags.port ? Number(flags.port) : 4870 });
      const url = `http://127.0.0.1:${server.address().port}`;
      process.stderr.write(`declick ui at ${url}\n`);
      if (flags.open && process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      await new Promise(() => {});
      break;
    }
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error(e.message); process.exit(e.exit ?? 1); }
