#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, loadManifest, manifestDir } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { emit, shape, parseFlags, camel, nearest, RESERVED, EXIT } from '../src/output.mjs';
import { guard, derivedMutating, redactArgs } from '../src/guard.mjs';
import { policyDecision } from '../src/policy.mjs';
import { scopeCreds, credUsage } from '../src/creds.mjs';
import { defaultsPath, loadDefaults, knownFlags, parseEntry } from '../src/defaults.mjs';

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
  'header', 'output', 'contentType', 'baseUrl', 'server', 'retry', 'timeout', 'verbose', 'curl', 'bodyFile', 'each', 'defaults'];
const [name, ...rest] = process.argv.slice(2);
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
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

// A verb accepts its own flags plus the contract's; anything else is a typo worth naming, and a --each item is
// checked by the same rule as the command line, so a bad key in a file reads like a bad key in a shell.
function checkFlags(v, verb, flags) {
  const known = new Set([...CONTRACT, ...(v.flags || []).flatMap(f => [f.name, camel(f.name)])]);
  const bad = Object.keys(flags).filter(k => !known.has(k));
  if (!bad.length) return;
  const raw = rawFlag(bad[0]);
  const near = didYouMean(raw, [...(v.flags || []).map(f => f.name), ...RESERVED], '--');
  throw fail(`unknown flag --${raw} for ${verb}; run: declick describe ${name} --verb ${verb}${near}`);
}

// Everything one invocation does between the flag check and the engine call. --each runs it once per item, so it
// holds no state of its own: what it leaves behind is a stderr warning and the credential ledger, nothing else.
async function runOne({ m, v, verb, args, flags }) {
  const governance = { enabled: !!process.env.DASHCLAW_API_KEY, decision: 'skipped', reason: 'no mutating action' };
  checkFlags(v, verb, flags);
  // A manifest may raise mutating and never lower it: the engine's own derivation is the floor.
  const mutating = !!v.mutating || derivedMutating(m, v) === true;
  // A read never reaches the guard below, so the local policy decides here instead, before a credential is
  // scoped or a request is built. A dry run sends nothing, so it skips policy exactly as it skips the guard.
  const local = !mutating && !flags.dryRun ? policyDecision({ adapter: name, verb, mutating }) : null;
  if (local && local.decision !== 'allow') {
    const reason = local.reason || `rule ${local.rule}`;
    Object.assign(governance, { decision: local.decision, reason, source: 'policy' });
    if (local.decision === 'block') return { result: { ok: false, exit: EXIT.BLOCKED, error: `blocked by policy: ${reason}` }, governance, mutating };
    process.stderr.write(`warning: policy: ${reason}\n`);
  }
  // An adapter may only name keys of its own, so an imported manifest cannot ask for a neighbour's token.
  const prefix = new RegExp(`^(${upperSnake(m.name)}|DECLICK)_`);
  const stray = (m.auth?.env || []).filter(k => !prefix.test(k) && !allowList().includes(k));
  if (stray.length) throw fail(`${name} asks for ${stray.join(', ')}, outside ${upperSnake(m.name)}_*; rebuild the adapter or set DECLICK_ENV_ALLOW=${stray.join(',')}`, EXIT.AUTH);
  // A dry run sends nothing and masks every value, so it needs no key and no scope.
  if (!flags.dryRun) scopeCreds(scopeFor(m, flags));
  const argv = Object.fromEntries((v.args || []).map((a, i) => [a.name, args[i]]).filter(([, x]) => x !== undefined));
  let result;
  if (mutating && flags.dryRun) { governance.decision = 'dry-run'; governance.reason = 'preview only, nothing sent'; }
  // A policy warning on a read already said what governance decided; only an unpoliced read is "read-only verb".
  else if (!mutating) { if (!governance.source) governance.reason = 'read-only verb'; }
  else {
    const base = (typeof flags.baseUrl === 'string' && flags.baseUrl) || m.baseUrl;
    const g = await guard({ tool: name, action: verb, engine: m.engine, method: v.http?.method, args: argv,
      target: v.http?.path ? `${base || ''}${v.http.path}` : (m.window || base || m.source) });
    governance.decision = g.decision; governance.reason = g.reason;
    // Which governor decided, for the audit line: the local file says so, DashClaw is the enabled one that did not.
    if (g.source) governance.source = g.source;
    if (!g.allowed) result = { ok: false, exit: EXIT.BLOCKED, data: g.approvalId ? { approvalId: g.approvalId } : undefined,
      error: g.source === 'policy' ? `blocked by policy: ${g.reason}`
        : g.decision === 'require_approval' ? `needs approval: ${g.reason}${g.approvalId ? ` (approvalId ${g.approvalId})` : ''}` : `blocked by governance: ${g.reason}` };
  }
  result ??= await engines[m.engine].execute(m, verb, args, flags);
  return { result, governance, mutating };
}

