#!/usr/bin/env node
import { loadManifest } from '../src/manifest.mjs';
import { describe } from '../src/describe.mjs';
import { emit, parseFlags, EXIT } from '../src/output.mjs';
import { engines } from '../src/engines/index.mjs';

async function guard(name, verb) {
  const key = process.env.DASHCLAW_API_KEY;
  if (!key) { process.stderr.write('warning: ungoverned mutating call (set DASHCLAW_API_KEY to gate)\n'); return true; }
  try {
    const r = await fetch(`${process.env.DASHCLAW_URL || 'https://my-dashclaw.vercel.app'}/api/guard`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ tool: name, action: verb, risk_score: 40, source: 'declick' }),
    });
    const j = await r.json().catch(() => ({}));
    if (['block', 'require_approval'].includes(j.decision)) { process.stderr.write(`blocked by governance: ${j.reason || j.decision}\n`); return false; }
  } catch (e) { process.stderr.write(`warning: governance unreachable (${e.message}); proceeding\n`); }
  return true;
}

const [name, ...rest] = process.argv.slice(2);
const { positional, flags } = parseFlags(rest);
const [verb, ...args] = positional;
let result;
try {
  const m = loadManifest(name);
  if (!verb || verb === 'describe') { process.stdout.write(describe(m, { full: !!flags.full }) + '\n'); process.exit(0); }
  const v = m.verbs.find(x => x.name === verb);
  if (v?.mutating && !flags.dryRun && !(await guard(name, verb))) process.exit(EXIT.BLOCKED);
  result = await engines[m.engine].execute(m, verb, args, flags);
} catch (e) {
  result = { ok: false, error: e.message, exit: e.exit ?? EXIT.ERROR };
}
const { text, exit } = emit(result, { json: flags.json === true || !process.stdout.isTTY, fields: flags.fields, limit: flags.limit });
process.stdout.write(text + '\n');
process.exit(exit);
