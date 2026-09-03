#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, loadManifest, manifestDir } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { emit, parseFlags, camel, nearest, RESERVED, EXIT } from '../src/output.mjs';
import { engines } from '../src/engines/index.mjs';
import { guard, derivedMutating, redactArgs } from '../src/guard.mjs';
import { scopeCreds, credUsage } from '../src/creds.mjs';

const started = Date.now();
const CONTRACT = ['json', 'fields', 'limit', 'rows', 'dryRun', 'full', 'help',
  'header', 'output', 'contentType', 'baseUrl', 'server', 'retry', 'timeout', 'verbose', 'curl', 'bodyFile'];
const [name, ...rest] = process.argv.slice(2);
// parseFlags hands back camelCase keys; an error has to quote the token the agent actually typed.
const rawFlag = k => rest.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')[0]).find(r => camel(r) === k || camel(r.replace(/^no-/, '')) === k) ?? k;
const didYouMean = (word, known, dash = '') => { const near = nearest(word, known); return near.length ? `; did you mean ${near.map(n => dash + n).join(', ')}?` : ''; };
const upperSnake = s => String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const originOf = u => { try { return new URL(String(u)).origin; } catch { return null; } };
const allowList = () => (process.env.DECLICK_ENV_ALLOW || '').split(/[,\s]+/).filter(Boolean);
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
// Engines that send a request built from baseUrl: their keys belong to that origin and nowhere else.
const SCOPED = ['openapi', 'graphql', 'postman', 'har'];

// Where this run's request actually goes, mirroring how the request engines pick a base.
function scopeFor(m, flags) {
  if (!SCOPED.includes(m.engine)) return null;
  // Older manifests have no auth.origin; the compiled baseUrl is the same promise, recorded later.
  const expected = m.auth?.origin || originOf(m.baseUrl);
  if (!expected) return null;
  const explicit = typeof flags.baseUrl === 'string';
  const want = typeof flags.server === 'string' ? flags.server : null;
  const picked = want === null ? null : (m.servers || []).find((s, i) => s.url === want || String(i) === want || (s.description || '').toLowerCase() === want.toLowerCase())?.url;
  const actual = originOf(explicit ? flags.baseUrl : picked || process.env[`DECLICK_${upperSnake(m.name)}_BASE_URL`] || m.baseUrl);
  return { expected, actual, explicit, allow: allowList() };
}

