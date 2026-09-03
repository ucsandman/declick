import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, camel } from '../output.mjs';
import { KEBAB, loadManifest } from '../manifest.mjs';
import { derivedMutating } from '../guard.mjs';

const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
// Every step is run through the same runtime an agent would type, so it is guarded, credentialed and audited
// exactly once per step, by the step's own adapter. This is the file next to this package, never one on PATH.
const RUN = fileURLToPath(new URL('../../bin/run.mjs', import.meta.url));
// A chain whose step targets another chain can cycle; the depth rides in the child env so the loop stops itself.
const MAX_DEPTH = 8;

// A template is a name, optionally dotted. Literal JSON in a step argument ({"a":1}) never matches, so a chain
// can still pass a body through without escaping.
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\}/g;
const AS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Shell-style: a token is a run of non-space characters where any quoted stretch may itself hold spaces,
// so both --text "a b" and --text="a b" survive as one argument.
const TOKEN = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
const unquote = t => t.replace(/"([^"]*)"|'([^']*)'/g, (_, d, s) => d ?? s);

export const runLine = argv => argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');

function argvOf(run, where) {
  if (Array.isArray(run)) {
    if (!run.length || !run.every(x => typeof x === 'string')) throw fail(`${where}: run as an array must be a non-empty array of strings`);
    return run;
  }
  if (typeof run !== 'string' || !run.trim()) throw fail(`${where}: run must be a command string or an argv array`);
  // What the tokenizer could not take is what is left over: an apostrophe inside a quoted stretch is fine,
  // an unterminated quote is not.
  if (run.replace(TOKEN, '').trim()) throw fail(`${where}: unbalanced quote in run ${JSON.stringify(run)}`);
  return (run.match(TOKEN) || []).map(unquote);
}

const placeholders = argv => [...new Set(argv.flatMap(t => [...String(t).matchAll(PLACEHOLDER)].map(m => m[1])))];

function stepOf(raw, v, i, known) {
  const where = `${v.name} step ${i + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`${where}: a step is an object with a run field`);
  const argv = argvOf(raw.run, where);
  const [adapter, verb, ...rest] = argv;
  if (!adapter || !verb) throw fail(`${where}: run needs an adapter and a verb, e.g. petstore get-pet-by-id {id}`);
  if (/\{/.test(adapter) || /\{/.test(verb)) throw fail(`${where}: the adapter and the verb are fixed at compile time; only arguments may carry {templates}`);
  // loadManifest throws "no adapter named x" with exit 2, which is the compile error this chain deserves:
  // add refuses a chain that could not run, instead of leaving the failure for the first agent that tries it.
  const tm = loadManifest(adapter);
  const tv = tm.verbs.find(x => x.name === verb);
  if (!tv) throw fail(`${where}: ${adapter} has no verb ${verb}; run: declick describe ${adapter}`, EXIT.NOT_FOUND);
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !AS_NAME.test(raw.as)) throw fail(`${where}: as ${JSON.stringify(raw.as)} must be a name a template can use, e.g. "pet"`);
    if (known.has(camel(raw.as))) throw fail(`${where}: as ${JSON.stringify(raw.as)} is already an argument, a flag or an earlier step's name`);
  }
  // A name that cannot exist is caught here rather than on the first real run, and the message says where to look.
  for (const p of placeholders(rest)) {
    const head = p.split('.')[0];
    if (!known.has(camel(head))) throw fail(`${where}: {${p}} names nothing; ${v.name} has ${[...known].join(', ') || 'no arguments, flags or earlier steps'}`);
  }
  if (raw.as) known.add(camel(raw.as));
  return { adapter, verb, argv, mutating: !!tv.mutating || derivedMutating(tm, tv) === true,
    ...(raw.as ? { as: raw.as } : {}), ...(raw.optional ? { optional: true } : {}) };
}

