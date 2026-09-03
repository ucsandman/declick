#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync, appendFileSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME, KEBAB, loadManifest, saveManifest, listManifests, manifestDir, normalizeManifest } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { lint } from '../src/lint.mjs';
import { parseFlags, emit, camel, BOOLS, EXIT } from '../src/output.mjs';
import { writeLauncher, removeLauncher, canWriteLauncher, binDir, onPath, pathHint, profileFile } from '../src/launcher.mjs';
import { writeSkill, writeSelfSkill, removeSkill, canWriteSkill, skillDirs, skillText } from '../src/skill.mjs';
import { importRecipes, loadRecipe, listRecipes, removeRecipe, recipesDir, validateStoredRecipe } from '../src/recipes.mjs';
import { author } from '../src/author.mjs';
import { startUi, adapterRows } from '../src/ui.mjs';
import { DESK } from '../src/engines/desktop.mjs';
import { loadEnv, vaultPath, mintHint } from '../src/creds.mjs';
import { guardUrl, isStrict } from '../src/guard.mjs';

// ESM evaluates every static import before this module's own body runs, and src/engines/index.mjs statically
// imports every engine including sqlite.mjs, which imports node:sqlite: on Node <24 that throws
// ERR_UNKNOWN_BUILTIN_MODULE before this check could ever run. Loading it dynamically, gated here, turns that
// raw stack trace into one line for every command including doctor. DECLICK_NODE_VERSION overrides for tests.
const nodeVersion = process.env.DECLICK_NODE_VERSION || process.versions.node;
if (Number(nodeVersion.split('.')[0]) < 24) {
  const msg = `declick needs Node 24 or newer (found v${nodeVersion}); the sqlite engine uses node:sqlite`;
  if (!process.stdout.isTTY) process.stdout.write(JSON.stringify({ ok: false, error: msg, exit: EXIT.ERROR }) + '\n');
  else process.stderr.write(`error: ${msg}\n`);
  process.exit(EXIT.ERROR);
}
const { engines, pickEngine, ENGINE_INFO } = await import('../src/engines/index.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// The command surface as data: USAGE, --help, the declick SKILL.md and flag checking are all rendered from this
// one table, so a command can never exist without being documented or documented without existing.
const P = (name, required = true) => ({ name, required });
const F = (name, type, description, arg, extra) => ({ name, type, description, ...(arg ? { arg } : {}), ...extra });
const C = (name, summary, positionals, flags, o = {}) => ({ name, summary, positionals, flags, mutating: !!o.mutating, dryRun: !!o.dryRun, examples: o.examples || [] });
const COMMANDS = [
  C('add', 'compile a source into an adapter: manifest, launcher, SKILL.md', [P('source')],
    [F('name', 'string', 'adapter name (kebab-case); default is derived from the source', 'n'), F('verbs', 'string', 'only these verbs', 'a,b'), F('tag', 'string', 'only verbs carrying this OpenAPI tag', 't'),
      F('engine', 'string', `force an engine: ${ENGINE_INFO.map(e => e.name).join('|')}`, 'e'), F('goal', 'string', 'desktop only: what the verb should do; Claude authors it', '"..."'),
      F('verb', 'string', 'name for the authored verb', 'v'), F('recipes', 'string', 'desktop only: import hand-written recipes', 'dir|file|-'),
      F('host', 'string', 'har only: which captured host is the API', 'api.example.com'), F('url', 'string', 'graphql only: the endpoint a schema file does not carry', 'https://.../graphql'),
      F('force', 'boolean', 'overwrite an existing launcher or SKILL.md')],
    { mutating: true, dryRun: true, examples: ['declick add fixtures/petstore.json --name petstore --verbs get-pet-by-id,add-pet', 'declick add https://api.example.com/openapi.json', 'declick add app:Calculator --name calc --goal "add two numbers" --verb add'] }),
  C('run', 'invoke a verb without ~/.declick/bin on PATH; the verb keeps its own flags', [P('name'), P('verb', false)], [],
    { mutating: true, examples: ['declick run petstore get-pet-by-id 7', 'declick run petstore add-pet --name Rex --dry-run'] }),
  C('author', 'add a verb to a desktop adapter with Claude (explores, replays once, saves)', [P('name')],
    [F('goal', 'string', 'what the verb should do', '"..."', { required: true }), F('verb', 'string', 'verb name; default is derived from the goal', 'v')],
    { mutating: true, examples: ['declick author calc --goal "read the display" --verb show'] }),
  C('repair', 're-author a verb whose element path stopped resolving, seeded with the last failure', [P('name'), P('verb')],
    [F('goal', 'string', 'override the recorded description', '"..."')], { mutating: true, examples: ['declick repair calc add'] }),
  C('accept', 'promote a rejected authoring proposal into the adapter', [P('name'), P('verb')], [F('force', 'boolean', 'overwrite an existing launcher or SKILL.md')],
    { mutating: true, dryRun: true, examples: ['declick accept calc show'] }),
  C('build', 'recompile an adapter from its recorded source', [P('name')],
    [F('verbs', 'string', 'only these verbs', 'a,b'), F('tag', 'string', 'only verbs carrying this tag', 't'), F('force', 'boolean', 'overwrite an existing launcher or SKILL.md')],
    { mutating: true, dryRun: true, examples: ['declick build petstore'] }),
  C('describe', 'one adapter: verbs, args and returns, under 500 tokens', [P('name')],
    [F('full', 'boolean', 'add per-verb flags and the auth keys'), F('verb', 'string', 'only this verb', 'v'), F('grep', 'string', 'only verbs whose name or description matches', 'text'), F('offset', 'number', 'skip N verbs (pages with --limit)', 'N')],
    { examples: ['declick describe petstore --full', 'declick describe petstore --grep pet --limit 5', 'declick describe declick'] }),
  C('manifest', 'the compiled contract as data (http method/path or recipe steps)', [P('name')],
    [F('verb', 'string', 'only this verb', 'v'), F('schema', 'boolean', 'print the manifest field reference instead', null, { bare: true })],
    { examples: ['declick manifest petstore --verb add-pet', 'declick manifest --schema'] }),
  C('lint', 'check an adapter against the output contract', [P('name')], [], { examples: ['declick lint petstore'] }),
  C('list', 'every adapter with its engine, verbs and auth keys', [], [], { examples: ['declick list --fields name,verbs'] }),
  C('status', 'last run, last error with tree diff, proposals and recipes', [P('name', false)], [], { examples: ['declick status petstore'] }),
  C('doctor', 'node, home, PATH, deskclaw, claude, vault, engines and their tools', [], [], { examples: ['declick doctor --fields blocking,warnings'] }),
  C('auth', 'which env keys a verb needs, and where each one is read from', [P('name')], [], { examples: ['declick auth petstore'] }),
  C('engines', 'the engines this build has, or what one source would compile to', [],
    [F('source', 'string', 'classify a source without writing anything', 'x')], { examples: ['declick engines', 'declick engines --source ./spec.json'] }),
  C('path', 'where declick keeps adapters, launchers and skills', [], [F('install', 'boolean', 'put ~/.declick/bin on PATH for new shells')],
    { mutating: true, dryRun: true, examples: ['declick path --install'] }),
  C('proposals', 'authoring proposals whose replay failed, waiting to be accepted', [P('name')], [], { examples: ['declick proposals calc'] }),
  C('recipes', 'stored desktop recipes for an adapter', [P('name')], [], { examples: ['declick recipes calc'] }),
  C('recipe', 'one stored recipe, step by step', [P('name'), P('verb')], [], { examples: ['declick recipe calc add'] }),
  C('skill', 'regenerate SKILL.md for one adapter or all of them', [P('name', false)], [F('force', 'boolean', 'overwrite a SKILL.md declick did not write'), F('print', 'boolean', 'write the SKILL.md text to stdout instead of disk (needs <name>)')],
    { mutating: true, dryRun: true, examples: ['declick skill', 'declick skill petstore', 'declick skill petstore --print'] }),
  C('remove', 'delete an adapter (manifest, launcher, skill) or one desktop verb', [P('name'), P('verb', false)],
    [F('force', 'boolean', 'remove the last verb, which deletes the adapter')], { mutating: true, dryRun: true, examples: ['declick remove petstore', 'declick remove calc add --force'] }),
  C('export', 'the adapter and its recipes as one bundle on stdout', [P('name')], [], { examples: ['declick export petstore > bundle.json'] }),
  C('import', 'install an adapter from a bundle (file, or - for stdin)', [P('file', false)],
    [F('force', 'boolean', 'replace an adapter that points somewhere else'), F('example', 'boolean', 'print a minimal valid bundle instead', null, { bare: true }), F('engine', 'string', 'engine for --example', 'e')],
    { mutating: true, dryRun: true, examples: ['declick import bundle.json', 'declick import --example'] }),
  C('desk', 'the desktop through deskclaw: windows, element tree, read, clipboard, arm switch', [P('action', false), P('target', false)],
    [F('depth', 'number', 'tree: only elements no deeper than N', 'N'), F('type', 'string', 'tree: only this control type', 'Button'),
      F('grep', 'string', 'tree: only elements whose Type:Name matches', 're'), F('interactive', 'boolean', 'tree: only elements an agent can act on'),
      F('prop', 'string', 'read: value|name|text|toggle|selected|enabled (default value)', 'p')],
    { mutating: true, dryRun: true,
      examples: ['declick desk windows', 'declick desk tree Calculator --interactive', 'declick desk read Calculator "Text:Display is*"', 'declick desk clipboard set "hi" --dry-run', 'declick desk arm 30'] }),
  C('web', 'a page as a tree of elements a recipe can click, instead of a screenshot', [P('action'), P('url')],
    [F('selector', 'string', 'only inside this css selector', 'css')],
    { examples: ['declick web tree https://example.com', 'declick web tree https://example.com --selector nav --limit 20'] }),
  C('ui', 'local page: every adapter, last run, add / build / repair / remove', [], [F('port', 'number', 'port to listen on (default 4870)', 'N'), F('open', 'boolean', 'open a browser at it'), F('allow-authoring', 'boolean', 'let the page repair a verb or add with a goal (runs Claude)')],
    { mutating: true, examples: ['declick ui --open'] }),
  C('audit', 'the run log: what ran, what governance decided, what failed', [],
    [F('adapter', 'string', 'only this adapter', 'n'), F('since', 'string', 'only after an ISO time or a duration like 10m, 2h', 't'), F('failed', 'boolean', 'only runs that did not exit 0')],
    { examples: ['declick audit --failed --limit 20', 'declick audit --adapter petstore --since 2h'] }),
  C('commands', 'this table as data: every command, its flags and examples', [], [], { examples: ['declick commands --fields name,summary'] }),
  C('version', 'the declick and node versions', [], [], { examples: ['declick version'] }),
  C('help', 'the usage table, or one command row', [P('command', false)], [], { examples: ['declick help', 'declick help add'] }),
];
const byName = n => COMMANDS.find(c => c.name === n);
const flagBit = f => `--${f.name}${f.type === 'boolean' ? '' : ` ${f.arg || 'v'}`}`;
const usageOf = c => `declick ${c.name}${c.positionals.map(p => (p.required ? ` <${p.name}>` : ` [${p.name}]`)).join('')}${c.flags.map(f => (f.required ? ` ${flagBit(f)}` : ` [${flagBit(f)}]`)).join('')}`;
const commandRows = () => COMMANDS.map(c => ({ ...c, usage: usageOf(c) }));
const USAGE = [`declick ${VERSION}: turn anything into a CLI so your agents stop clicking`,
  ...COMMANDS.map(c => `  ${usageOf(c).padEnd(68)}  ${c.summary}`),
  'Every command: --json (default when piped) with {ok,data,meta}; exit 0 ok 1 error 2 not found 3 blocked 4 auth.',
  'declick <command> --help is one row; declick commands is this table as data. --dry-run previews a command that writes and changes nothing (meta.dryRun).'].join('\n');
const helpText = c => [usageOf(c), `  ${c.summary}`,
  ...c.flags.map(f => `  ${flagBit(f).padEnd(26)}${f.description}${f.required ? ' (required)' : ''}`),
  `  ${'--json --fields --limit'.padEnd(26)}on every command; ${c.dryRun ? '--dry-run previews this one' : 'this one has no preview'}`,
  ...(c.examples.length ? ['examples:', ...c.examples.map(e => `  ${e}`)] : [])].join('\n');

// Levenshtein, kept local on purpose: this one answers about commands and management flags, not about verbs.
function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// A prefix or substring match outranks edit distance (descr -> describe, verbss -> verbs), same rule as the runtime's nearest.
const nearest = (word, list, max = 3, take = 3) => {
  const rank = n => (word && n.startsWith(word)) ? 0 : (word && n.includes(word)) ? 1 : 2;
  return list.map(n => [n, rank(n), distance(word, n)]).filter(([, r, d]) => r < 2 || d <= max)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0])).slice(0, take).map(([n]) => n);
};
// An unknown command answers with the nearest names, never with the whole usage blob: the agent asked for one thing.
const unknownCommand = c => `unknown command ${c}${nearest(c, COMMANDS.map(x => x.name)).length ? `; did you mean ${nearest(c, COMMANDS.map(x => x.name)).join(', ')}?` : ''}; run: declick commands`;