let flags = {}, verb, m, v, ran = false, result, text, args = [], mutating = false;
let governance = { enabled: !!process.env.DASHCLAW_API_KEY, decision: 'skipped', reason: 'no mutating action' };
try {
  let positional; ({ positional, flags } = parseFlags(rest)); [verb, ...args] = positional;
  if (!name) throw Object.assign(new Error('usage: <adapter> <verb> [args] [--flags]; run: declick list'), { exit: EXIT.ERROR });
  m = loadManifest(name);
  v = verb && verb !== 'describe' ? m.verbs.find(x => x.name === verb) : null;
  if (!verb || verb === 'describe' || (v && flags.help)) {
    const opts = { full: !!flags.full || !!v, verb: v?.name };
    result = { ok: true, data: describeJson(m, opts) }; text = describe(m, opts);
    governance = { ...governance, reason: 'describe' };
  } else if (!v) {
    result = { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${name}${didYouMean(verb, m.verbs.map(x => x.name))}` };
  } else {
    const known = new Set([...CONTRACT, ...(v.flags || []).flatMap(f => [f.name, camel(f.name)])]);
    const bad = Object.keys(flags).filter(k => !known.has(k));
    if (bad.length) {
      const raw = rawFlag(bad[0]);
      const near = didYouMean(raw, [...(v.flags || []).map(f => f.name), ...RESERVED], '--');
      throw Object.assign(new Error(`unknown flag --${raw} for ${verb}; run: declick describe ${name} --verb ${verb}${near}`), { exit: EXIT.ERROR });
    }
    // A manifest may raise mutating and never lower it: the engine's own derivation is the floor.
    mutating = !!v.mutating || derivedMutating(m, v) === true;
    // An adapter may only name keys of its own, so an imported manifest cannot ask for a neighbour's token.
    const prefix = new RegExp(`^(${upperSnake(m.name)}|DECLICK)_`);
    const stray = (m.auth?.env || []).filter(k => !prefix.test(k) && !allowList().includes(k));
    if (stray.length) throw Object.assign(new Error(`${name} asks for ${stray.join(', ')}, outside ${upperSnake(m.name)}_*; rebuild the adapter or set DECLICK_ENV_ALLOW=${stray.join(',')}`), { exit: EXIT.AUTH });
    // A dry run sends nothing and masks every value, so it needs no key and no scope.
    if (!flags.dryRun) scopeCreds(scopeFor(m, flags));
    const argv = Object.fromEntries((v.args || []).map((a, i) => [a.name, args[i]]).filter(([, x]) => x !== undefined));
    if (mutating && flags.dryRun) governance = { ...governance, decision: 'dry-run', reason: 'preview only, nothing sent' };
    else if (!mutating) governance = { ...governance, reason: 'read-only verb' };
    else {
      const base = (typeof flags.baseUrl === 'string' && flags.baseUrl) || m.baseUrl;
      const g = await guard({ tool: name, action: verb, engine: m.engine, method: v.http?.method, args: argv,
        target: v.http?.path ? `${base || ''}${v.http.path}` : (m.window || base || m.source) });
      governance = { enabled: governance.enabled, decision: g.decision, reason: g.reason };
      if (!g.allowed) result = { ok: false, exit: EXIT.BLOCKED, data: g.approvalId ? { approvalId: g.approvalId } : undefined,
        error: g.decision === 'require_approval' ? `needs approval: ${g.reason}${g.approvalId ? ` (approvalId ${g.approvalId})` : ''}` : `blocked by governance: ${g.reason}` };
    }
    ran = true;
    result ??= await engines[m.engine].execute(m, verb, args, flags);
  }
} catch (e) { result = { ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR }; }

const creds = credUsage();
result.meta = { ...(result.meta || {}), governance, ...(creds.length ? { credentials: creds } : {}) };
const json = flags.json ?? !process.stdout.isTTY;
// A verb whose spec says where its rows live unwraps them by default; --rows overrides, and describe keeps its own shape.
const out = emit(result, { json, fields: flags.fields, limit: flags.limit, rows: ran ? flags.rows ?? v.returns?.rowsPath : undefined, auto: ran, dryRun: !!flags.dryRun && result.ok });
if (text && !json) out.text = text;
if (m && verb && verb !== 'describe') {
  try {
    const dir = manifestDir(name); mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString(); const ok = out.exit === 0;
    writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ verb, ok, exit: out.exit, dryRun: !!flags.dryRun, at, ...(ok ? {} : { error: result.error }) }, null, 2) + '\n');
    // Every engine leaves the same breadcrumb for declick status, the ui and repair. The desktop engine
    // writes its tree diff during execute, so that field survives a rewrite of the same verb's failure.
    const p = join(dir, 'last-error.json');
    if (ok) rmSync(p, { force: true });
    else {
      const prev = readJson(p);
      writeFileSync(p, JSON.stringify({ verb, error: result.error, exit: out.exit, ...(result.data !== undefined ? { data: result.data } : {}), ...(prev?.verb === verb && prev.diff ? { diff: prev.diff } : {}), at }, null, 2) + '\n');
    }
  } catch {}
}
// One line per invocation: what ran, what governance said, what it cost. DECLICK_AUDIT=off turns it off.
if (process.env.DECLICK_AUDIT !== 'off') {
  try {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(join(HOME, 'audit.jsonl'), JSON.stringify({
      at: new Date().toISOString(), adapter: name ?? null, verb: verb ?? null,
      args: redactArgs(Object.fromEntries((v?.args || []).map((a, i) => [a.name, args[i]]).filter(([, x]) => x !== undefined))),
      flags: Object.fromEntries(Object.entries(flags).filter(([k]) => CONTRACT.includes(k))),
      mutating, dryRun: !!flags.dryRun, governance, exit: out.exit, ok: out.exit === 0, ms: Date.now() - started,
    }) + '\n');
  } catch {}
}
process.stdout.write(out.text + '\n');
process.exitCode = out.exit;