function verbOf(raw) {
  if (!raw || typeof raw !== 'object') throw fail('every entry of verbs must be an object');
  if (!KEBAB.test(raw.name || '')) throw fail(`verb name ${JSON.stringify(raw.name)} must be kebab-case`);
  if (typeof raw.description !== 'string' || !raw.description) throw fail(`${raw.name}: description is required, one line saying what the chain answers`);
  const args = (raw.args || []).map(a => ({ name: a.name, description: a.description || a.name, required: a.required !== false }));
  const flags = (raw.flags || []).map(f => ({ name: f.name, description: f.description || f.name, required: !!f.required, ...(f.type ? { type: f.type } : {}) }));
  for (const x of [...args, ...flags]) if (!KEBAB.test(x.name || '')) throw fail(`${raw.name}: ${JSON.stringify(x.name)} must be kebab-case`);
  const known = new Set([...args, ...flags].map(x => camel(x.name)));
  if (!Array.isArray(raw.steps) || !raw.steps.length) throw fail(`${raw.name}: steps must be a non-empty array`);
  const steps = raw.steps.map((s, i) => stepOf(s, raw, i, known));
  if (raw.returns !== undefined) {
    if (typeof raw.returns !== 'string' || !raw.returns) throw fail(`${raw.name}: returns must be a step name or a template like {owner.email}`);
    const names = raw.returns.includes('{') ? placeholders([raw.returns]) : [raw.returns];
    if (!names.length) throw fail(`${raw.name}: returns ${JSON.stringify(raw.returns)} carries no name`);
    for (const p of names) if (!known.has(camel(p.split('.')[0]))) throw fail(`${raw.name}: returns ${JSON.stringify(raw.returns)} names nothing; the steps are ${steps.map(s => s.as).filter(Boolean).join(', ') || 'unnamed'}`);
  }
  return { name: raw.name, description: raw.description, mutating: steps.some(s => s.mutating), args, flags,
    compose: { steps, ...(raw.returns ? { returns: raw.returns } : {}) } };
}

function pathOf(source) {
  const raw = String(source || '').replace(/^compose:/, '');
  if (!raw) throw fail('usage: declick add compose:<chain.json>');
  if (/^https?:\/\//i.test(raw)) throw fail(`compose reads a local chain file, not a url; save ${raw} and pass its path`);
  const p = resolve(raw);
  if (!existsSync(p)) throw fail(`no such file: ${p}`, EXIT.NOT_FOUND);
  return p;
}

export async function compile(source, { name } = {}) {
  const path = pathOf(source);
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw fail(`${path} is not valid JSON (${e.message})`); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.verbs) || !doc.verbs.length) {
    throw fail(`${path} has no verbs; a chain file is {"compose": true, "verbs": [{"name": "...", "description": "...", "steps": [{"run": "<adapter> <verb> {arg}"}]}]}`);
  }
  const verbs = doc.verbs.map(verbOf);
  return { name: name || kebab(basename(path).replace(/\.[^.]+$/, '')) || 'chain', engine: 'compose',
    builtAt: new Date().toISOString(), auth: { env: [] }, source: `compose:${path}`, verbs };
}

// declick compose <name> --steps - has no path to record, and build recompiles from the recorded source:
// the chain is copied into the adapter's own directory so a later declick build <name> still has a file to read.
export function writeChain(dir, text) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'compose.json');
  writeFileSync(p, text);
  return p;
}

export const chain = m => m.verbs.map(v => ({
  verb: v.name, description: v.description, mutating: v.mutating,
  args: (v.args || []).map(a => a.name), flags: (v.flags || []).map(f => f.name),
  returns: v.compose?.returns ?? null,
  steps: (v.compose?.steps || []).map(s => ({ run: runLine(s.argv), as: s.as ?? null, optional: !!s.optional, mutating: !!s.mutating })),
}));

