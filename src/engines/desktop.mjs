import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { parseSnapshot, findByPath, findAll, subtreeOf, candidates, treeDiff } from './desktop-tree.mjs';
import { recipesDir, listRecipes, validateStoredRecipe, STEP_KEYS } from '../recipes.mjs';
import { manifestDir } from '../manifest.mjs';
import { EXIT } from '../output.mjs';
import { stepsMutate } from '../guard.mjs';

export const DESK = () => process.env.DECLICK_DESK || join(homedir(), '.claude', 'tools', 'deskclaw', 'desk');

export function snapshotTree(title) {
  const r = desk('snapshot', title);
  return r.code ? [] : parseSnapshot(r.out).map(e => `${e.type}:${e.name}`);
}

function desk(...args) {
  const bin = DESK();
  // The real deskclaw entry point is a bash launcher; the test double is a .mjs script.
  const isNode = bin.endsWith('.mjs');
  const r = spawnSync(isNode ? process.execPath : 'bash', [bin, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function mapExit(code, err) {
  if (code === 4) return { exit: EXIT.BLOCKED, error: `deskclaw not armed; run: desk arm 30 (${err})` };
  if (code === 3) return { exit: EXIT.BLOCKED, error: `deskclaw STOP is set (${err})` };
  if (code === 2) return { exit: EXIT.NOT_FOUND, error: err || 'window or element not found' };
  return { exit: EXIT.ERROR, error: err || `desk exited ${code}` };
}

// What the verb hands back, so an agent can pass --fields and --limit without running the verb blind first.
function returnsOf(r) {
  if (r.returns === undefined || r.returns === null) return null;
  const step = (r.steps || []).find(s => s.as === r.returns);
  if (step && step['read-all']) return { shape: 'array', fields: Object.keys(step.fields || {}).map(name => ({ name })) };
  return { shape: 'text', from: r.returns };
}

export async function compile(source, { name, recipes } = {}) {
  const window = source.replace(/^app:/, '');
  const adapter = name || window.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = recipes || (listRecipes(adapter).length ? recipesDir(adapter) : null);
  if (!dir) throw Object.assign(new Error(`no recipes for ${adapter}; author one: declick add ${source} --goal "what the verb should do"`), { exit: 1 });
  let launch = null;
  const verbs = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const errs = validateStoredRecipe(r);
    if (errs.length) throw Object.assign(new Error(`invalid recipe ${f}: ${errs.join('; ')}`), { exit: 1 });
    // How to start the app is a property of the app, not of one verb: the first recipe that knows wins.
    launch ??= r.launch || null;
    const returns = returnsOf(r);
    return { name: basename(f, '.json'), description: r.description, args: r.args || [], flags: [], mutating: r.mutating !== false || stepsMutate('desktop', r.steps), ...(returns ? { returns } : {}), recipe: { steps: r.steps, returns: r.returns, tree: r.tree || null } };
  });
  return { name: adapter, engine: 'desktop', source, window, builtAt: new Date().toISOString(), auth: { env: [] }, ...(launch ? { launch } : {}), verbs };
}

const sub = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stepKey = s => Object.keys(s || {}).find(k => STEP_KEYS.includes(k));
// Every property but text is already in the snapshot line, so reading one costs no extra process.
const SNAP_PROPS = { name: e => e.name, value: e => e.value, toggle: e => e.toggle, selected: e => String(e.selected === true), enabled: e => String(e.enabled !== false) };
const textOf = e => [e.name, e.value].filter(Boolean).join(' ');

export async function execute(m, verbName, positional, flags = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  const hint = `; run: declick desk arm 30 to act, or declick describe ${m.name} --verb ${verbName}`;
  const trace = [];
  // The trace is the answer to "what actually happened": it rides along with the failure too, so an
  // agent never has to re-run the verb blind to find out how far it got.
  const bad = (exit, error, data) => ({ ok: false, exit, error: error + hint, data: { ...(data || {}), steps: trace } });
  const args = v.args || [];
  const vars = {}; args.forEach((a, i) => { vars[a.name] = positional[i]; });
  const missing = args.filter((a, i) => a.required !== false && positional[i] === undefined);
  if (missing.length) return bad(EXIT.ERROR, `${verbName} needs ${args.map(a => `<${a.name}>`).join(' ')}`);
  if (positional.length > args.length) return bad(EXIT.ERROR, `${verbName} takes ${args.length} argument${args.length === 1 ? '' : 's'}, got ${positional.length}; extra: ${positional.slice(args.length).join(' ')}`);
  for (const [i, a] of args.entries()) {
    const val = positional[i];
    if (val !== undefined && Array.isArray(a.enum) && !a.enum.includes(val)) return bad(EXIT.ERROR, `${a.name} must be one of ${a.enum.join(', ')}, got ${JSON.stringify(val)}`);
  }
  // A placeholder with no arg behind it silently substituted "" and clicked the wrong thing.
  for (const [, k] of JSON.stringify(v.recipe.steps).matchAll(/\{\{(\w+)\}\}/g)) {
    if (!(k in vars)) return bad(EXIT.ERROR, `recipe uses undeclared {{${k}}}; declare it in args or fix the recipe`);
  }
  const bin = DESK();
  // The real deskclaw entry point is a bash launcher; only the .mjs test double may be absent.
  if (!bin.endsWith('.mjs') && !existsSync(bin)) return bad(EXIT.ERROR, `deskclaw not found at ${bin}; install https://github.com/ucsandman/deskclaw or set DECLICK_DESK`);
  const dry = !!flags.dryRun;
  const els = {}; const out = {};
  let title = m.window;
  let launched = false;

  // Starts a real process, so the command line is literal by contract (validateStoredRecipe enforces it)
  // and the wait is a poll of the window list, not a fixed sleep.
  async function launch(spec) {
    const want = spec.waitForWindow || title;
    const timeout = spec.timeout ?? 10000;
    try { spawn(spec.command, spec.args || [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    catch (e) { return { exit: EXIT.ERROR, error: `launch ${spec.command} failed: ${e.message}` }; }
    for (const until = Date.now() + timeout; ;) {
      const r = desk('snapshot', want);
      if (!r.code && parseSnapshot(r.out).length) return null;
      if (Date.now() >= until) return { exit: EXIT.NOT_FOUND, error: `launched ${spec.command} but the "${want}" window did not appear within ${timeout}ms` };
      await sleep(250);
    }
  }

  // A window that is not on screen is not a broken recipe: start it once from manifest.launch, then retry.
  async function tree() {
    for (let attempt = 0; ; attempt++) {
      const r = desk('snapshot', title);
      if (r.code === 3 || r.code === 4) return { err: mapExit(r.code, r.err) };
      const live = parseSnapshot(r.out);
      // No tree at all is a closed window, not a moved element: repairing the recipe cannot fix it.
      if (!r.code && live.length) return { live };
      if (m.launch && !launched && attempt === 0) { launched = true; const e = await launch(m.launch); if (e) return { err: e }; continue; }
      return { err: { exit: EXIT.NOT_FOUND, error: `window "${title}" is not open; start the app or check the title` } };
    }
  }

  function miss(live, path, what) {
    const diff = v.recipe.tree ? treeDiff(v.recipe.tree.map(k => { const i = k.indexOf(':'); return { type: k.slice(0, i), name: k.slice(i + 1) }; }), live) : { missing: [], added: [] };
    const data = { ...diff, ...candidates(live, path), unresolved: path };
    const error = `element not found: ${path.join(' > ')} in "${title}" (${what}); pick one of data.candidates or run: declick repair ${m.name} ${verbName}`;
    try { mkdirSync(manifestDir(m.name), { recursive: true }); writeFileSync(join(manifestDir(m.name), 'last-error.json'), JSON.stringify({ verb: verbName, error, diff, at: new Date().toISOString() }, null, 2) + '\n'); } catch {}
    return { data, error };
  }

  // The tree an agent found and the tree it acts on are two different reads. Every acting step resolves its
  // path again against a fresh snapshot and refuses when the ref moved: a stale @eN clicks the wrong thing.
  async function reresolve(id, what) {
    const el = els[id];
    if (el === null) return { err: { exit: EXIT.NOT_FOUND, error: `${id} was skipped by an optional find, so ${what} cannot run; mark ${what} optional too` } };
    if (!el) return { err: { exit: EXIT.ERROR, error: `recipe bug: ${id} not found before use` } };
    const t = await tree(); if (t.err) return { err: t.err };
    const hit = findByPath(t.live, el.path);
    if (!hit) return { err: { exit: EXIT.NOT_FOUND, error: `the window changed between find and ${what}: ${el.path.join(' > ')} is gone` } };
    if (hit.ref !== el.ref) return { err: { exit: EXIT.NOT_FOUND, error: `the window changed between find and ${what}: ${el.path.join(' > ')} was ${el.ref}, now ${hit.ref}` } };
    return { el: hit };
  }

  const prop = (el, name) => (name === 'text' ? null : SNAP_PROPS[name || 'name'](el));

  for (const step of v.recipe.steps) {
    const k = stepKey(step);
    const skip = why => { trace.push({ skipped: k, why }); };
    const stop = e => (step.optional && e.exit === EXIT.NOT_FOUND ? (skip(e.error), null) : bad(e.exit, e.error, e.data));

    if (k === 'window') {
      title = sub(step.window, vars);
      if (!dry) {
        let r = desk('focus', title);
        if (r.code === 2 && m.launch && !launched) { launched = true; const e = await launch(m.launch); if (e) { const s = stop(e); if (s) return s; continue; } r = desk('focus', title); }
        if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
      }
      trace.push({ window: title }); continue;
    }
    if (k === 'launch') {
      if (dry) { trace.push({ would: 'launch', command: step.launch.command }); continue; }
      launched = true;
      const e = await launch(step.launch);
      if (e) { const s = stop(e); if (s) return s; continue; }
      trace.push({ did: 'launch', command: step.launch.command }); continue;
    }
    if (k === 'find' || k === 'read-all' || k === 'wait-for') {
      const path = step[k].map(s => sub(s, vars));
      if (k === 'wait-for' && dry) { trace.push({ would: 'wait-for', find: path, timeout: step.timeout ?? 10000 }); continue; }
      const until = Date.now() + (k === 'wait-for' ? step.timeout ?? 10000 : 0);
      for (;;) {
        const t = await tree();
        if (t.err) { const s = stop(t.err); if (s) return s; break; }
        const hit = k === 'read-all' ? findAll(t.live, path) : findByPath(t.live, path);
        if (k === 'read-all') {
          if (!hit.length && Date.now() < until) { await sleep(250); continue; }
          out[step.as] = hit.map(row => {
            if (!step.fields) return { ref: row.ref, type: row.type, name: row.name, ...(row.value !== undefined ? { value: row.value } : {}) };
            const scope = subtreeOf(t.live, row).slice(1);
            // A field is whatever the control exposes: its value when it has one, its name otherwise.
            return Object.fromEntries(Object.entries(step.fields).map(([f, p]) => {
              const e = findByPath(scope, (Array.isArray(p) ? p : [p]).map(x => sub(x, vars)));
              return [f, e ? e.value ?? e.name : null];
            }));
          });
          trace.push({ read: step.as, rows: out[step.as].length }); break;
        }
        if (hit) {
          if (k === 'find') els[step.as] = { ...hit, path };
          trace.push({ found: path, ref: hit.ref }); break;
        }
        if (Date.now() < until) { await sleep(250); continue; }
        const { data, error } = miss(t.live, path, k);
        // null, not absent: a later step that names it is a skipped optional, not a recipe bug.
        if (step.optional) { if (k === 'find') els[step.as] = null; skip(error); break; }
        return bad(EXIT.NOT_FOUND, error, data);
      }
      continue;
    }
    if (k === 'wait-for-text') {
      const want = sub(step['wait-for-text'].text, vars);
      const id = step['wait-for-text'].as;
      if (dry) { trace.push({ would: 'wait-for-text', text: want, on: id ?? null }); continue; }
      for (const until = Date.now() + (step.timeout ?? 10000); ;) {
        const t = await tree();
        if (t.err) { const s = stop(t.err); if (s) return s; break; }
        const scope = id ? [findByPath(t.live, els[id]?.path || [])].filter(Boolean) : t.live;
        if (scope.some(e => textOf(e).includes(want))) { trace.push({ waited: 'text', text: want }); break; }
        if (Date.now() >= until) {
          const e = { exit: EXIT.NOT_FOUND, error: `"${want}" did not appear in "${title}" within ${step.timeout ?? 10000}ms`, data: candidates(t.live, [`*:${want}`]) };
          const s = stop(e); if (s) return s; break;
        }
        await sleep(250);
      }
      continue;
    }
    if (k === 'read') {
      const el = els[step.read];
      if (!el) { const s = stop({ exit: EXIT.NOT_FOUND, error: `recipe bug: ${step.read} not found before read` }); if (s) return s; continue; }
      const p = step.prop || 'name';
      if (p === 'text') {
        if (dry) { trace.push({ would: 'read', on: step.read, prop: p }); continue; }
        const r = desk('read', el.ref, '--prop', 'text');
        if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
        out[step.as] = r.out.replace(/\r?\n$/, '');
      } else {
        // A read after an acting step has to see what the action did, so it re-resolves against a fresh tree
        // the way assert does. A plain path lookup, not reresolve(): UIA may hand the same element a new ref.
        let live = el;
        if (!dry) {
          const t = await tree();
          if (t.err) { const s = stop(t.err); if (s) return s; continue; }
          live = findByPath(t.live, el.path);
          if (!live) { const s = stop({ exit: EXIT.NOT_FOUND, error: `read ${step.read}: ${el.path.join(' > ')} is gone` }); if (s) return s; continue; }
        }
        const val = prop(live, p);
        if (val === undefined) { const s = stop({ exit: EXIT.NOT_FOUND, error: `${live.type} "${live.name}" exposes no ${p}` }); if (s) return s; continue; }
        out[step.as] = val;
      }
      trace.push({ read: step.as, prop: p }); continue;
    }
    if (k === 'assert') {
      const { as, equals, matches } = step.assert;
      const p = step.assert.prop || 'name';
      let actual = out[as];
      if (els[as]) {
        // Assert is the check after an action, so it reads the live tree rather than the found snapshot.
        const t = await tree(); if (t.err) { const s = stop(t.err); if (s) return s; continue; }
        const el = findByPath(t.live, els[as].path);
        if (!el) { const s = stop({ exit: EXIT.NOT_FOUND, error: `assert ${as}: ${els[as].path.join(' > ')} is gone` }); if (s) return s; continue; }
        actual = p === 'text' ? textOf(el) : prop(el, p);
      }
      const okAssert = equals !== undefined ? String(actual) === String(equals) : new RegExp(matches).test(String(actual));
      if (!okAssert) {
        const e = { exit: EXIT.ERROR, error: `assert ${as} ${equals !== undefined ? `equals ${JSON.stringify(equals)}` : `matches /${matches}/`} failed: ${p} is ${JSON.stringify(actual ?? null)}` };
        const s = step.optional ? (skip(e.error), null) : bad(e.exit, e.error);
        if (s) return s; continue;
      }
      trace.push({ asserted: as }); continue;
    }
    if (k === 'clipboard') {
      if (dry) { trace.push({ would: 'clipboard', op: step.clipboard }); continue; }
      const r = step.clipboard === 'get' ? desk('clipboard', 'get') : desk('clipboard', 'set', sub(step.text, vars));
      if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
      if (step.clipboard === 'get') out[step.as] = r.out.replace(/\r?\n$/, '');
      trace.push({ did: 'clipboard', op: step.clipboard }); continue;
    }
    if (k === 'dismiss') {
      if (dry) { trace.push({ would: 'dismiss' }); continue; }
      const r = desk('dismiss');
      if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
      trace.push({ did: 'dismiss' }); continue;
    }
    if (k === 'key') {
      if (dry) { trace.push({ would: 'key', keys: step.key }); continue; }
      const r = desk('key', title, sub(step.key, vars));
      if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
      trace.push({ did: 'key' }); continue;
    }
    if (k === 'wait') { if (!dry) await sleep(step.wait); trace.push({ did: 'wait', ms: step.wait }); continue; }

    // Everything left acts on one element: click, type, scroll, expand, collapse, select, context, set.
    const id = k === 'type' ? step.type[0] : k === 'set' ? step.set[0] : step[k];
    if (dry) {
      const el = els[id];
      if (!el && els[id] !== null) return bad(EXIT.ERROR, `recipe bug: ${id} not found before use`);
      if (!el) { skip(`${id} was skipped by an optional find`); continue; }
      trace.push(k === 'type' ? { would: 'type', ref: el.ref, name: el.name, text: sub(step.type[1], vars) }
        : k === 'click' ? { would: 'click', ref: el.ref, name: el.name }
          : { would: k, ref: el.ref, name: el.name, ...(k === 'set' ? { to: step.set[1] } : {}) });
      continue;
    }
    const got = await reresolve(id, k);
    if (got.err) { const s = stop(got.err); if (s) return s; continue; }
    const argv = k === 'type' ? ['type', got.el.ref, sub(step.type[1], vars)]
      : k === 'set' ? ['toggle', got.el.ref, step.set[1]] : [k, got.el.ref];
    const r = desk(...argv);
    if (r.code) { const s = stop(mapExit(r.code, r.err)); if (s) return s; continue; }
    trace.push({ did: k, ref: got.el.ref });
  }
  if (dry) return { ok: true, data: { steps: trace } };
  try { rmSync(join(manifestDir(m.name), 'last-error.json'), { force: true }); } catch {}
  return { ok: true, data: v.recipe.returns ? out[v.recipe.returns] : { done: true }, meta: { steps: trace } };
}