const fail = (msg, exit = EXIT.ERROR, data) => { throw Object.assign(new Error(msg), { exit, ...(data !== undefined ? { data } : {}) }); };
// A lint report can run hundreds of lines (a big spec, every verb over budget); the error string stays skimmable, the full list rides in data.
const lintFailMsg = errs => `lint failed: ${errs.slice(0, 8).join('; ')}${errs.length > 8 ? ` ... and ${errs.length - 8} more` : ''}`;
// data.errors rides the full list on stdout for a real spec that's hundreds of lines over budget; cap it and keep the true count in errorCount.
const lintErrorsData = errs => ({ errors: errs.slice(0, 50), errorCount: errs.length });
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
const adapterName = (source, flags) => flags.name ? (KEBAB.test(flags.name) ? flags.name : fail(`name ${JSON.stringify(flags.name)} must be kebab-case; use --name ${slug(flags.name)}`)) : slug(source.replace(/^app:/, ''));
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const which = bin => { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0] : null; };
// deskclaw keeps its switches as files next to the launcher: state/ACT-ARMED (with an expires= line) and state/STOP.
const deskState = () => { const dir = join(dirname(DESK()), 'state'); const f = join(dir, 'ACT-ARMED'); const armed = existsSync(f) ? readFileSync(f, 'utf8') : null; const exp = /expires=(\S+)/.exec(armed || '')?.[1]; return { path: DESK(), exists: existsSync(DESK()), armed: armed !== null && (!exp || new Date(exp) > new Date()), expires: exp || null, stop: existsSync(join(dir, 'STOP')) }; };
const desk = (...args) => { const bin = DESK(); if (!existsSync(bin)) fail(`deskclaw not found at ${bin}; install https://github.com/ucsandman/deskclaw or set DECLICK_DESK`); const r = spawnSync(bin.endsWith('.mjs') ? process.execPath : 'bash', [bin, ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const proposals = name => { const dir = join(manifestDir(name), 'proposals'); return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ verb: basename(f, '.json'), path: join(dir, f), recipe: readJson(join(dir, f)) })) : []; };

