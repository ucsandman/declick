// Web engine: a hand-written recipe per verb turns a site into a deterministic CLI. No screenshots,
// no DOM dumps in the happy path; a miss answers with the elements that are actually there.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { recipesDir, listRecipes } from '../recipes.mjs';
import { KEBAB } from '../manifest.mjs';
import { EXIT } from '../output.mjs';
import { open, findChrome } from '../cdp.mjs';

const STEP_KEYS = ['goto', 'find', 'click', 'type', 'read', 'read-all', 'wait-for', 'wait', 'key', 'eval'];
// Steps that only look. A recipe made of nothing else needs no --dry-run and no governance check.
const READONLY = new Set(['goto', 'find', 'read', 'read-all', 'wait-for', 'wait']);
const NEEDS_AS = ['find', 'read', 'read-all', 'eval'];
const STRINGY = ['goto', 'find', 'click', 'read', 'read-all', 'wait-for', 'key', 'eval'];
const err = (msg, exit = EXIT.ERROR, data) => Object.assign(new Error(msg), { exit, ...(data ? { data } : {}) });
const stepKey = s => Object.keys(s || {}).filter(k => STEP_KEYS.includes(k));
const sub = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

// The checks a web recipe must pass to be replayable at all: same shape as the desktop validator.
export function validateWebRecipe(r) {
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (!Array.isArray(r.steps) || !r.steps.length) return ['steps must be a non-empty array'];
  const errs = []; const found = new Set(); const outs = new Set();
  r.steps.forEach((s, i) => {
    const keys = stepKey(s);
    if (keys.length !== 1) { errs.push(`steps[${i}]: unknown step ${JSON.stringify(s)}; one of ${STEP_KEYS.join(', ')}`); return; }
    const k = keys[0]; const val = s[k];
    if (NEEDS_AS.includes(k) && typeof s.as !== 'string') errs.push(`steps[${i}]: ${k} needs "as"`);
    if (STRINGY.includes(k) && (typeof val !== 'string' || !val.trim())) errs.push(`steps[${i}]: ${k} must be a non-empty string`);
    if (k === 'type' && (!Array.isArray(val) || val.length !== 2 || val.some(x => typeof x !== 'string'))) errs.push(`steps[${i}]: type must be [element, text]`);
    if (k === 'wait' && !Number.isFinite(val)) errs.push(`steps[${i}]: wait must be a number of milliseconds`);
    if (k === 'read-all' && s.fields !== undefined && (!s.fields || typeof s.fields !== 'object' || Array.isArray(s.fields) || Object.values(s.fields).some(x => typeof x !== 'string'))) errs.push(`steps[${i}]: fields must be an object of name: selector`);
    if (k === 'key' && /\{\{/.test(String(val))) errs.push(`steps[${i}]: key steps must be literal`);
    const ref = k === 'click' ? val : k === 'type' ? val?.[0] : k === 'read' ? val : null;
    if (typeof ref === 'string' && !found.has(ref)) errs.push(`steps[${i}]: ${ref} is not located by an earlier find`);
    if (typeof s.as === 'string') { if (k === 'find') found.add(s.as); else outs.add(s.as); }
  });
  if (r.returns !== undefined && !outs.has(r.returns)) errs.push(`returns ${JSON.stringify(r.returns)} must name a read, read-all or eval step's "as"`);
  return errs;
}

// What the verb hands back, so an agent can pass --fields and --limit without running it blind first.
function returnsOf(r) {
  if (r.returns === undefined) return null;
  const step = r.steps.find(s => s.as === r.returns);
  if (stepKey(step)[0] === 'read-all') return { shape: 'array', fields: Object.keys(step.fields || {}).map(name => ({ name })) };
  return { shape: 'text', fields: [] };
}

const mutatingOf = r => typeof r.mutating === 'boolean' ? r.mutating : r.steps.some(s => !READONLY.has(stepKey(s)[0]));

export async function compile(source, { name, recipes } = {}) {
  const raw = String(source).replace(/^web:/, '');
  let url; try { url = new URL(raw); } catch { throw err(`${raw} is not a url; use web:https://example.com`); }
  if (!/^https?:$/.test(url.protocol)) throw err(`${raw} must be an http(s) url`);
  const adapter = name || url.hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!KEBAB.test(adapter)) throw err(`cannot make an adapter name from ${url.hostname}; pass --name <kebab-case>`);
  const dir = recipes || (listRecipes(adapter).length ? recipesDir(adapter) : null);
  if (!dir) throw err(`no recipes for ${adapter}; write one per verb and import them: declick add ${source} --recipes <dir>`);
  const verbs = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const errs = validateWebRecipe(r);
    if (errs.length) throw err(`invalid recipe ${f}: ${errs.join('; ')}`);
    const returns = returnsOf(r);
    return { name: basename(f, '.json'), description: r.description, args: r.args || [], flags: [], mutating: mutatingOf(r), ...(returns ? { returns } : {}), recipe: { steps: r.steps, returns: r.returns ?? null } };
  });
  return { name: adapter, engine: 'web', source: `web:${url.href}`, window: url.origin, builtAt: new Date().toISOString(), auth: { env: [] }, verbs };
}

