#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME, KEBAB, loadManifest, saveManifest, listManifests, manifestDir } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';
import { parseFlags, emit, EXIT } from '../src/output.mjs';
import { engines, pickEngine, ENGINE_INFO } from '../src/engines/index.mjs';
import { writeLauncher, removeLauncher, binDir, onPath, pathHint } from '../src/launcher.mjs';
import { writeSkill, writeSelfSkill, removeSkill, skillDirs } from '../src/skill.mjs';
import { importRecipes, loadRecipe, listRecipes, removeRecipe, recipesDir } from '../src/recipes.mjs';
import { author } from '../src/author.mjs';
import { startUi, adapterRows } from '../src/ui.mjs';
import { DESK } from '../src/engines/desktop.mjs';
import { loadEnv, vaultPath } from '../src/creds.mjs';
import { DEFAULT_URL } from '../src/guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const USAGE = `declick ${VERSION}: turn anything into a CLI so your agents stop clicking
  declick add <source> [--name n] [--verbs a,b | --tag t] [--engine e] [--force]   source: spec.json | https://.../openapi.json | app:<window title>
  declick add app:<window> --goal "..." [--verb v]      author a desktop verb with Claude (explores, replays once, saves on success)
  declick add app:<window> --recipes <dir|file|->      import hand-written recipes
  declick run <name> <verb> [args] [--flags]            invoke a verb without ~/.declick/bin on PATH
  declick describe <name> [--full] [--verb v]           the surface, under 500 tokens (--json for data)
  declick manifest <name> [--verb v]                    the compiled contract as data
  declick list | status [<name>] | doctor | auth <name> | engines | path [--install] | version
  declick author <name> --goal "..." [--verb v]         add a verb to a desktop adapter
  declick repair <name> <verb>                          re-author a verb whose element path stopped resolving
  declick proposals <name> | accept <name> <verb>       rejected authoring proposals, and promote one
  declick recipes <name> | recipe <name> <verb>         stored desktop recipes
  declick build <name> | lint <name> | skill [<name>]   recompile, check the contract, regenerate SKILL.md
  declick remove <name> [<verb>]                        delete an adapter (manifest, launcher, skill) or one verb
  declick export <name> | import [<file>|-]             move an adapter between machines
  declick desk status | arm [minutes] | disarm          deskclaw through declick
  declick ui [--port N] [--open]                        local page: every adapter, last run, add / build / repair / remove
Every command: --json (default when piped) with {ok,data,meta}; exit 0 ok 1 error 2 not found 3 blocked 4 auth.`;

const fail = (msg, exit = EXIT.ERROR) => { throw Object.assign(new Error(msg), { exit }); };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
const adapterName = (source, flags) => flags.name ? (KEBAB.test(flags.name) ? flags.name : fail(`name ${JSON.stringify(flags.name)} must be kebab-case; use --name ${slug(flags.name)}`)) : slug(source.replace(/^app:/, ''));
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const which = bin => { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0] : null; };
// deskclaw keeps its switches as files next to the launcher: state/ACT-ARMED (with an expires= line) and state/STOP.
const deskState = () => { const dir = join(dirname(DESK()), 'state'); const f = join(dir, 'ACT-ARMED'); const armed = existsSync(f) ? readFileSync(f, 'utf8') : null; const exp = /expires=(\S+)/.exec(armed || '')?.[1]; return { path: DESK(), exists: existsSync(DESK()), armed: armed !== null && (!exp || new Date(exp) > new Date()), expires: exp || null, stop: existsSync(join(dir, 'STOP')) }; };
const desk = (...args) => { const bin = DESK(); if (!existsSync(bin)) fail(`deskclaw not found at ${bin}; install https://github.com/ucsandman/deskclaw or set DECLICK_DESK`); const r = spawnSync(bin.endsWith('.mjs') ? process.execPath : 'bash', [bin, ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const proposals = name => { const dir = join(manifestDir(name), 'proposals'); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ verb: basename(f, '.json'), path: join(dir, f), recipe: readJson(join(dir, f)) })) : []; };

