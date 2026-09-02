import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { parseSnapshot, findByPath, treeDiff } from './desktop-tree.mjs';
import { recipesDir, listRecipes } from '../recipes.mjs';
import { EXIT } from '../output.mjs';

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

export async function compile(source, { name, recipes } = {}) {
  const window = source.replace(/^app:/, '');
  const adapter = name || window.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = recipes || (listRecipes(adapter).length ? recipesDir(adapter) : null);
  if (!dir) throw Object.assign(new Error(`no recipes for ${adapter}; author one: declick add ${source} --goal "what the verb should do"`), { exit: 1 });
  const verbs = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return { name: basename(f, '.json'), description: r.description, args: r.args || [], flags: [], mutating: r.mutating !== false, recipe: { steps: r.steps, returns: r.returns, tree: r.tree || null } };
  });
  return { name: adapter, engine: 'desktop', source, window, builtAt: new Date().toISOString(), auth: { env: [] }, verbs };
}

const sub = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

export async function execute(m, verbName, positional, flags = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run describe` };
  const vars = {}; v.args.forEach((a, i) => { vars[a.name] = positional[i]; });
  const missing = v.args.filter((a, i) => a.required !== false && positional[i] === undefined);
  if (missing.length) return { ok: false, exit: EXIT.ERROR, error: `${verbName} needs ${v.args.map(a => `<${a.name}>`).join(' ')}` };
  const dry = !!flags.dryRun;
  const els = {}; const out = {}; const trace = [];
  let title = m.window;

  for (const step of v.recipe.steps) {
    if (step.window) {
      title = sub(step.window, vars);
      if (!dry) { const r = desk('focus', title); if (r.code) return { ok: false, ...mapExit(r.code, r.err) }; }
      trace.push({ window: title }); continue;
    }
    if (step.find) {
      const path = step.find.map(s => sub(s, vars));
      const r = desk('snapshot', title);
      if (r.code && r.code !== 2) return { ok: false, ...mapExit(r.code, r.err) };
      const live = parseSnapshot(r.out);
      const hit = findByPath(live, path);
      if (!hit) {
        const diff = v.recipe.tree ? treeDiff(v.recipe.tree.map(k => { const i = k.indexOf(':'); return { type: k.slice(0, i), name: k.slice(i + 1) }; }), live) : null;
        return { ok: false, exit: EXIT.NOT_FOUND, error: `element not found: ${path.join(' > ')} in "${title}"; run: declick repair ${m.name} ${verbName}`, data: diff };
      }
      els[step.as] = hit; trace.push({ found: path, ref: hit.ref }); continue;
    }
    if (step.click || step.type) {
      const id = step.click || step.type[0]; const el = els[id];
      if (!el) return { ok: false, exit: EXIT.ERROR, error: `recipe bug: ${id} not found before use` };
      const action = step.click ? ['click', el.ref] : ['type', el.ref, sub(step.type[1], vars)];
      if (dry) { trace.push({ would: action[0], ref: el.ref, name: el.name }); continue; }
      const r = desk(...action); if (r.code) return { ok: false, ...mapExit(r.code, r.err) };
      trace.push({ did: action[0], ref: el.ref }); continue;
    }
    if (step.key) {
      if (dry) { trace.push({ would: 'key', keys: step.key }); continue; }
      const r = desk('key', title, sub(step.key, vars)); if (r.code) return { ok: false, ...mapExit(r.code, r.err) };
      trace.push({ did: 'key' }); continue;
    }
    if (step.read) { const el = els[step.read]; if (!el) return { ok: false, exit: EXIT.ERROR, error: `recipe bug: ${step.read} not found before read` }; out[step.as] = el.name; trace.push({ read: el.name }); continue; }
    if (step.wait) { if (!dry) await new Promise(r => setTimeout(r, step.wait)); continue; }
    return { ok: false, exit: EXIT.ERROR, error: `unknown recipe step ${JSON.stringify(step)}` };
  }
  if (dry) return { ok: true, data: { steps: trace } };
  return { ok: true, data: v.recipe.returns ? out[v.recipe.returns] : { done: true } };
}