async function build(source, flags, dry = false) {
  const engine = pickEngine(source, flags.engine);
  // pickEngine falls back to web only when a plain url routed there on its own (html body, or no spec-shaped
  // extension); an explicit web: source or a forced --engine web means the caller already knows what this is.
  if (engine === 'web' && flags.engine !== 'web' && !String(source).startsWith('web:')) {
    fail(`${source} is a web page, not an API spec. For a browser adapter: declick add web:${source} --recipes <dir>. For an API, give the OpenAPI/Swagger spec URL (declick engines --source ${source} says how a source would route).`);
  }
  const name = engine === 'desktop' ? adapterName(source, flags) : flags.name ? adapterName(source, flags) : undefined;
  // A preview never lands recipes in the store: the engine compiles straight from the given directory instead.
  // Recipes are the one write that precedes compile, so the refusals run first and a fresh adapter rolls back on a lint failure.
  const fresh = engine === 'desktop' && flags.recipes && !dry && !existsSync(manifestDir(name));
  if (engine === 'desktop' && flags.recipes && !dry) { canWriteLauncher(name, { force: !!flags.force }); canWriteSkill(name, { force: !!flags.force }); importRecipes(name, flags.recipes, { verb: flags.verb }); }
  if (engine === 'desktop' && flags.recipes && dry && (flags.recipes === '-' || !existsSync(flags.recipes) || !statSync(flags.recipes).isDirectory())) fail('--dry-run needs a recipes directory; a single file or - has to be imported first');
  let m;
  try {
    m = normalizeManifest(await engines[engine].compile(source, { name, goal: flags.goal, verbs: flags.verbs, tag: flags.tag, host: flags.host, url: flags.url, ...(dry && flags.recipes ? { recipes: flags.recipes } : {}) }));
    const errs = lint(m);
    // Over budget is a choice about which verbs to keep, so the error carries the names --verbs would take.
    if (errs.some(e => /^describe is \d+ chars/.test(e))) errs.push(`verbs: ${m.verbs.slice(0, 30).map(v => v.name).join(', ')}${m.verbs.length > 30 ? ` ... (${m.verbs.length} total)` : ''}`);
    if (errs.length) fail(lintFailMsg(errs), EXIT.ERROR, lintErrorsData(errs));
  } catch (e) {
    if (fresh) rmSync(manifestDir(name), { recursive: true, force: true });
    throw e;
  }
  if (dry) return m;
  // Every check that can refuse runs before the first write, so a refusal leaves no half-built adapter.
  canWriteLauncher(m.name, { force: !!flags.force }); canWriteSkill(m.name, { force: !!flags.force });
  saveManifest(m); writeLauncher(m.name, { force: !!flags.force }); writeSkill(m, { force: !!flags.force }); writeSelfSkill(commandRows(), VERSION);
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

// What removeAdapter would unlink: the shims that exist, and only the skill dirs declick itself wrote.
const launcherPaths = name => [join(binDir(), `${name}.cmd`), join(binDir(), name)].filter(p => existsSync(p));
const skillPaths = name => skillDirs().map(d => join(d, name)).filter(p => existsSync(join(p, 'SKILL.md')) && readFileSync(join(p, 'SKILL.md'), 'utf8').includes('Generated by declick'));

// Chrome is a browser engine's dependency, not declick's: found by CHROME, then the platform's install path, then Edge.
const CHROME_PATHS = {
  win32: [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};
function findChrome() {
  if (process.env.CHROME) return { path: process.env.CHROME, from: 'CHROME', found: existsSync(process.env.CHROME) };
  const p = (CHROME_PATHS[process.platform] || []).find(x => x && existsSync(x));
  if (p) return { path: p, from: 'default install path', found: true };
  const w = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge'].map(which).find(Boolean);
  return w ? { path: w, from: 'PATH', found: true } : { path: null, from: null, found: false };
}

async function toolProbes() {
  const bin = (name, note) => { const p = which(name); return { name, ready: !!p, path: p, note: p ? `${p}` : note }; };
  const chrome = findChrome();
  let sqlite = null;
  try { await import('node:sqlite'); sqlite = true; } catch (e) { sqlite = e.message; }
  return [
    bin('mcporter', 'optional: npm i -g mcporter to reuse an existing mcp client config'),
    bin('opencli', 'optional: not on npm today; declick drives the web engine itself'),
    { name: 'chrome', ready: chrome.found, path: chrome.path, note: chrome.found ? `${chrome.path} (${chrome.from})` : 'no chrome or edge found; set CHROME=<path> for browser verbs' },
    { name: 'sqlite', ready: sqlite === true, note: sqlite === true ? 'node:sqlite is built in' : `node:sqlite unavailable: ${sqlite}` },
  ];
}

// Governance as data: is it on, where does it point, does it answer, and does a failure block or warn.
async function governanceState() {
  const enabled = !!process.env.DASHCLAW_API_KEY;
  const { url, error } = guardUrl();
  const state = { enabled, url: process.env.DASHCLAW_URL || null, strict: isStrict(), reachable: null, ...(enabled && error ? { error } : {}) };
  if (!enabled || error) return state;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); state.reachable = r.status < 500; }
  catch { state.reachable = false; }
  return state;
}

// The audit log is append-only jsonl written by bin/run.mjs; newest first, because that is what gets asked.
const sinceTime = v => {
  const rel = /^(\d+)\s*([smhd])$/.exec(String(v).trim());
  if (rel) return Date.now() - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2]];
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) fail(`--since ${JSON.stringify(String(v))} must be an ISO time or a duration like 10m, 2h, 3d`);
  return t;
};
function auditRows({ adapter, since, failed }) {
  const p = join(HOME, 'audit.jsonl');
  if (!existsSync(p)) return [];
  const from = since === undefined ? null : sinceTime(since);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse()
    .filter(r => (!adapter || r.adapter === adapter) && (!failed || r.ok === false) && (from === null || Date.parse(r.at) >= from));
}

async function doctor() {
  const node = process.versions.node;
  const claude = which(process.env.DECLICK_CLAUDE || 'claude');
  const d = deskState();
  const adapters = listManifests();
  const probes = await toolProbes();
  // sqlite is both a compile target (ENGINE_INFO) and a runtime tool probe (node:sqlite); merge into one row.
  const probeByName = new Map(probes.map(p => [p.name, p]));
  const engineRows = ENGINE_INFO.map(e => probeByName.has(e.name) ? { ...e, ready: probeByName.get(e.name).ready, note: probeByName.get(e.name).note } : e);
  const checks = {
    node: { version: node, ok: Number(node.split('.')[0]) >= 24, need: '>=24' },
    home: { path: HOME, exists: existsSync(HOME), adapters: adapters.length },
    bin: { path: binDir(), onPath: onPath(), fix: onPath() ? null : `declick path --install (or: ${pathHint()})` },
    skills: skillDirs().map(p => ({ path: p, exists: existsSync(p) })),
    vault: { path: vaultPath(), exists: existsSync(vaultPath()) },
    desk: d,
    claude: { path: claude, found: !!claude, note: 'needed for declick add --goal / author / repair' },
    governance: await governanceState(),
    // Engines and the external tools they can use, in one list: one call answers "what can I build from this machine".
    engines: [...engineRows, ...probes.filter(p => !ENGINE_INFO.some(e => e.name === p.name))],
  };
  const blocking = [], warnings = [];
  if (!checks.node.ok) blocking.push(`node ${node} is below 24; declick needs >=24`);
  if (checks.governance.error) blocking.push(checks.governance.error);
  else if (checks.governance.reachable === false) warnings.push(`governance endpoint ${checks.governance.url} did not answer in 2s; strict mode blocks every mutating verb`);
  if (adapters.some(n => readJson(join(manifestDir(n), 'manifest.json'))?.engine === 'desktop') && !d.exists) blocking.push(`deskclaw missing at ${d.path}; desktop verbs cannot run`);
  if (!checks.bin.onPath) warnings.push(`${binDir()} is not on PATH; ${checks.bin.fix}`);
  // healthy, not ok: an agent reading data.ok next to the envelope's ok cannot tell which one refused.
  return { healthy: !blocking.length, blocking, warnings, problems: [...blocking, ...warnings], ...checks };
}