// --each items: NDJSON, one object per line, or a JSON array when the file starts with [. Blank lines are skipped
// so a generated file with a trailing newline is not an error, and every item keeps where it came from.
function readEach(spec) {
  if (spec === true || spec === '') throw fail('--each needs a file of items, or - for stdin; e.g. --each items.ndjson');
  const from = spec === '-' ? '<stdin>' : String(spec);
  if (spec !== '-' && !existsSync(from)) throw fail(`no such file: ${from}; --each takes a file of items, or - for stdin`);
  const src = spec === '-' ? readFileSync(0, 'utf8') : readFileSync(from, 'utf8');
  if (src.trimStart().startsWith('[')) {
    let arr;
    try { arr = JSON.parse(src); } catch (e) { throw fail(`--each ${from} is not valid JSON (${e.message})`); }
    return arr.map((raw, i) => ({ raw, where: `${from} item ${i + 1}` }));
  }
  const items = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { items.push({ raw: JSON.parse(line), where: `${from} line ${i + 1}` }); }
    catch (e) { throw fail(`--each ${from} line ${i + 1} is not JSON (${e.message})`); }
  });
  return items;
}

// An item is {args, flags} or a flat object of the verb's arg and flag names; either way what was typed on the
// command line is its default and the item overrides per key. JSON values become the tokens a shell would have
// carried, so --fields still splits and --limit is still validated.
function stepOf({ raw, where }, { v, args, flags, dry }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`--each ${where}: an item must be a JSON object of {args, flags} or of ${v.name}'s arg and flag names, got ${JSON.stringify(raw) ?? typeof raw}`);
  const keys = Object.keys(raw);
  const a = [...args];
  let entry = {};
  // Half of one shape and half of the other is a file worth fixing, not a run worth guessing at.
  if (keys.some(k => k === 'args' || k === 'flags') && !keys.every(k => k === 'args' || k === 'flags')) throw fail(`--each ${where}: an item is either {args, flags} or a flat object of ${v.name}'s arg and flag names, not both`);
  if (keys.length && keys.every(k => k === 'args' || k === 'flags')) {
    if (raw.args !== undefined && !Array.isArray(raw.args)) throw fail(`--each ${where}: args must be an array of values`);
    if (raw.flags !== undefined && (!raw.flags || typeof raw.flags !== 'object' || Array.isArray(raw.flags))) throw fail(`--each ${where}: flags must be an object of flag values`);
    (raw.args || []).forEach((x, i) => { a[i] = x; });
    entry = raw.flags || {};
  } else for (const [k, val] of Object.entries(raw)) {
    const i = (v.args || []).findIndex(x => camel(x.name) === camel(k));
    if (i > -1) a[i] = val; else entry[k] = val;
  }
  let own;
  // A value the parser rejects is this item's failure, the same as a flag it does not know; only the file's own
  // shape stops the batch. The error is carried, not thrown, so the items around it still run.
  try { own = parseEntry(entry); } catch (e) { return { raw, error: fail(`--each ${where}: ${e.message}`, e.exit) }; }
  // A preview the caller asked for is a floor, not a default: an item may turn --dry-run on, never off.
  return { raw, args: a.map(x => (x === undefined || x === null ? x : String(x))), flags: { ...flags, ...own, ...(dry ? { dryRun: true } : {}) } };
}