export function chainText(m) {
  const lines = [`${m.name} (compose)  source: ${m.source}`];
  for (const v of chain(m)) {
    lines.push(`  ${v.verb}${v.args.map(a => ` <${a}>`).join('')}${v.flags.map(f => ` [--${f}]`).join('')}  ${v.description}${v.mutating ? ' [mutating]' : ''}`);
    v.steps.forEach((s, i) => lines.push(`    ${i + 1}  ${s.run}${s.as ? `  -> ${s.as}` : ''}${s.optional ? '  (optional)' : ''}${s.mutating ? '  [mutating]' : ''}`));
    lines.push(`    returns: ${v.returns ?? 'the last step'}`);
  }
  return lines.join('\n');
}

const at = (obj, parts) => { let cur = obj; for (const k of parts) { if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, k)) return undefined; cur = cur[k]; } return cur; };
const asText = x => (typeof x === 'string' ? x : x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x));

// What a template may see: the composite's own arguments and flags, plus every earlier step that was named.
// compile refuses a step name that shadows an argument, so a bare name has exactly one meaning here.
function scopeOf(v, positional, flags) {
  const vars = {};
  (v.args || []).forEach((a, i) => { if (positional[i] !== undefined) vars[camel(a.name)] = positional[i]; });
  for (const f of v.flags || []) { const x = flags[camel(f.name)] ?? flags[f.name]; if (x !== undefined) vars[camel(f.name)] = x; }
  return vars;
}

// Names are matched the way the command line spells them: {my-pet} and {myPet} are the same step, because
// parseFlags already camelCased every flag before the engine ever sees it.
function lookup(name, vars, bound) {
  const [raw, ...rest] = name.split('.');
  const head = camel(raw);
  if (!rest.length && Object.hasOwn(vars, head)) return vars[head];
  if (!bound.has(head)) return undefined;
  return rest.length ? at(bound.get(head), rest) : bound.get(head);
}

// A preview keeps what it could not resolve, so an agent reading the dry run sees which step feeds which.
function fill(token, vars, bound, dry) {
  return String(token).replace(PLACEHOLDER, (whole, name) => {
    const hit = lookup(name, vars, bound);
    if (hit !== undefined) return asText(hit);
    if (dry) return whole;
    throw fail(`{${name}} did not resolve`);
  });
}

function step(argv, dry, depth) {
  const ms = Number(process.env.DECLICK_TIMEOUT_MS) || 30000;
  // The contract flags sit right after the verb and carry their value, so a step holding a bare -- cannot
  // turn --dry-run into a positional, and --json cannot swallow a first argument that reads "true".
  const [adapter, verb, ...rest] = argv;
  const r = spawnSync(process.execPath, [RUN, adapter, verb, '--json=true', ...(dry ? ['--dry-run=true'] : []), ...rest], {
    encoding: 'utf8',
    // An envelope has no size the chain can predict, and the step's own stderr (a governance warning, a
    // credential note) belongs to the caller rather than swallowed here.
    maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, DECLICK_COMPOSE_DEPTH: String(depth + 1) },
    timeout: ms,
  });
  if (r.signal || r.error?.code === 'ETIMEDOUT') return { ok: false, exit: EXIT.ERROR, error: `timed out after ${ms}ms; raise DECLICK_TIMEOUT_MS` };
  // A step that never started at all says why, instead of reporting that it printed no envelope.
  if (r.error) return { ok: false, exit: EXIT.ERROR, error: `could not run this step: ${r.error.message}` };
  const out = String(r.stdout || '').trim();
  let env;
  try { env = JSON.parse(out); } catch { return { ok: false, exit: r.status || EXIT.ERROR, error: `printed no envelope: ${out.split('\n')[0] || `exited ${r.status}`}` }; }
  // Both have to agree: --each answers ok with a non-zero exit when one of its items failed, and that is not
  // a step the rest of the chain may build on.
  if (env?.ok && !r.status) return { ok: true, data: env.data, meta: env.meta };
  return { ok: false, exit: env?.exit || r.status || EXIT.ERROR, error: env?.error || `exited ${r.status}`, meta: env?.meta };
}