// A goto is a full url or a path against the origin the manifest was built from.
const target = (to, origin) => /^https?:\/\//i.test(to) ? to : new URL(to, origin).href;

// --dry-run answers from the recipe alone: no browser, no profile, no navigation.
function preview(step, vars, origin) {
  const [k] = stepKey(step);
  const v = step[k];
  switch (k) {
    case 'goto': return { goto: target(sub(v, vars), origin) };
    case 'find': return { would: 'find', find: sub(v, vars), as: step.as };
    case 'click': return { would: 'click', on: v };
    case 'type': return { would: 'type', on: v[0], text: sub(v[1], vars) };
    case 'read': return { would: 'read', on: v, as: step.as, prop: step.prop || 'text' };
    case 'read-all': return { would: 'read-all', css: sub(v, vars), as: step.as, fields: step.fields ? Object.keys(step.fields) : null };
    case 'wait-for': return { would: 'wait-for', find: sub(v, vars), timeout: step.timeout ?? 10000 };
    case 'wait': return { would: 'wait', ms: v };
    case 'key': return { would: 'key', key: v };
    case 'eval': return { would: 'eval', as: step.as };
    default: throw err(`unknown recipe step ${JSON.stringify(step)}`);
  }
}

export async function execute(m, verbName, positional, flags = {}) {
  const v = m.verbs.find(x => x.name === verbName);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verbName}; run describe` };
  const vars = {}; (v.args || []).forEach((a, i) => { vars[a.name] = positional[i]; });
  const missing = (v.args || []).filter((a, i) => a.required !== false && positional[i] === undefined);
  if (missing.length) return { ok: false, exit: EXIT.ERROR, error: `${verbName} needs ${v.args.map(a => `<${a.name}>`).join(' ')}` };
  // A placeholder with no arg behind it would silently substitute "" and type the wrong thing.
  for (const [, k] of JSON.stringify(v.recipe.steps).matchAll(/\{\{(\w+)\}\}/g)) {
    if (!(k in vars)) return { ok: false, exit: EXIT.ERROR, error: `recipe uses undeclared {{${k}}}; declare it in args or fix the recipe` };
  }
  const origin = m.window || m.source;
  const steps = v.recipe.steps;

  if (flags.dryRun) {
    try { return { ok: true, data: { steps: steps.map(s => preview(s, vars, origin)) }, meta: { steps: steps.length } }; }
    catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  }
  if (!process.env.DECLICK_CDP && !findChrome()) {
    return { ok: false, exit: EXIT.ERROR, error: 'no Chrome or Edge found; install Chrome or set CHROME=<path to the browser executable>' };
  }

  let page;
  try { page = await open({}); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message, meta: { steps: 0 } }; }
  const els = {}; const out = {}; const trace = [];
  try {
    for (const step of steps) {
      const [k] = stepKey(step);
      const val = step[k];
      if (k === 'goto') { const url = target(sub(val, vars), origin); await page.navigate(url); trace.push({ goto: url }); continue; }
      if (k === 'find' || k === 'wait-for') {
        const sel = sub(val, vars);
        const hit = await page.waitFor(sel, step.timeout ?? (k === 'find' ? 2000 : 10000));
        // A miss is the one failure an agent cannot guess its way out of, so it comes back with the real elements.
        if (!hit) throw err(`element not found: ${sel} on ${await page.url()}; pick one of data.candidates or fix the recipe`, EXIT.NOT_FOUND, { selector: sel, candidates: await page.candidates(10) });
        if (k === 'find') els[step.as] = hit;
        trace.push({ found: sel }); continue;
      }
      if (k === 'click' || k === 'type' || k === 'read') {
        const id = k === 'type' ? val[0] : val;
        const el = els[id];
        if (!el) throw err(`recipe bug: ${id} is not located by an earlier find`);
        if (k === 'click') { trace.push({ did: 'click', how: await page.click(el), on: id }); continue; }
        if (k === 'type') { await page.type(el, sub(val[1], vars)); trace.push({ did: 'type', on: id }); continue; }
        out[step.as] = await page.readText(el, step.prop || 'text'); trace.push({ read: step.as }); continue;
      }
      if (k === 'read-all') { out[step.as] = await page.readAll(sub(val, vars), step.fields || null); trace.push({ read: step.as, rows: out[step.as].length }); continue; }
      if (k === 'eval') { out[step.as] = await page.evaluate(sub(val, vars), true); trace.push({ did: 'eval', as: step.as }); continue; }
      if (k === 'key') { await page.key(val); trace.push({ did: 'key', key: val }); continue; }
      if (k === 'wait') { await new Promise(r => setTimeout(r, val)); trace.push({ did: 'wait', ms: val }); continue; }
      throw err(`unknown recipe step ${JSON.stringify(step)}`);
    }
    const url = await page.url().catch(() => undefined);
    return { ok: true, data: v.recipe.returns ? out[v.recipe.returns] : { done: true }, meta: { steps: trace.length, ...(url ? { url } : {}) } };
  } catch (e) {
    return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message, ...(e.data ? { data: e.data } : {}), meta: { steps: trace.length } };
  } finally {
    await page.close();
  }
}

// The tree a "declick web tree <url>" command prints: enough to write the next recipe, no screenshot.
// grep, when given, is a compiled RegExp: the browser-side cap is raised so the filter sees the whole page,
// then the CLI's own --limit slices the matches (via output.mjs's generic array shaping).
export async function snapshot(url, { selector, limit = 60, grep } = {}) {
  const page = await open({ url });
  try {
    const cap = grep ? Math.min(2000, limit * 20) : limit;
    let nodes = await page.tree(selector, cap);
    if (nodes === null) throw err(`no element matches ${selector} on ${url}`, EXIT.NOT_FOUND);
    if (grep) {
      nodes = nodes.filter(n => grep.test(`${n.role}:${n.name}`) || (n.href && grep.test(n.href)));
      if (!nodes.length) throw err(`no element matches /${grep.source}/ on ${url}`, EXIT.NOT_FOUND);
    }
    return { url: await page.url(), title: await page.title(), nodes };
  } finally { await page.close(); }
}

// The page's visible text, numbered so an agent can quote where it found something. grep filters lines but
// never renumbers them: n always points at the line's place in the full (non-empty, trimmed) text.
export async function pageText(url, { selector, grep, limit = 50 } = {}) {
  const page = await open({ url });
  try {
    const raw = await page.text(selector);
    if (raw === null) throw err(`no element matches ${selector} on ${url}`, EXIT.NOT_FOUND);
    let lines = raw.split('\n').map(s => s.trim()).filter(Boolean).map((text, i) => ({ n: i + 1, text }));
    if (grep) {
      lines = lines.filter(l => grep.test(l.text));
      if (!lines.length) throw err(`no line matches /${grep.source}/ on ${url}`, EXIT.NOT_FOUND);
    }
    return { url: await page.url(), title: await page.title(), lines };
  } finally { await page.close(); }
}
