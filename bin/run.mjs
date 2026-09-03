#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, loadManifest, manifestDir } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { emit, parseFlags, camel, nearest, RESERVED, EXIT } from '../src/output.mjs';
import { guard, derivedMutating, redactArgs } from '../src/guard.mjs';
import { scopeCreds, credUsage } from '../src/creds.mjs';

// Same gate as bin/declick.mjs: the launcher execs this file directly, and src/engines/index.mjs pulls in
// node:sqlite at import time, so the Node check has to run before the engines load or Node 18 users get a stack trace.
const nodeVersion = process.env.DECLICK_NODE_VERSION || process.versions.node;
if (Number(nodeVersion.split('.')[0]) < 24) {
  const msg = `declick needs Node 24 or newer (found v${nodeVersion}); the sqlite engine uses node:sqlite`;
  if (!process.stdout.isTTY) process.stdout.write(JSON.stringify({ ok: false, error: msg, exit: EXIT.ERROR }) + '\n');
  else process.stderr.write(`error: ${msg}\n`);
  process.exit(EXIT.ERROR);
}
const { engines } = await import('../src/engines/index.mjs');
// A reader that closes the pipe early (| head) is not an error worth a stack trace.
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; });

const started = Date.now();
const CONTRACT = ['json', 'fields', 'limit', 'rows', 'dryRun', 'full', 'help',
  'header', 'output', 'contentType', 'baseUrl', 'server', 'retry', 'timeout', 'verbose', 'curl', 'bodyFile'];
const [name, ...rest] = process.argv.slice(2);
// parseFlags hands back camelCase keys; an error has to quote the token the agent actually typed.
const rawFlag = k => rest.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')[0]).find(r => camel(r) === k || camel(r.replace(/^no-/, '')) === k) ?? k;
// parseFlags throws before returning when a flag value is malformed (e.g. --limit 0), so the destructuring
// assignment into `flags` below never runs and an explicit --json on that same line would be lost under the
// !isTTY default. Recover just that one bool straight off the raw tokens, mirroring parseFlags' own BOOLS rule.
function explicitJson() {
  // parseFlags stops reading flags at a bare `--`, and a repeated bool keeps its last occurrence: match both.
  const end = rest.indexOf('--');
  const scan = end === -1 ? rest : rest.slice(0, end);
  for (let i = scan.length - 1; i >= 0; i--) {
    const a = scan[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    let raw = eq > -1 ? a.slice(2, eq) : a.slice(2);
    let val = eq > -1 ? a.slice(eq + 1) : undefined;
    if (raw.startsWith('no-') && camel(raw.slice(3)) === 'json') { raw = raw.slice(3); val = 'false'; }
    if (camel(raw) !== 'json') continue;
    if (val === undefined) { const next = scan[i + 1]; val = next === 'true' || next === 'false' ? next : true; }
    return val === true || val === 'true' || val === '1';
  }
  return undefined;
}
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
const json = flags.json ?? explicitJson() ?? !process.stdout.isTTY;
// A verb whose spec says where its rows live unwraps them by default, but only once the caller asks to filter
// (--fields or --limit): otherwise the resource itself is the answer, not a guess at which array is "the rows".
const wantsRows = flags.fields !== undefined || flags.limit !== undefined;
const out = emit(result, { json, fields: flags.fields, limit: flags.limit, rows: ran ? flags.rows ?? (wantsRows ? v.returns?.rowsPath : undefined) : undefined, auto: ran, dryRun: !!flags.dryRun && result.ok });
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