// What a source would compile to, decided before anything is written: the router first, then the first 4KB of the file.
const SNIFF = [
  { re: /"(openapi|swagger)"\s*:\s*"/, format: 'openapi spec', engine: 'openapi' },
  { re: /schema\.getpostman\.com|"_postman_id"/, format: 'postman collection', engine: null },
  { re: /"_type"\s*:\s*"(export|request|workspace)"/, format: 'insomnia export', engine: null },
  { re: /"log"\s*:\s*\{[\s\S]{0,200}"entries"/, format: 'har capture', engine: null },
  { re: /"__schema"\s*:/, format: 'graphql introspection', engine: null },
];
function peek(source) {
  try {
    if (!existsSync(source) || !statSync(source).isFile()) return null;
    const fd = openSync(source, 'r'); const buf = Buffer.alloc(4096);
    try { return buf.subarray(0, readSync(fd, buf, 0, 4096, 0)).toString('utf8'); } finally { closeSync(fd); }
  } catch { return null; }
}
function sniffSource(source) {
  let engine, why;
  // pickEngine already content-sniffs a local file; the SNIFF table only guesses when pickEngine has nothing to route on.
  try { engine = pickEngine(source); why = `${source} routes to the ${engine} engine`; }
  catch (e) {
    const hit = SNIFF.find(s => s.re.test(peek(source) || ''));
    engine = hit?.engine ?? null;
    why = hit ? `the first 4KB looks like a ${hit.format}${hit.engine ? '' : ', which no engine in this build reads'}` : e.message;
  }
  const info = ENGINE_INFO.find(e => e.name === engine);
  const ready = !!info?.ready;
  const next = !engine ? 'declick engines lists what this build can compile'
    : ready && engine === 'web' && !/^web:/i.test(source) ? `declick add web:${/\s/.test(source) ? JSON.stringify(source) : source} --recipes <dir>`
    : ready ? `declick add ${/\s/.test(source) ? JSON.stringify(source) : source}${engine === 'desktop' ? ' --name <name>' : ''}`
      : `${engine} is not ready here: ${info?.note ?? 'unsupported on this platform'}`;
  return { engine, ready, why, next };
}

// A bundle an agent can copy, edit and import without ever seeing a real one: one read verb and one mutating verb.
const EXAMPLE_BUNDLE = {
  manifest: {
    name: 'example-api', engine: 'openapi', source: 'https://example.test/openapi.json', builtAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test/v1',
    auth: { env: ['EXAMPLE_API_KEY'], schemes: { api_key: { type: 'apiKey', in: 'header', name: 'x-api-key', env: 'EXAMPLE_API_KEY' } } },
    verbs: [
      { name: 'list-things', description: 'List every thing', mutating: false, args: [],
        flags: [{ name: 'status', description: 'filter by status', required: false, type: 'string', example: 'open' }],
        returns: { shape: 'object', rowsPath: 'items', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }] },
        http: { method: 'get', path: '/things', query: ['status'], bodyProps: [], security: [['api_key']] } },
      { name: 'create-thing', description: 'Create one thing', mutating: true, args: [],
        flags: [{ name: 'name', description: 'what to call it', required: true, type: 'string', example: 'widget' }],
        returns: { shape: 'object', fields: [{ name: 'id', type: 'string' }] },
        http: { method: 'post', path: '/things', query: [], bodyProps: ['name'], bodyType: 'application/json', security: [['api_key']] } },
    ],
  },
  recipes: {},
};

const S = (field, type, required, description) => ({ field, type, required, description });
const MANIFEST_SCHEMA = {
  manifest: [S('name', 'string', true, 'kebab-case adapter id; the launcher and SKILL.md take this name'), S('engine', 'string', true, `one of ${ENGINE_INFO.map(e => e.name).join(', ')}`),
    S('source', 'string', true, 'what it was compiled from: a spec path, a URL, or app:<window title>'), S('builtAt', 'string', false, 'ISO timestamp of the last build'),
    S('baseUrl', 'string', false, 'openapi: absolute http(s) url with no {variables}'), S('window', 'string', false, 'desktop: the window title verbs act on'),
    S('auth.env', 'string[]', true, 'env key names a verb may need; empty array when none'), S('auth.schemes', 'object', false, 'openapi security schemes, each with the env key that fills it'),
    S('verbs', 'verb[]', true, 'non-empty; every verb is one command')],
  verb: [S('name', 'string', true, 'kebab-case, unique, never "describe"'), S('description', 'string', true, 'one line, 80 chars or fewer'), S('mutating', 'boolean', true, 'true means it writes: guarded, and it accepts --dry-run'),
    S('args', 'arg[]', true, 'positional arguments in order'), S('flags', 'flag[]', false, 'named flags; none may collide with a contract flag'),
    S('returns', 'returns', false, 'what comes back, so --fields and --rows work without calling it first'),
    S('http', 'object', false, 'openapi: {method, path, query, bodyProps, bodyType, security}'), S('recipe', 'object', false, 'desktop: {steps, returns, tree}')],
  arg: [S('name', 'string', true, 'kebab-case; a path parameter must match its {placeholder}'), S('required', 'boolean', false, 'false renders as [name] in describe'),
    S('type', 'string', false, 'string, number, integer, boolean, array'), S('example', 'string', false, 'a real value; SKILL.md spends it instead of a token'), S('enum', 'string[]', false, 'the only values accepted')],
  flag: [S('name', 'string', true, 'kebab-case; --json --fields --limit --rows --dry-run --full --help are reserved'), S('description', 'string', true, 'one line'),
    S('required', 'boolean', false, 'a required flag appears in every generated example'), S('type', 'string', false, 'boolean flags never eat the next argument'),
    S('example', 'string', false, 'a real value; SKILL.md spends it instead of a token'), S('enum', 'string[]', false, 'the only values accepted')],
  returns: [S('shape', 'string', true, 'array, object, scalar or none'), S('fields', 'field[]', false, 'each {name, type}; what --fields can select'),
    S('rowsPath', 'string', false, 'dotted path to the row array; --rows defaults to it')],
};

const EXIT_CODES = [{ code: 0, meaning: 'ok' }, { code: 1, meaning: 'error' }, { code: 2, meaning: 'not found' },
  { code: 3, meaning: 'blocked by governance, or a desktop that is not armed' }, { code: 4, meaning: 'auth needed: declick auth <name>' }];
// Only the contract flags this adapter can actually use: --rows without a rowsPath and --dry-run without a mutating verb are noise.
const commonFlags = m => [
  { name: '--json', description: 'the envelope; already the default when piped' },
  { name: '--fields a,b', description: 'keep only these fields (dotted paths)' },
  { name: '--limit N', description: 'first N rows' },
  ...(m.verbs.some(v => v.returns?.rowsPath) ? [{ name: '--rows path', description: 'unwrap a nested array' }] : []),
  ...(m.verbs.some(v => v.mutating) ? [{ name: '--dry-run', description: 'preview a mutating verb, change nothing' }] : []),
  ...(m.verbs.some(v => (v.flags || []).length) ? [{ name: '--full', description: 'per-verb flags and the auth keys' }] : []),
  { name: '--help', description: 'one verb: its flags and what it returns' },
];
// describe() is shared with the runtime, so the invocation line and the narrowed common line are patched onto its text here.
function describeText(m, { full, only, grep }) {
  const verbs = only ? m.verbs.filter(v => only.has(v.name)) : m.verbs;
  const lines = describe({ ...m, verbs }, { full }).split('\n');
  lines.splice(1, 0, `run: ${m.name} <verb> [args] [--flags]   or: declick run ${m.name} <verb> ...`);
  if (!verbs.length) lines.splice(2, 0, `  no verb matches --grep ${grep}`);
  const common = `common: ${commonFlags(m).map(f => f.name.split(' ')[0]).join(' ')}   exit: 0 ok 1 err 2 missing 3 blocked 4 auth`;
  const i = lines.findIndex(l => l.startsWith('common: '));
  if (i > -1) lines[i] = common; else lines.push(common);
  return lines.join('\n');
}