export async function execute(m, verbName, positional = [], flags = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run: declick describe ${m.name}` };
  const depth = Number(process.env.DECLICK_COMPOSE_DEPTH) || 0;
  if (depth >= MAX_DEPTH) return { ok: false, exit: EXIT.ERROR, error: `chains are nested ${depth} deep at ${m.name} ${verbName}; a chain that calls itself never ends` };
  const need = (v.args || []).filter(a => a.required !== false);
  if (positional.length < need.length) return { ok: false, exit: EXIT.ERROR, error: `${verbName} needs ${need.map(a => `<${a.name}>`).join(' ')}; run: declick describe ${m.name} --verb ${verbName}` };
  const started = Date.now();
  const dry = !!flags.dryRun;
  const vars = scopeOf(v, positional, flags);
  // A preview binds nothing: a step's dry run answers with the request it would send, not with data, so every
  // template that reads an earlier step stays literal and says out loud which step it is waiting for.
  const bound = new Map();
  const steps = [];
  const meta = () => ({ steps: steps.length, ms: Date.now() - started });
  let last;
  for (const [i, s] of (v.compose?.steps || []).entries()) {
    if (!Array.isArray(s?.argv) || !s.adapter || !s.verb) return { ok: false, exit: EXIT.ERROR, error: `step ${i + 1} has no command; run: declick build ${m.name}`, data: { steps }, meta: meta() };
    const where = `step ${i + 1} (${s.adapter} ${s.verb})`;
    let argv;
    try { argv = s.argv.map(t => fill(t, vars, bound, dry)); }
    catch (e) { return { ok: false, exit: EXIT.ERROR, error: `${where}: ${e.message}`, data: { steps }, meta: meta() }; }
    const line = runLine(argv);
    const r = step(argv, dry, depth);
    if (dry) { steps.push(r.ok ? { run: line, preview: r.data } : { run: line, ok: false, exit: r.exit, error: r.error }); }
    else steps.push({ run: line, ok: r.ok, exit: r.ok ? EXIT.OK : r.exit, ...(s.as ? { as: s.as } : {}), ...(s.optional ? { optional: true } : {}),
      ...(r.ok ? { data: r.data } : { error: r.error, ...(r.meta?.governance ? { governance: r.meta.governance } : {}) }) });
    if (r.ok) { if (s.as) bound.set(camel(s.as), r.data); last = r.data; continue; }
    // An optional step records what went wrong and leaves its name unset; everything else stops the chain with
    // the step's own exit code, so a blocked step is still exit 3 at the top.
    if (!s.optional) return { ok: false, exit: r.exit, error: `${where}: ${r.error}`, data: { steps }, meta: meta() };
  }
  if (dry) return { ok: true, data: { steps }, meta: meta() };
  const want = v.compose?.returns;
  if (!want) return { ok: true, data: last ?? null, meta: meta() };
  // A returns of exactly one template is that value itself, object or array included; anything else is text.
  const whole = /^\{[^{}]+\}$/.test(want) ? lookup(want.slice(1, -1), vars, bound) : undefined;
  if (whole !== undefined) return { ok: true, data: whole, meta: meta() };
  if (!want.includes('{')) {
    if (bound.has(camel(want))) return { ok: true, data: bound.get(camel(want)), meta: meta() };
    return { ok: false, exit: EXIT.ERROR, error: `returns ${want} never ran; the step named ${want} was optional and failed`, data: { steps }, meta: meta() };
  }
  try { return { ok: true, data: fill(want, vars, bound, false), meta: meta() }; }
  catch (e) { return { ok: false, exit: EXIT.ERROR, error: `returns ${JSON.stringify(want)}: ${e.message}`, data: { steps }, meta: meta() }; }
}