async function build(source, flags) {
  const engine = pickEngine(source, flags.engine);
  const name = engine === 'desktop' ? adapterName(source, flags) : flags.name ? adapterName(source, flags) : undefined;
  if (engine === 'desktop' && flags.recipes) importRecipes(name, flags.recipes, { verb: flags.verb });
  const m = await engines[engine].compile(source, { name, goal: flags.goal, verbs: flags.verbs, tag: flags.tag });
  const errs = lint(m);
  if (errs.length) fail(`lint failed:\n  ${errs.join('\n  ')}`);
  saveManifest(m); writeLauncher(m.name, { force: !!flags.force }); writeSkill(m, { force: !!flags.force }); writeSelfSkill();
  return loadManifest(m.name);
}

async function authorVerb(name, window, flags, seed) {
  if (!flags.goal && !seed) fail('--goal "what the verb should do" is required');
  const verb = flags.verb || (seed ? seed.verb : slug(flags.goal));
  const goal = flags.goal || seed.recipe.description;
  const out = await author({ name, window, goal, verb, seed });
  process.stderr.write(`saved ${out.path} (replay returned ${JSON.stringify(out.result)})\n`);
  rmSync(join(manifestDir(name), 'last-error.json'), { force: true });
  return build(`app:${window}`, { ...flags, name });
}

function removeAdapter(name) {
  loadManifest(name);
  rmSync(manifestDir(name), { recursive: true });
  return { removed: name, launcher: removeLauncher(name), skill: removeSkill(name) };
}

function doctor() {
  const node = process.versions.node;
  const claude = which(process.env.DECLICK_CLAUDE || 'claude');
  const d = deskState();
  const adapters = listManifests();
  const checks = {
    node: { version: node, ok: Number(node.split('.')[0]) >= 24, need: '>=24' },
    home: { path: HOME, exists: existsSync(HOME), adapters: adapters.length },
    bin: { path: binDir(), onPath: onPath(), fix: onPath() ? null : `declick path --install (or: ${pathHint()})` },
    skills: skillDirs().map(p => ({ path: p, exists: existsSync(p) })),
    vault: { path: vaultPath(), exists: existsSync(vaultPath()) },
    desk: d,
    claude: { path: claude, found: !!claude, note: 'needed for declick add --goal / author / repair' },
    governance: { enabled: !!process.env.DASHCLAW_API_KEY, url: process.env.DASHCLAW_URL || DEFAULT_URL, strict: process.env.DECLICK_GUARD === 'strict' },
    engines: ENGINE_INFO,
  };
  const problems = [];
  if (!checks.node.ok) problems.push(`node ${node} is below 24`);
  if (!checks.bin.onPath) problems.push(`${binDir()} is not on PATH; ${checks.bin.fix}`);
  if (adapters.some(n => readJson(join(manifestDir(n), 'manifest.json'))?.engine === 'desktop') && !d.exists) problems.push(`deskclaw missing at ${d.path}`);
  return { ok: checks.node.ok, problems, ...checks };
}

const raw = process.argv.slice(2);
let flags = {}, positional = [];
try { ({ positional, flags } = parseFlags(raw)); } catch (e) { console.error(e.message); process.exit(e.exit ?? 1); }
const [cmd, arg, arg2] = positional;
const json = flags.json ?? !process.stdout.isTTY;
const need = what => { if (!arg) fail(`usage: declick ${cmd} <${what}>`); return arg; };
let result, text;