const raw = process.argv.slice(2);
let flags = {}, positional = [];
// Every boolean in the command table is a boolean to the parser too, so `--interactive Calculator` keeps its window.
const MGMT_BOOLS = new Set([...BOOLS, ...COMMANDS.flatMap(c => c.flags.filter(f => f.type === 'boolean').map(f => camel(f.name)))]);
// A malformed flag (--limit 0) is a failure like any other: the envelope on stdout when --json was asked for or
// stdout is piped, one error line otherwise. flags is still {} here, so read --json straight off the raw tokens.
const explicitJson = () => {
  const end = raw.indexOf('--'); const scan = end === -1 ? raw : raw.slice(0, end);
  for (let i = scan.length - 1; i >= 0; i--) {
    const a = scan[i]; if (!a.startsWith('--')) continue;
    const [k, eq] = a.slice(2).split('=');
    if (k === 'no-json') return false;
    if (k !== 'json') continue;
    const val = eq ?? (scan[i + 1] === 'true' || scan[i + 1] === 'false' ? scan[i + 1] : 'true');
    return val !== 'false';
  }
  return undefined;
};
try { ({ positional, flags } = parseFlags(raw, MGMT_BOOLS)); } catch (e) {
  const code = e.exit ?? 1;
  if (explicitJson() ?? !process.stdout.isTTY) process.stdout.write(JSON.stringify({ ok: false, error: e.message, exit: code }) + '\n');
  else process.stderr.write(`error: ${e.message}\n`);
  process.exit(code);
}
const [cmd, arg, arg2] = positional;
const json = flags.json ?? !process.stdout.isTTY;
const dry = !!flags.dryRun;
const row = cmd ? byName(cmd) : null;
// Only a command that would write has a preview to mark and protect from --fields; on a read-only one --dry-run changes nothing.
const preview = dry && !!row?.dryRun && (cmd !== 'desk' || ['arm', 'disarm', 'clipboard'].includes(arg)) && (cmd !== 'path' || !!flags.install);
const CONTRACT = ['json', 'fields', 'limit', 'rows', 'dry-run', 'help', 'version'];
const kebabOf = s => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

// A flag declick does not know is a typo, and a typo that swallowed the next word is why the positional went missing.
function checkFlags(c) {
  const known = new Set([...CONTRACT.map(camel), ...c.flags.flatMap(f => [f.name, camel(f.name)])]);
  const bad = Object.keys(flags).find(k => !known.has(k));
  if (!bad) return;
  const i = raw.findIndex(t => t.startsWith('--') && camel(t.slice(2).split('=')[0]) === bad);
  const token = i > -1 ? raw[i].split('=')[0] : `--${kebabOf(bad)}`;
  const ate = i > -1 && !raw[i].includes('=') && raw[i + 1] !== undefined && !raw[i + 1].startsWith('--') ? raw[i + 1] : null;
  // No command at all: there is no per-command flag list to be near, so a guess only counts on a one-character typo.
  if (!cmd) { const near = nearest(kebabOf(bad), CONTRACT, 1, 1); fail(`unknown flag ${token}${ate ? ` (it consumed ${JSON.stringify(ate)})` : ''}${near.length ? `; did you mean --${near[0]}?` : ''}; run: declick help`); }
  const near = nearest(kebabOf(bad), [...c.flags.map(f => f.name), ...CONTRACT], 3, 1);
  fail(`unknown flag ${token} for ${c.name}${ate ? ` (it consumed ${JSON.stringify(ate)})` : ''}${near.length ? `; did you mean --${near[0]}?` : ''}; run: declick ${c.name} --help`);
}

function checkPositionals(c) {
  if (c.flags.some(f => f.bare && flags[camel(f.name)])) return;
  if (c.positionals.some((p, i) => p.required && positional[i + 1] === undefined)) fail(`usage: ${usageOf(c)}\n  ${c.summary}; run: declick ${c.name} --help`);
}
let result, text;

