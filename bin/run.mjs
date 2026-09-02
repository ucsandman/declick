#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, manifestDir } from '../src/manifest.mjs';
import { describe, describeJson } from '../src/describe.mjs';
import { emit, parseFlags, camel, EXIT } from '../src/output.mjs';
import { engines } from '../src/engines/index.mjs';
import { guard } from '../src/guard.mjs';

const CONTRACT = ['json', 'fields', 'limit', 'dryRun', 'full', 'help'];
const [name, ...rest] = process.argv.slice(2);
let flags = {}, verb, m, result, text;
try {
  let positional; ({ positional, flags } = parseFlags(rest)); let args; [verb, ...args] = positional;
  if (!name) throw Object.assign(new Error('usage: <adapter> <verb> [args] [--flags]; run: declick list'), { exit: EXIT.ERROR });
  m = loadManifest(name);
  const v = verb && verb !== 'describe' ? m.verbs.find(x => x.name === verb) : null;
  if (!verb || verb === 'describe' || (v && flags.help)) {
    const opts = { full: !!flags.full || !!v, verb: v?.name };
    result = { ok: true, data: describeJson(m, opts) }; text = describe(m, opts);
  } else if (!v) {
    result = { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${name}` };
  } else {
    const known = new Set([...CONTRACT, ...(v.flags || []).flatMap(f => [f.name, camel(f.name)])]);
    const bad = Object.keys(flags).filter(k => !known.has(k));
    if (bad.length) throw Object.assign(new Error(`unknown flag --${bad[0]} for ${verb}; run: ${name} describe --full`), { exit: EXIT.ERROR });
    if (v.mutating && !flags.dryRun) {
      const g = await guard({ tool: name, action: verb, engine: m.engine, method: v.http?.method, target: m.baseUrl || m.window });
      if (!g.allowed) result = { ok: false, exit: EXIT.BLOCKED, error: `blocked by governance: ${g.reason}` };
    }
    result ??= await engines[m.engine].execute(m, verb, args, flags);
  }
} catch (e) { result = { ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR }; }

const json = flags.json ?? !process.stdout.isTTY;
const out = emit(result, { json, fields: flags.fields, limit: flags.limit, dryRun: !!flags.dryRun && result.ok });
if (text && !json) out.text = text;
if (m && verb && verb !== 'describe') {
  try {
    const dir = manifestDir(name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'last-run.json'), JSON.stringify({ verb, ok: out.exit === 0, exit: out.exit, dryRun: !!flags.dryRun, at: new Date().toISOString() }, null, 2) + '\n');
  } catch {}
}
process.stdout.write(out.text + '\n');
process.exitCode = out.exit;