try {
  if (flags.version && !cmd) { result = { ok: true, data: { version: VERSION, node: process.versions.node } }; text = VERSION; }
  else switch (cmd) {
    case 'add': {
      const source = need('source');
      const m = pickEngine(source, flags.engine) === 'desktop' && flags.goal && !flags.recipes
        ? await authorVerb(adapterName(source, flags), source.replace(/^app:/, ''), flags)
        : await build(source, flags);
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'run': {
      const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'run.mjs'), ...raw.slice(1)], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    case 'author': {
      const old = loadManifest(need('name'));
      if (old.engine !== 'desktop') fail(`${arg} is a ${old.engine} adapter; author works on desktop adapters`);
      const m = await authorVerb(arg, old.window, { ...flags, name: arg });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'repair': {
      need('name'); if (!arg2) fail('usage: declick repair <name> <verb>');
      const old = loadManifest(arg);
      const recipe = loadRecipe(arg, arg2);
      const le = readJson(join(manifestDir(arg), 'last-error.json')) || { error: 'no recorded failure', diff: { missing: [], added: [] } };
      const m = await authorVerb(arg, old.window, { ...flags, name: arg, verb: arg2 }, { verb: arg2, recipe, diff: le.diff, error: le.error });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'accept': {
      need('name'); if (!arg2) fail('usage: declick accept <name> <verb>');
      const p = proposals(arg).find(x => x.verb === arg2) || fail(`no proposal ${arg2} for ${arg}; run: declick proposals ${arg}`, EXIT.NOT_FOUND);
      const old = readJson(join(manifestDir(arg), 'manifest.json'));
      importRecipes(arg, p.path, { verb: arg2 }); rmSync(p.path, { force: true });
      const m = await build(old?.source || `app:${p.recipe.window || arg}`, { ...flags, name: arg });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'build': { const old = loadManifest(need('name')); const m = await build(old.source, { ...flags, name: arg, engine: old.engine }); result = { ok: true, data: describeJson(m) }; text = describe(m); break; }
    case 'describe': { const m = loadManifest(need('name')); const o = { full: !!flags.full, verb: flags.verb }; result = { ok: true, data: describeJson(m, o) }; text = describe(m, o); break; }
    case 'manifest': { const m = loadManifest(need('name')); result = { ok: true, data: flags.verb ? { ...m, verbs: m.verbs.filter(v => v.name === flags.verb) } : m }; text = JSON.stringify(result.data, null, 2); break; }
    case 'lint': { const errs = lint(loadManifest(need('name'))); result = errs.length ? { ok: false, exit: EXIT.ERROR, error: `${arg}: ${errs.length} contract error(s)`, data: { errors: errs } } : { ok: true, data: { name: arg, errors: [], verbs: loadManifest(arg).verbs.length } }; text = errs.length ? errs.join('\n') : `${arg}: contract ok (${result.data.verbs} verbs)`; break; }
    case 'list': {
      const rows = adapterRows().map(r => ({ ...r, verbs: r.error ? [] : loadManifest(r.name).verbs.map(v => v.name), auth: r.error ? [] : loadManifest(r.name).auth?.env || [] }));
      result = { ok: true, data: rows };
      text = rows.length ? rows.map(r => `${r.name}\t${r.engine ?? 'broken'}\t${r.verbs.length} verbs\t${r.source ?? r.error}`).join('\n') : 'no adapters yet; declick add <source>'; break;
    }
    case 'status': {
      const rows = adapterRows().filter(r => !arg || r.name === arg).map(r => ({ ...r, proposals: r.error ? [] : proposals(r.name).map(p => p.verb), recipes: r.engine === 'desktop' ? listRecipes(r.name) : [] }));
      if (arg && !rows.length) fail(`no adapter named ${arg}; run: declick list`, EXIT.NOT_FOUND);
      result = { ok: true, data: arg ? rows[0] : rows }; break;
    }
    case 'doctor': { const d = doctor(); result = { ok: true, data: d }; text = JSON.stringify(d, null, 2); if (!d.ok) result = { ok: false, exit: EXIT.ERROR, error: d.problems.join('; '), data: d }; break; }
    case 'auth': {
      const m = loadManifest(need('name'));
      const { found, missing } = loadEnv(m.auth.env || []);
      const keys = (m.auth.env || []).map(n => ({ name: n, present: n in found, source: process.env[n] ? 'env' : n in found ? 'vault' : null }));
      const data = { name: arg, vault: vaultPath(), keys, missing };
      result = missing.length ? { ok: false, exit: EXIT.AUTH, error: `missing ${missing.join(', ')}; set them in the environment or ${vaultPath()} (or run: creds mint ${arg}); a verb needs only one of its alternatives, see declick manifest ${arg}`, data } : { ok: true, data };
      text = keys.map(k => `${k.name}\t${k.present ? k.source : 'missing'}`).join('\n') || 'no auth needed'; break;
    }
    case 'engines': result = { ok: true, data: ENGINE_INFO }; break;
    case 'path': {
      const data = { home: HOME, bin: binDir(), onPath: onPath(), skills: skillDirs(), fix: onPath() ? null : pathHint() };
      if (flags.install && !data.onPath) {
        if (process.platform === 'win32') { const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH','User') + ';${binDir()}', 'User')`], { encoding: 'utf8' }); if (r.status !== 0) fail(`could not update user PATH: ${r.stderr.trim()}`); data.installed = 'user PATH (new shells only)'; }
        else { appendFileSync(join(homedir(), '.profile'), `\nexport PATH="$PATH:${binDir()}"\n`); data.installed = '~/.profile (new shells only)'; }
      }
      result = { ok: true, data }; break;
    }
    case 'proposals': result = { ok: true, data: proposals(need('name')).map(p => ({ verb: p.verb, path: p.path, description: p.recipe?.description ?? null, accept: `declick accept ${arg} ${p.verb}` })) }; break;
    case 'recipes': { loadManifest(need('name')); result = { ok: true, data: listRecipes(arg).map(v => ({ verb: v, path: join(recipesDir(arg), `${v}.json`) })) }; break; }
    case 'recipe': { need('name'); if (!arg2) fail('usage: declick recipe <name> <verb>'); result = { ok: true, data: loadRecipe(arg, arg2) }; text = JSON.stringify(result.data, null, 2); break; }
    case 'skill': {
      const names = arg ? [arg] : listManifests();
      const written = names.flatMap(n => writeSkill(loadManifest(n), { force: !!flags.force })).concat(writeSelfSkill());
      result = { ok: true, data: { written } }; text = written.join('\n'); break;
    }
    case 'remove': {
      need('name');
      if (arg2) { loadManifest(arg); const left = removeRecipe(arg, arg2); const m = left.length ? await build(loadManifest(arg).source, { ...flags, name: arg }) : (removeAdapter(arg), null); result = { ok: true, data: { removed: `${arg} ${arg2}`, remaining: left } }; text = m ? describe(m) : `removed ${arg} (no verbs left)`; }
      else { result = { ok: true, data: removeAdapter(arg) }; text = `removed ${arg}`; }
      break;
    }
    case 'export': { const m = loadManifest(need('name')); const recipes = Object.fromEntries(listRecipes(arg).map(v => [v, loadRecipe(arg, v)])); result = { ok: true, data: { manifest: m, recipes } }; text = JSON.stringify(result.data, null, 2); break; }
    case 'import': {
      const src = !arg || arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
      const bundle = JSON.parse(src);
      const m = bundle.manifest || fail('bundle needs a manifest field');
      const errs = lint(m); if (errs.length) fail(`lint failed:\n  ${errs.join('\n  ')}`);
      saveManifest(m);
      for (const [verb, recipe] of Object.entries(bundle.recipes || {})) { const tmp = join(manifestDir(m.name), `${verb}.import.json`); writeFileSync(tmp, JSON.stringify(recipe)); importRecipes(m.name, tmp, { verb }); rmSync(tmp, { force: true }); }
      writeLauncher(m.name, { force: !!flags.force }); writeSkill(m, { force: !!flags.force });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'desk': {
      if (!arg || arg === 'status') { result = { ok: true, data: deskState() }; break; }
      if (arg === 'arm' || arg === 'disarm') { const r = desk(arg, ...(arg2 ? [arg2] : [])); if (r.code) fail(`desk ${arg} exited ${r.code}: ${r.err || r.out}`, r.code === 3 ? EXIT.BLOCKED : EXIT.ERROR); result = { ok: true, data: { ...deskState(), output: r.out } }; break; }
      fail('usage: declick desk status | arm [minutes] | disarm');
    }
    case 'ui': {
      const server = await startUi({ port: flags.port ? Number(flags.port) : 4870 });
      const url = `http://127.0.0.1:${server.address().port}`;
      process.stdout.write((json ? JSON.stringify({ ok: true, data: { url, port: server.address().port }, meta: { count: 1, truncated: false } }) : `declick ui at ${url}`) + '\n');
      if (flags.open && process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      await new Promise(() => {});
      break;
    }
    case 'version': result = { ok: true, data: { version: VERSION, node: process.versions.node } }; text = VERSION; break;
    case 'help': case undefined: result = { ok: true, data: { version: VERSION, usage: USAGE } }; text = USAGE; break;
    default: fail(`unknown command ${cmd}\n${USAGE}`);
  }
} catch (e) { result = { ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR }; }

const out = emit(result, { json, fields: flags.fields, limit: flags.limit });
if (!json) { if (result.ok) out.text = text ?? out.text; else { process.stderr.write(out.text + '\n'); out.text = null; } }
if (out.text !== null) process.stdout.write(out.text + '\n');
process.exitCode = out.exit;