try {
  if (cmd && !row) fail(unknownCommand(cmd));
  // run forwards everything after the name to the verb, whose flags are the manifest's, not this table's.
  if (row && cmd !== 'run') checkFlags(row);
  else if (!cmd) checkFlags(byName('help'));
  // Authoring drives a live app through Claude and ui blocks on a server: neither has a preview to show.
  if (dry && ['author', 'repair', 'ui'].includes(cmd)) fail(`no preview for ${cmd}`);
  if (dry && cmd === 'add' && flags.goal && !flags.recipes) fail('no preview for add --goal');
  if (row && cmd !== 'run' && !flags.help) checkPositionals(row);
  if (flags.help && row && !(cmd === 'run' && arg)) { result = { ok: true, data: { ...row, usage: usageOf(row) } }; text = helpText(row); }
  else if (cmd === 'help' && arg) { const c = byName(arg) || fail(unknownCommand(arg)); result = { ok: true, data: { ...c, usage: usageOf(c) } }; text = helpText(c); }
  else if (flags.version && !cmd) { result = { ok: true, data: { version: VERSION, node: process.versions.node } }; text = VERSION; }
  else switch (cmd) {
    case 'add': {
      const source = arg;
      const m = pickEngine(source, flags.engine) === 'desktop' && flags.goal && !flags.recipes
        ? await authorVerb(adapterName(source, flags), source.replace(/^app:/, ''), flags)
        : await build(source, flags, dry);
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'run': {
      const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'run.mjs'), ...raw.slice(1)], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    case 'author': {
      const old = loadManifest(arg);
      if (old.engine !== 'desktop') fail(`${arg} is a ${old.engine} adapter; author works on desktop adapters`);
      const m = await authorVerb(arg, old.window, { ...flags, name: arg });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'repair': {
      const old = loadManifest(arg);
      const recipe = loadRecipe(arg, arg2);
      const le = readJson(join(manifestDir(arg), 'last-error.json')) || { error: 'no recorded failure', diff: { missing: [], added: [] } };
      const m = await authorVerb(arg, old.window, { ...flags, name: arg, verb: arg2 }, { verb: arg2, recipe, diff: le.diff, error: le.error });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'accept': {
      const p = proposals(arg).find(x => x.verb === arg2) || fail(`no proposal ${arg2} for ${arg}; run: declick proposals ${arg}`, EXIT.NOT_FOUND);
      if (dry) { result = { ok: true, data: { wouldAccept: arg2, then: 'rebuild' } }; break; }
      const old = readJson(join(manifestDir(arg), 'manifest.json'));
      importRecipes(arg, p.path, { verb: arg2 }); rmSync(p.path, { force: true });
      const m = await build(old?.source || `app:${p.recipe.window || arg}`, { ...flags, name: arg });
      result = { ok: true, data: describeJson(m) }; text = describe(m); break;
    }
    case 'build': { const old = loadManifest(arg); const m = await build(old.source, { ...flags, name: arg, engine: old.engine }, dry); result = { ok: true, data: describeJson(m) }; text = describe(m); break; }
    case 'describe': {
      // The command surface is data too: describe declick is the same table as declick commands.
      if (arg === 'declick') { result = { ok: true, data: commandRows() }; text = USAGE; break; }
      const m = loadManifest(arg);
      const full = !!flags.full;
      const off = flags.offset === undefined ? 0 : Number(flags.offset);
      if (!Number.isInteger(off) || off < 0) fail(`--offset must be a non-negative integer, got ${flags.offset}`);
      const payload = describeJson(m, { verb: flags.verb });
      if (flags.verb && !payload.verbs.length) fail(`unknown verb ${flags.verb} for ${arg}; run: declick describe ${arg}`, EXIT.NOT_FOUND);
      const q = flags.grep === undefined ? null : String(flags.grep).toLowerCase();
      const hits = q ? payload.verbs.filter(v => `${v.name} ${v.description}`.toLowerCase().includes(q)) : payload.verbs;
      const shown = hits.slice(off, flags.limit === undefined ? undefined : off + flags.limit);
      // Flags and auth are the expensive half of a describe: an agent pays for them only with --full.
      const data = { ...payload, verbCount: m.verbs.length, commonFlags: commonFlags(m), exitCodes: EXIT_CODES,
        verbs: shown.map(v => (full ? v : { name: v.name, description: v.description, mutating: v.mutating, args: v.args, returns: v.returns })) };
      if (!full) delete data.auth;
      result = { ok: true, data };
      text = describeText(m, { full, only: new Set(shown.map(v => v.name)), grep: flags.grep }); break;
    }
    case 'manifest': {
      if (flags.schema) { result = { ok: true, data: MANIFEST_SCHEMA }; text = JSON.stringify(MANIFEST_SCHEMA, null, 2); break; }
      const m = loadManifest(arg); result = { ok: true, data: flags.verb ? { ...m, verbs: m.verbs.filter(v => v.name === flags.verb) } : m }; text = JSON.stringify(result.data, null, 2); break;
    }
    case 'lint': { const errs = lint(loadManifest(arg)); result = errs.length ? { ok: false, exit: EXIT.ERROR, error: `${arg}: ${errs.length} contract error(s)`, data: lintErrorsData(errs) } : { ok: true, data: { name: arg, errors: [], verbs: loadManifest(arg).verbs.length } }; text = errs.length ? errs.join('\n') : `${arg}: contract ok (${result.data.verbs} verbs)`; break; }
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
    case 'audit': {
      if (flags.adapter === true) fail('--adapter needs an adapter name; run: declick list');
      if (flags.since === true) fail('--since needs an ISO time or a duration like 10m, 2h, 3d');
      const rows = auditRows({ adapter: flags.adapter, since: flags.since, failed: flags.failed === true || flags.failed === 'true' });
      result = { ok: true, data: rows };
      text = rows.length ? rows.map(r => `${r.at}\t${r.adapter} ${r.verb ?? ''}\t${r.ok ? 'ok' : `exit ${r.exit}`}\t${r.governance?.decision ?? '-'}\t${r.ms}ms`).join('\n') : `no runs logged yet in ${join(HOME, 'audit.jsonl')}`;
      break;
    }
    case 'doctor': {
      const d = await doctor(); text = JSON.stringify(d, null, 2);
      // A warning is worth saying out loud without failing the command: ok stays true and the exit code stays 0.
      result = d.blocking.length ? { ok: false, exit: EXIT.ERROR, error: d.blocking.join('; '), data: d } : { ok: true, data: d }; break;
    }
    case 'auth': {
      const m = loadManifest(arg);
      const { found, missing } = loadEnv(m.auth.env || []);
      const keys = (m.auth.env || []).map(n => ({ name: n, present: n in found, source: process.env[n] ? 'env' : n in found ? 'vault' : null }));
      const data = { name: arg, vault: vaultPath(), keys, missing };
      result = missing.length ? { ok: false, exit: EXIT.AUTH, error: `missing ${missing.join(', ')}; set them in the environment or ${vaultPath()}${mintHint(arg)}; a verb needs only one of its alternatives, see declick manifest ${arg}`, data } : { ok: true, data };
      text = keys.map(k => `${k.name}\t${k.present ? k.source : 'missing'}`).join('\n') || 'no auth needed'; break;
    }
    case 'engines': {
      if (flags.source === true) fail('--source needs a spec file, a url or app:<window title>');
      result = { ok: true, data: flags.source ? sniffSource(String(flags.source)) : ENGINE_INFO }; break;
    }
    case 'path': {
      const data = { home: HOME, bin: binDir(), onPath: onPath(), skills: skillDirs(), fix: onPath() ? null : pathHint() };
      if (flags.install && !data.onPath) {
        if (dry) data.installed = null;
        else if (process.platform === 'win32') { const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH','User') + ';${binDir()}', 'User')`], { encoding: 'utf8' }); if (r.status !== 0) fail(`could not update user PATH: ${r.stderr.trim()}`); data.installed = 'user PATH (new shells only)'; }
        else { const file = profileFile(); const fish = file.endsWith('config.fish'); mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `\n${fish ? `fish_add_path "${binDir()}"` : `export PATH="$PATH:${binDir()}"`}\n`); data.installed = `${file.replace(homedir(), '~')} (new shells only)`; }
      }
      result = { ok: true, data }; break;
    }
    case 'proposals': {
      const rows = proposals(arg).map(p => ({ verb: p.verb, path: p.path, description: p.recipe?.description ?? null, accept: `declick accept ${arg} ${p.verb}` }));
      result = { ok: true, data: rows }; if (!rows.length) text = `no proposals for ${arg}; one is kept here when an authored verb fails its replay`; break;
    }
    case 'recipes': {
      const m = loadManifest(arg);
      const rows = listRecipes(arg).map(v => ({ verb: v, path: join(recipesDir(arg), `${v}.json`) }));
      result = { ok: true, data: rows }; if (!rows.length) text = `no recipes for ${arg}; only desktop adapters store them and this one is ${m.engine}`; break;
    }
    case 'recipe': { result = { ok: true, data: loadRecipe(arg, arg2) }; text = JSON.stringify(result.data, null, 2); break; }
    case 'skill': {
      // --print never touches disk: it hands back the same text writeSkill would have written, for an agent that wants to read it without a file.
      if (flags.print) {
        if (!arg) fail('usage: declick skill <name> --print');
        const t = skillText(loadManifest(arg));
        result = { ok: true, data: { name: arg, text: t } }; text = t; break;
      }
      const names = arg ? [arg] : listManifests();
      if (dry) { const wouldWrite = names.flatMap(n => (loadManifest(n), skillDirs().map(d => join(d, n, 'SKILL.md')))).concat(skillDirs().map(d => join(d, 'declick', 'SKILL.md'))); result = { ok: true, data: { wouldWrite } }; text = wouldWrite.join('\n'); break; }
      const written = names.flatMap(n => writeSkill(loadManifest(n), { force: !!flags.force })).concat(writeSelfSkill(commandRows(), VERSION));
      result = { ok: true, data: { written } }; text = written.join('\n'); break;
    }
    case 'remove': {
      if (arg2) {
        const old = loadManifest(arg);
        if (!old.verbs.some(v => v.name === arg2)) fail(`unknown verb ${arg2} for ${arg}; run: declick describe ${arg}`, EXIT.NOT_FOUND);
        // Only desktop adapters keep a file per verb; an openapi verb comes back on the next build unless the spec selection changes.
        if (old.engine !== 'desktop') fail(`${arg} is a ${old.engine} adapter: its verbs come from ${old.source}, not from per-verb files. Rebuild with the verbs you want: declick add ${old.source} --name ${arg} --verbs a,b --force`);
        const left = listRecipes(arg).filter(v => v !== arg2);
        if (!left.length && !flags.force) fail(`${arg} ${arg2} is the last recipe; removing it deletes the whole adapter. Pass --force, or: declick remove ${arg}`);
        if (dry) { result = { ok: true, data: { wouldRemove: `${arg} ${arg2}`, remaining: left, adapterRemoved: !left.length } }; text = `would remove ${arg} ${arg2}`; break; }
        removeRecipe(arg, arg2);
        if (!left.length) { const gone = removeAdapter(arg); result = { ok: true, data: { removed: `${arg} ${arg2}`, remaining: [], adapterRemoved: true, launcher: gone.launcher, skill: gone.skill } }; text = `removed ${arg} (no verbs left)`; break; }
        const m = await build(old.source, { ...flags, name: arg });
        result = { ok: true, data: { removed: `${arg} ${arg2}`, remaining: left, adapterRemoved: false } }; text = describe(m); break;
      }
      if (dry) { loadManifest(arg); result = { ok: true, data: { wouldRemove: { manifest: manifestDir(arg), launcher: launcherPaths(arg), skill: skillPaths(arg) } } }; text = `would remove ${arg}`; break; }
      result = { ok: true, data: removeAdapter(arg) }; text = `removed ${arg}`;
      break;
    }
    case 'export': { const m = loadManifest(arg); const recipes = Object.fromEntries(listRecipes(arg).map(v => [v, loadRecipe(arg, v)])); result = { ok: true, data: { manifest: m, recipes } }; text = JSON.stringify(result.data, null, 2); break; }
    case 'import': {
      if (flags.example) {
        const eng = flags.engine === undefined || flags.engine === true ? 'openapi' : String(flags.engine);
        if (eng !== 'openapi') fail(`--example prints an openapi bundle only; a ${eng} bundle comes from declick export <name>`);
        result = { ok: true, data: EXAMPLE_BUNDLE }; text = JSON.stringify(EXAMPLE_BUNDLE, null, 2); break;
      }
      const src = !arg || arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
      let bundle = JSON.parse(src);
      // export (and import --example) print the {ok,data,meta} envelope whenever stdout is piped or redirected, which is the common case; unwrap it here so the round trip works without asking for --json false.
      if (bundle.ok === true && bundle.data?.manifest) bundle = bundle.data;
      // import takes an untrusted bundle (a file, or stdin), not a spec fetched from a vendor: lint runs on
      // the raw manifest, same as always, so injected multi-line/backtick/leading-# text is refused outright
      // instead of silently flattened by normalizeManifest and accepted. saveManifest below still normalizes
      // benign long text on the way to disk, once lint has already cleared the hostile cases.
      const m = bundle.manifest || fail('bundle needs a manifest field');
      const errs = lint(m); if (errs.length) fail(lintFailMsg(errs), EXIT.ERROR, lintErrorsData(errs));
      const recipes = Object.entries(bundle.recipes || {});
      for (const [verb, recipe] of recipes) { const e = validateStoredRecipe(recipe); if (e.length) fail(`invalid recipe ${verb}.json: ${e.join('; ')}`); }
      // Importing over an adapter that answers to a different service is a silent hijack; name what moved.
      const old = readJson(join(manifestDir(m.name), 'manifest.json'));
      const diff = Object.fromEntries(['source', 'engine', 'baseUrl'].map(k => [k, [old?.[k] ?? null, m[k] ?? null]]).filter(([, [a, b]]) => old && a !== b));
      if (Object.keys(diff).length && !flags.force) { result = { ok: false, exit: EXIT.ERROR, error: `${m.name} already exists with a different ${Object.keys(diff).join(', ')}; declick import ${arg || '-'} --force replaces it`, data: { diff } }; break; }
      if (dry) { result = { ok: true, data: describeJson(m) }; text = describe(m); break; }
      canWriteLauncher(m.name, { force: !!flags.force }); canWriteSkill(m.name, { force: !!flags.force });
      const had = { manifest: !!old, launcher: launcherPaths(m.name).length > 0, skill: skillPaths(m.name).length > 0 };
      try {
        saveManifest(m);
        for (const [verb, recipe] of recipes) { const tmp = join(manifestDir(m.name), `${verb}.import.json`); writeFileSync(tmp, JSON.stringify(recipe)); importRecipes(m.name, tmp, { verb }); rmSync(tmp, { force: true }); }
        writeLauncher(m.name, { force: !!flags.force }); writeSkill(m, { force: !!flags.force });
      } catch (e) {
        if (!had.manifest) rmSync(manifestDir(m.name), { recursive: true, force: true });
        if (!had.launcher) removeLauncher(m.name);
        if (!had.skill) removeSkill(m.name);
        throw e;
      }
      result = { ok: true, data: { ...describeJson(m), ...(old ? { replaced: { source: old.source, builtAt: old.builtAt ?? null } } : {}) } }; text = describe(m); break;
    }
    case 'desk': {
      if (!arg || arg === 'status') { result = { ok: true, data: deskState() }; break; }
      if ((arg === 'arm' || arg === 'disarm') && dry) { result = { ok: true, data: { wouldRun: `desk ${arg}${arg2 ? ` ${arg2}` : ''}`, ...deskState() } }; break; }
      if (arg === 'arm' || arg === 'disarm') { const r = desk(arg, ...(arg2 ? [arg2] : [])); if (r.code) fail(`desk ${arg} exited ${r.code}: ${r.err || r.out}`, r.code === 3 ? EXIT.BLOCKED : EXIT.ERROR); result = { ok: true, data: { ...deskState(), output: r.out } }; break; }
      // deskclaw is PowerShell: Write-Error arrives wrapped in terminal colour, which is noise in an envelope.
      const plain = s => String(s || '').replace(/\u001b\[[0-9;]*m/g, '').replace(/Write-Error:\s*/g, '').replace(/\s+/g, ' ').trim();
      // deskclaw's exit code says why it refused; keep it instead of flattening every refusal to 1.
      const deskFail = (r, what) => fail(plain(r.code === 4 ? `deskclaw is not armed; run: declick desk arm 30 (${r.err || what})`
        : r.code === 3 ? `deskclaw STOP is set (${r.err || what})` : `${what}: ${r.err || `exited ${r.code}`}`),
      r.code === 3 || r.code === 4 ? EXIT.BLOCKED : r.code === 2 ? EXIT.NOT_FOUND : EXIT.ERROR);
      if (arg === 'windows') {
        const r = desk('windows'); if (r.code) deskFail(r, 'desk windows');
        const num = v => (v === undefined ? null : Number(v));
        const data = r.out.split(/\r?\n/).map(l => l.trim()).filter(l => /^@w\d+\b/.test(l)).map(l => {
          const ref = /^@w\d+/.exec(l)[0], rest = l.slice(ref.length).trim();
          const skipped = /^\[SKIPPED: ([^\]]+)\]/.exec(rest);
          if (skipped) return { ref, title: null, skipped: skipped[1] };
          // 0.2 printed only the title and the process; 0.3 adds the window class and [x,y,w,h].
          const w = /^"(.*)" \(([^,]+), (\d+)\)(?: ([^\s[]+))?(?: \[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\])?/.exec(rest);
          if (!w) return { ref, title: rest, process: null, pid: null, class: null, x: null, y: null, w: null, h: null, focused: false };
          return { ref, title: w[1], process: w[2], pid: Number(w[3]), class: w[4] ?? null, x: num(w[5]), y: num(w[6]), w: num(w[7]), h: num(w[8]), focused: /\bfocused=true\b/.test(rest) };
        });
        result = { ok: true, data }; text = r.out; break;
      }
      if (arg === 'clipboard') {
        if (arg2 === 'get') { const r = desk('clipboard', 'get'); if (r.code) deskFail(r, 'desk clipboard get'); result = { ok: true, data: { text: r.out } }; text = r.out; break; }
        if (arg2 !== 'set') fail('usage: declick desk clipboard get | declick desk clipboard set "<text>"');
        const value = positional[3];
        if (value === undefined) fail('usage: declick desk clipboard set "<text>"');
        if (dry) { result = { ok: true, data: { wouldRun: 'desk clipboard set', chars: value.length } }; break; }
        // The text itself never reaches the governance log: its length is the only safe fact about a clipboard.
        const { guard } = await import('../src/guard.mjs');
        const g = await guard({ tool: 'declick', action: 'desk clipboard set', engine: 'desktop', target: 'clipboard', args: { chars: value.length } });
        if (!g.allowed) fail(`blocked by governance: ${g.reason}`, EXIT.BLOCKED);
        const r = desk('clipboard', 'set', value); if (r.code) deskFail(r, 'desk clipboard set');
        result = { ok: true, data: { set: true, chars: value.length } }; text = r.out; break;
      }
      if (arg !== 'tree' && arg !== 'read') fail('usage: declick desk status | arm [minutes] | disarm | windows | tree <window> | read <window> <Type:Name ...> | clipboard get|set <text>');
      // deskclaw 0.3 appends key=value after the coordinates. desktop-tree owns the 0.2 grammar, so the
      // attributes are lifted off by ref here and merged back, whatever that parser learns to keep next.
      const attrsOf = s => Object.fromEntries([...s.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)]
        .map(([, k, v]) => [k, v.startsWith('"') ? JSON.parse(v) : v === 'true' ? true : v === 'false' ? false : v]));
      const treeOf = async title => {
        const { parseSnapshot } = await import('../src/engines/desktop-tree.mjs');
        const r = desk('snapshot', title);
        const extra = {}; const lines = [];
        for (const line of r.out.split(/\r?\n/)) {
          const rich = !/^\s*@e\d+ \S+ ".*" \[-?\d+,-?\d+\]\s*$/.test(line) && /^(\s*@e\d+ \S+ ".*?" \[-?\d+,-?\d+\]) +(.+)$/.exec(line);
          if (rich) { extra[/@e\d+/.exec(rich[1])[0]] = attrsOf(rich[2]); lines.push(rich[1]); } else lines.push(line);
        }
        const els = parseSnapshot(lines.join('\n'));
        // No tree at all is a window that is not open; deskclaw's own exit code says which failure it was.
        if (!els.length) deskFail({ code: r.code || EXIT.NOT_FOUND, err: r.err }, `window "${title}" is not open; run: declick desk windows`);
        const stack = [];
        return els.map(e => {
          stack[e.depth] = `${e.type}:${e.name}`; const a = extra[e.ref] || {};
          return { ref: e.ref, depth: e.depth, path: stack.slice(0, e.depth + 1), type: e.type, name: e.name, value: a.value ?? e.value ?? null, toggle: a.toggle ?? e.toggle ?? null, x: e.x, y: e.y };
        });
      };
      if (arg === 'read') {
        const path = positional.slice(3);
        if (!arg2 || !path.length) fail('usage: declick desk read <window> <Type:Name> [Type:Name ...] [--prop value|name|text|toggle|selected|enabled]');
        const { findByPath } = await import('../src/engines/desktop-tree.mjs');
        const hit = findByPath(await treeOf(arg2), path);
        if (!hit) fail(`element not found: ${path.join(' > ')} in "${arg2}"; run: declick desk tree ${JSON.stringify(arg2)} --grep <text>`, EXIT.NOT_FOUND);
        const prop = flags.prop === true || !flags.prop ? 'value' : String(flags.prop);
        const r = desk('read', hit.ref, '--prop', prop); if (r.code) deskFail(r, `desk read ${hit.ref}`);
        result = { ok: true, data: { ref: hit.ref, path: hit.path, type: hit.type, name: hit.name, prop, text: r.out } }; text = r.out; break;
      }
      if (!arg2) fail('usage: declick desk tree <window> [--depth N] [--type T] [--grep re] [--interactive]');
      let rows = await treeOf(arg2);
      if (flags.depth !== undefined) {
        const n = Number(flags.depth);
        if (!Number.isInteger(n) || n < 0) fail(`--depth must be a non-negative integer, got ${flags.depth}`);
        rows = rows.filter(e => e.depth <= n);
      }
      if (flags.type && flags.type !== true) rows = rows.filter(e => e.type.toLowerCase() === String(flags.type).toLowerCase());
      // The control types an agent can actually drive; everything else is layout it would only pay tokens for.
      if (flags.interactive && flags.interactive !== 'false') rows = rows.filter(e => ['Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'ListItem', 'TabItem', 'Hyperlink', 'Document'].includes(e.type));
      if (flags.grep && flags.grep !== true) {
        let re; try { re = new RegExp(String(flags.grep), 'i'); } catch (e) { fail(`--grep ${flags.grep} is not a regular expression: ${e.message}`); }
        rows = rows.filter(e => re.test(`${e.type}:${e.name}`));
      }
      text = rows.slice(0, flags.limit ?? 50).map(e => `${'  '.repeat(e.depth)}${e.type}:${e.name}${e.value != null ? ` value=${JSON.stringify(e.value)}` : ''}${e.toggle != null ? ` toggle=${e.toggle}` : ''}  ${e.ref} [${e.x},${e.y}]`).join('\n')
        || `no element matches in "${arg2}"`;
      result = { ok: true, data: rows.map(({ depth, ...e }) => e), meta: { window: arg2 } };
      break;
    }
    case 'web': {
      if (arg !== 'tree') fail('usage: declick web tree <url> [--selector css]');
      let u; try { u = new URL(arg2); } catch { fail(`${arg2} is not a url; try: declick web tree https://example.com`); }
      if (!/^https?:$/.test(u.protocol)) fail(`${arg2} must be an http(s) url`);
      const { snapshot } = await import('../src/engines/web.mjs');
      const s = await snapshot(u.href, { selector: flags.selector === true ? undefined : flags.selector, limit: flags.limit ?? 50 });
      text = s.nodes.map(n => `${n.interactive ? '*' : ' '} ${n.role.padEnd(10)} ${n.name}${n.href ? `  ${n.href}` : ''}${n.id ? `  #${n.id}` : ''}`).join('\n') || `nothing to click on ${s.url}`;
      result = { ok: true, data: s.nodes, meta: { url: s.url, title: s.title } };
      break;
    }
    case 'ui': {
      const server = await startUi({ port: flags.port ? Number(flags.port) : 4870, allowAuthoring: !!flags.allowAuthoring });
      const url = `http://127.0.0.1:${server.address().port}`;
      const data = { url, port: server.address().port, token: server.token, allowAuthoring: !!flags.allowAuthoring };
      process.stdout.write((json ? JSON.stringify({ ok: true, data, meta: { count: 1, truncated: false } }) : `declick ui at ${url}`) + '\n');
      if (flags.open && process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      await new Promise(() => {});
      break;
    }
    case 'version': result = { ok: true, data: { version: VERSION, node: process.versions.node } }; text = VERSION; break;
    case 'commands': result = { ok: true, data: commandRows() }; text = USAGE; break;
    case 'help': case undefined: result = { ok: true, data: { version: VERSION, commands: commandRows(), usage: USAGE } }; text = USAGE; break;
    // Every name in COMMANDS with no case here is reserved on purpose, so --help and the skill already describe it.
    default: fail(`declick ${cmd} is reserved but not implemented in ${VERSION}; run: declick commands`);
  }
} catch (e) {
  const msg = e.code === 'ENOENT' && e.path ? `no such file: ${e.path}` : e.message;
  result = { ok: false, error: msg, exit: e.exit ?? EXIT.ERROR, ...(e.data !== undefined ? { data: e.data } : {}) };
}

const out = emit(result, { json, fields: flags.fields, limit: flags.limit, dryRun: preview });
// doctor is a report that happens to carry problems: on a terminal the report still goes to stdout, the problems to stderr.
if (!json) {
  if (cmd === 'doctor') { if (result.data?.problems.length) process.stderr.write(`problems: ${result.data.problems.join('; ')}\n`); out.text = text; }
  else if (result.ok) out.text = text ?? out.text;
  else { process.stderr.write(out.text + '\n'); out.text = null; }
}
if (out.text !== null) process.stdout.write(out.text + '\n');
process.exitCode = out.exit;