// The item's data, shaped exactly as a single run of it would have been: --fields and --limit are the item's.
const shapeItem = (data, v, f) => shape(data, f.dryRun ? { limit: f.limit }
  : { fields: f.fields, limit: f.limit, rows: f.rows ?? (f.fields !== undefined || f.limit !== undefined ? v.returns?.rowsPath : undefined), auto: true }).data;

let flags = {}, verb, m, v, ran = false, result, text, args = [], mutating = false, each = null, defaults = [], errorNote;
let governance = { enabled: !!process.env.DASHCLAW_API_KEY, decision: 'skipped', reason: 'no mutating action' };
const ledger = new Map();
try {
  let positional; ({ positional, flags } = parseFlags(rest)); [verb, ...args] = positional;
  // What the command line itself asked for, kept aside: a default only counts as applied where nothing typed it.
  const typed = flags;
  if (!name) throw fail('usage: <adapter> <verb> [args] [--flags]; run: declick list');
  m = loadManifest(name);
  v = verb && verb !== 'describe' ? m.verbs.find(x => x.name === verb) : null;
  if (!verb || verb === 'describe' || (v && flags.help)) {
    if (flags.each !== undefined && !flags.help) throw fail(`--each needs a verb: ${name} <verb> --each ${flags.each === true ? '<file>' : flags.each}`);
    const opts = { full: !!flags.full || !!v, verb: v?.name };
    result = { ok: true, data: describeJson(m, opts) }; text = describe(m, opts);
    governance = { ...governance, reason: 'describe' };
  } else if (!v) {
    result = { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${name}${didYouMean(verb, m.verbs.map(x => x.name))}` };
  } else {
    // ~/.declick/<adapter>/defaults.json sits under the command line: --no-defaults and DECLICK_DEFAULTS=off skip it.
    const file = flags.defaults === false || process.env.DECLICK_DEFAULTS === 'off' ? null : loadDefaults(name);
    if (file) {
      const known = knownFlags(m, verb); const p = defaultsPath(name);
      for (const scope of ['*', verb]) for (const k of Object.keys(file[scope] || {}))
        if (!known.has(camel(k))) throw fail(`${p} sets --${k} for ${scope}, which ${verb} does not accept; run: declick defaults ${name}${scope === '*' ? '' : ` --verb ${scope}`} --unset ${k}`);
      let base;
      try { base = { ...parseEntry(file['*']), ...parseEntry(file[verb]) }; } catch (e) { throw fail(`${p}: ${e.message}; run: declick defaults ${name}`, e.exit); }
      defaults = Object.keys(base).filter(k => !(k in typed));
      flags = { ...base, ...typed };
    }
    // Same order as a single run has always had: the flags first, then what the verb is. One bad flag on the
    // command line is one error, not one per item, and the audit line knows a mutating verb even when it threw.
    checkFlags(v, verb, flags);
    mutating = !!v.mutating || derivedMutating(m, v) === true;
    if (flags.each !== undefined) {
      const steps = readEach(flags.each).map(it => stepOf(it, { v, args, flags, dry: !!typed.dryRun }));
      const entries = [], govs = []; let blockedAt = 0;
      for (const step of steps) {
        // Governance said no once; the rest of the file is not worth fifty more decisions, or fifty approval
        // tickets. Every input still gets an entry, in order, so the caller sees exactly which ones never ran.
        if (blockedAt) { entries.push({ input: step.raw, ok: false, exit: EXIT.BLOCKED, error: `not run: item ${blockedAt} was blocked` }); govs.push(governance); continue; }
        if (step.error) { entries.push({ input: step.raw, ok: false, exit: step.error.exit ?? EXIT.ERROR, error: step.error.message }); govs.push(governance); continue; }
        let one;
        try { one = await runOne({ m, v, verb, args: step.args, flags: step.flags }); }
        catch (e) { entries.push({ input: step.raw, ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }); govs.push(governance); }
        // scopeCreds clears the ledger per run, so the batch keeps the union: every key any item used, once.
        finally { for (const c of credUsage()) ledger.set(c.name, c); }
        if (!one) continue;
        govs.push(one.governance);
        if (!one.result.ok) { entries.push({ input: step.raw, ok: false, exit: one.result.exit ?? EXIT.ERROR, error: one.result.error }); if (one.result.exit === EXIT.BLOCKED) blockedAt = entries.length; continue; }
        try { entries.push({ input: step.raw, ok: true, exit: EXIT.OK, data: shapeItem(one.result.data, v, step.flags) }); }
        catch (e) { entries.push({ input: step.raw, ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }); }
      }
      const failed = entries.filter(e => !e.ok).length;
      const first = entries.findIndex(e => !e.ok);
      // Every item is guarded on its own; the batch reports the first failing decision, so one blocked item in
      // fifty is still what meta and the audit line say happened.
      governance = govs[first > -1 ? first : govs.length - 1] ?? governance;
      each = { count: entries.length, failed, exit: first > -1 ? entries[first].exit : EXIT.OK };
      if (failed) errorNote = `${failed} of ${entries.length} items failed: ${entries[first].error}`;
      result = { ok: true, data: entries, meta: { count: entries.length, failed, each: true } };
      text = entries.map((e, i) => `${i + 1}\t${e.ok ? 'ok' : `exit ${e.exit}`}\t${e.ok ? JSON.stringify(e.data) : e.error}`).join('\n');
    } else {
      ({ result, governance, mutating } = await runOne({ m, v, verb, args, flags }));
      ran = true;
    }
  }
} catch (e) { result = { ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR }; }

const creds = each ? [...ledger.values()] : credUsage();
result.meta = { ...(result.meta || {}), governance, ...(defaults.length ? { defaults } : {}), ...(creds.length ? { credentials: creds } : {}) };
const json = flags.json ?? explicitJson() ?? !process.stdout.isTTY;
// A verb whose spec says where its rows live unwraps them by default, but only once the caller asks to filter
// (--fields or --limit): otherwise the resource itself is the answer, not a guess at which array is "the rows".
const wantsRows = flags.fields !== undefined || flags.limit !== undefined;
// A batch is one envelope of items that are already shaped: the caller's --fields belonged to each item, and the
// list itself is never sliced, so its own length is the limit.
const out = emit(result, each ? { json, limit: Math.max(each.count, 1) }
  : { json, fields: flags.fields, limit: flags.limit, rows: ran ? flags.rows ?? (wantsRows ? v.returns?.rowsPath : undefined) : undefined, auto: ran, dryRun: !!flags.dryRun && result.ok });
// The envelope is ok because the batch ran; the exit code is the first item that was not.
if (each) out.exit = each.exit;
if (text && !json) out.text = text;
if (m && verb && verb !== 'describe') {
  try {
    const dir = manifestDir(name); mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString(); const ok = out.exit === 0;
    writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ verb, ok, exit: out.exit, dryRun: !!flags.dryRun, at, ...(ok ? {} : { error: errorNote ?? result.error }) }, null, 2) + '\n');
    // Every engine leaves the same breadcrumb for declick status, the ui and repair. The desktop engine
    // writes its tree diff during execute, so that field survives a rewrite of the same verb's failure.
    const p = join(dir, 'last-error.json');
    if (ok) rmSync(p, { force: true });
    else {
      const prev = readJson(p);
      writeFileSync(p, JSON.stringify({ verb, error: errorNote ?? result.error, exit: out.exit, ...(result.data !== undefined && !each ? { data: result.data } : {}), ...(prev?.verb === verb && prev.diff ? { diff: prev.diff } : {}), at }, null, 2) + '\n');
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
      ...(each ? { each: { count: each.count, failed: each.failed } } : {}),
      mutating, dryRun: !!flags.dryRun, governance, exit: out.exit, ok: out.exit === 0, ms: Date.now() - started,
    }) + '\n');
  } catch {}
}
process.stdout.write(out.text + '\n');
process.exitCode = out.exit;
