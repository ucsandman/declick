import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { EXIT, RESERVED, camel } from '../output.mjs';
import { oneLine } from '../describe.mjs';
import { cmdQuote } from '../shared/windows-cmd-quote.mjs';

const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const MAX_VERBS = 40;
const HELP_MS = 10000;
// A command whose name says it changes something. A wrong guess costs one --dry-run, not data.
const MUTATING = new Set('create add set update delete remove rm push write apply deploy install uninstall kill stop start restart reset drop clear mv move cp copy edit patch put post send publish run exec'.split(' '));
// Bracket words every usage line carries. They stand for flags, not for an argument the agent supplies.
const GENERIC = new Set('options option flags flag opts args arg argument arguments command commands subcommand subcommands params parameters'.split(' '));
// A pager turns help into a hang and colour escapes turn it into noise no parser can read.
const childEnv = () => ({ ...process.env, NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' });

// Nothing is typed at a compiled tool: stdin is closed so a prompt fails fast instead of waiting for the timeout.
function run(argv, timeoutMs) {
  return new Promise(res => {
    // Node refuses to spawn .cmd/.bat without a shell, and npm, gh and yarn install as .cmd on Windows.
    const shell = /\.(cmd|bat)$/i.test(argv[0]);
    // cmd.exe splits its line on & | > < ^ outside quotes, so EVERY argument is quoted, not just the ones with a space.
    const args = argv.slice(1).map(a => (shell ? cmdQuote(a) : a));
    let out = '', err = '';
    const p = spawn(argv[0], args, { shell, env: childEnv(), timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => res({ code: 1, out: '', err: e.message, spawnError: e.code || 'SPAWN' }));
    p.on('close', (code, signal) => res({ code: code ?? 1, out, err, signal }));
  });
}

async function pool(items, n, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]); }));
  return out;
}

async function resolveBin(bin) {
  if (/[\\/]/.test(bin)) {
    if (!existsSync(bin)) throw fail(`${bin} does not exist; pass a binary on PATH or a real path`);
    return resolve(bin);
  }
  const r = await run([process.platform === 'win32' ? 'where' : 'which', bin], HELP_MS);
  const hit = r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  if (r.code || !hit) throw fail(`${bin} is not on PATH; install it or use cli:<absolute path>`);
  return hit;
}

// Help that is one line, or that says nothing about usage, is an error message: keep probing.
const helpish = t => t.trim().split('\n').length > 1 && /usage|options|flags|commands/i.test(t);
async function helpText(argv, probes) {
  for (const p of probes) {
    const r = await run([...argv, p], HELP_MS);
    const t = r.out.trim() ? r.out : r.err;
    if (helpish(t)) return t;
  }
  return '';
}

const CMD_HEADER = /^\s{0,3}(?:[\w ]+ )?(?:commands|subcommands)\s*:?\s*$|^these are common .*commands/i;
const STOP_HEADER = /^\s{0,3}(?:usage|options|flags|arguments|examples?|environment|see also|learn more|help topics|aliases|inherited flags)\b/i;
const ENTRY = /^\s{2,}([a-z][a-z0-9_.-]*):?(?:\s{2,}|\t+)(\S.*?)\s*$/;
const LIST = /^\s{2,}([a-z][a-z0-9_.-]*(?:\s*,\s*[a-z][a-z0-9_.-]*)+),?\s*$/;

// Command names live either in an indented "name  summary" block or, on npm, in a bare comma list under
// "All commands:". Entries found under a real Commands header win; the loose scan only covers help that has none.
export function parseCommands(text) {
  const hits = []; let mode = 'none';
  for (const line of text.split(/\r?\n/)) {
    if (CMD_HEADER.test(line)) { mode = 'cmd'; continue; }
    if (STOP_HEADER.test(line)) { mode = 'stop'; continue; }
    if (mode === 'stop') continue;
    const e = line.match(ENTRY);
    if (e) { hits.push({ name: e[1], summary: e[2], strong: mode === 'cmd' }); continue; }
    const l = line.match(LIST);
    if (l) for (const n of l[1].split(',')) hits.push({ name: n.trim(), summary: '', strong: mode === 'cmd' });
  }
  const strong = hits.some(h => h.strong);
  const out = new Map();
  for (const h of hits) if ((!strong || h.strong) && !out.has(h.name)) out.set(h.name, h.summary);
  return [...out].map(([name, summary]) => ({ name, summary }));
}

// An option line is "-n, --name <value>  description": everything up to the first double space is the spec,
// and a long flag with anything after it takes a value, whatever shape the tool writes the placeholder in.
// git writes the pair --foo/--no-foo as "--[no-]foo" and wraps a long spec onto the next line.
export function parseOptions(text) {
  const out = []; const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s+-/.test(line)) continue;
    const body = line.trim();
    const cut = body.search(/\s{2,}/);
    const spec = cut > -1 ? body.slice(0, cut) : body;
    const wrapped = cut > -1 || !/^\s{6,}[^-\s]/.test(lines[i + 1] || '') ? '' : lines[i + 1].trim();
    const description = (cut > -1 ? body.slice(cut).trim() : wrapped).replace(/\s+/g, ' ');
    const long = spec.match(/--(?:\[no-\])?([a-zA-Z0-9][\w-]*)/);
    if (!long) continue;
    const short = spec.match(/(?:^|[\s,])-([a-zA-Z0-9])(?![\w-])/);
    const rest = spec.slice(spec.indexOf(long[0]) + long[0].length);
    const def = description.match(/\(default:?\s*([^)]+)\)/i);
    // "--porcelain[=<version>]" only reads its value when the value is attached with =, never as the next word.
    const joined = /^\[?=/.test(rest);
    out.push({ long: long[1], short: short ? short[1] : null, takesValue: joined || /^[=\s]\S/.test(rest), joined, description, def: def ? def[1].trim() : null });
  }
  return out;
}

export function parseUsage(text, cmd) {
  const lines = text.split(/\r?\n/);
  let usage = null;
  for (let i = 0; i < lines.length && usage === null; i++) {
    const inline = lines[i].match(/^\s*usage\s*:\s*(\S.*)$/i);
    if (inline) usage = inline[1];
    else if (/^\s*usage\s*:?\s*$/i.test(lines[i])) usage = lines.slice(i + 1).filter(l => l.trim())[0] ?? null;
  }
  if (usage === null) return [];
  const at = cmd ? usage.indexOf(` ${cmd} `) : -1;
  const seen = new Set(); const out = []; let depth = 0;
  for (const tok of (at > -1 ? usage.slice(at + cmd.length + 1) : usage).split(/\s+/)) {
    // Brackets nest ("[[--] <path>...]"), so an argument is optional when anything above it is still open.
    const optional = depth > 0 || tok.startsWith('[');
    depth += (tok.match(/\[/g) || []).length - (tok.match(/]/g) || []).length;
    // "[-s]" and "[--amend]" are the tool's own flags spelled out in the usage line, not arguments.
    if (!/^[<[]/.test(tok) || tok.includes('|') || tok.replace(/^[[(]+/, '').startsWith('-')) continue;
    const name = kebab(tok.replace(/\.\.\./g, '').replace(/[<>[\]()"']/g, ''));
    if (!name || GENERIC.has(name) || RESERVED.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, required: !optional });
  }
  return out;
}

// --help is answered by declick itself, and a tool's --version is not a verb flag. Anything else that
// collides with a contract flag keeps working under param-<name>; cli.wire holds the name the tool expects.
function flagsOf(text) {
  const seen = new Set(); const flags = []; const cli = [];
  for (const o of parseOptions(text)) {
    if (o.long === 'help' || o.long === 'version') continue;
    const name = RESERVED.includes(o.long) ? `param-${o.long}` : o.long;
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    flags.push({ name, description: oneLine(o.description), required: false, type: o.takesValue ? 'string' : 'boolean', ...(o.def ? { example: oneLine(o.def, 100) } : {}) });
    cli.push({ name, short: o.short, takesValue: o.takesValue, ...(o.joined ? { joined: true } : {}), ...(name === o.long ? {} : { wire: o.long }) });
  }
  return { flags, cli };
}

const firstProse = text => text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^usage/i.test(l) && !/^[-<[$]/.test(l))[0] || '';

function verbOf(name, summary, argv, text) {
  const { flags, cli } = flagsOf(text);
  return {
    name, description: oneLine(summary || firstProse(text) || `run ${argv[argv.length - 1]} ${name}`, 80),
    args: parseUsage(text, name).map(a => ({ name: a.name, required: a.required, type: 'string' })),
    mutating: name.split('-').some(s => MUTATING.has(s)), flags,
    cli: { argv, flags: cli, passthrough: true },
  };
}

export async function compile(source, { name, verbs: only } = {}) {
  const tokens = (String(source).replace(/^cli:/, '').match(/"[^"]*"|\S+/g) || []).map(t => t.replace(/^"|"$/g, ''));
  if (!tokens.length) throw fail('usage: declick add cli:<binary> [fixed args]   e.g. cli:gh or cli:node ./tool.mjs');
  const argv = [await resolveBin(tokens[0]), ...tokens.slice(1)];
  const adapter = name || kebab(basename(argv[argv.length - 1]).replace(/\.[^.]+$/, ''));
  const top = await helpText(argv, ['--help', '-h', 'help']);
  if (!top) throw fail(`${tokens[0]} printed no help for --help, -h or help; declick compiles a cli adapter from its help screen`);
  const found = parseCommands(top).filter(c => c.name !== 'help');
  const wanted = typeof only === 'string' ? only.split(',').map(s => s.trim()).filter(Boolean) : only;
  const named = c => (c.name === 'describe' ? 'describe-cmd' : c.name);
  let picked = found.filter(c => !wanted?.length || wanted.includes(named(c)));
  if (wanted?.length && !picked.length) throw fail(`no command matches ${wanted.join(', ')}; available: ${found.map(named).slice(0, 20).join(', ')}`);
  if (picked.length > MAX_VERBS) {
    process.stderr.write(`compiling the first ${MAX_VERBS} of ${picked.length} commands; narrow with --verbs a,b\n`);
    picked = picked.slice(0, MAX_VERBS);
  }
  // A subcommand's own help: -h first because git-style tools answer <cmd> --help with a pager or a browser.
  const verbs = picked.length
    ? await pool(picked, 4, async c => verbOf(named(c), c.summary, [...argv, c.name], await helpText([...argv, c.name], ['-h', '--help'])))
    : [verbOf('run', '', argv, top)];
  return {
    name: adapter, engine: 'cli', builtAt: new Date().toISOString(), auth: { env: [] },
    source: `cli:${argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, verbs,
  };
}

function buildArgv(m, v, positional, flags) {
  const need = (v.args || []).filter(a => a.required !== false);
  if (positional.length < need.length) throw fail(`${v.name} needs ${need.map(a => `<${a.name}>`).join(' ')}; run: ${m.name} describe --full`);
  const contract = new Set(RESERVED.map(camel));
  const known = new Map();
  for (const f of v.cli.flags) { known.set(f.name, f); known.set(camel(f.name), f); }
  const argv = [...v.cli.argv, ...positional.map(String)];
  for (const [key, val] of Object.entries(flags)) {
    if (contract.has(key) || val === undefined) continue;
    const f = known.get(key);
    if (!f) throw fail(`unknown flag --${key} for ${v.name}; run: ${m.name} describe --full`);
    for (const one of [].concat(val)) {
      if (f.takesValue) {
        if (one === true) throw fail(`flag --${f.name} needs a value`);
        if (f.joined) argv.push(`--${f.wire || f.name}=${one}`);
        else argv.push(`--${f.wire || f.name}`, String(one));
      } else if (one === true || one === 'true') argv.push(`--${f.wire || f.name}`);
      else if (one !== false && one !== 'false') throw fail(`flag --${f.name} takes no value, got ${one}`);
    }
  }
  return argv;
}

export async function execute(m, verb, positional = [], flags = {}) {
  const v = m.verbs.find(x => x.name === verb);
  if (!v) return { ok: false, exit: EXIT.NOT_FOUND, error: `unknown verb ${verb}; run: declick describe ${m.name}` };
  let argv;
  try { argv = buildArgv(m, v, positional, flags); }
  catch (e) { return { ok: false, exit: e.exit ?? EXIT.ERROR, error: e.message }; }
  if (flags.dryRun) return { ok: true, data: { argv } };

  const ms = Number(process.env.DECLICK_TIMEOUT_MS) || 30000;
  const r = await run(argv, ms);
  if (r.spawnError === 'ENOENT') return { ok: false, exit: EXIT.ERROR, error: `${argv[0]} is not there any more; run: declick build ${m.name}` };
  if (r.spawnError) return { ok: false, exit: EXIT.ERROR, error: `cannot run ${argv[0]}: ${oneLine(r.err)}` };
  // A killed child means the timeout fired: report it as an error, never as empty output.
  if (r.signal) return { ok: false, exit: EXIT.ERROR, error: `${m.name} ${verb} timed out after ${ms}ms; raise DECLICK_TIMEOUT_MS` };
  const out = r.out.replace(/\s+$/, ''); const err = r.err.trim();
  const streams = { stdout: out.includes('\n') ? out.split(/\r?\n/) : out, stderr: err, code: r.code };
  if (r.code) {
    const first = (err || out).split('\n')[0];
    return { ok: false, exit: r.code === 2 || /not found|no such/i.test(err) ? EXIT.NOT_FOUND : EXIT.ERROR, error: oneLine(first || `${verb} exited ${r.code}`), data: streams };
  }
  // A tool that already speaks JSON needs no shaping; anything else is text the agent can still --fields over.
  if (/^[[{]/.test(out)) { try { return { ok: true, data: JSON.parse(out) }; } catch {} }
  return { ok: true, data: streams };
}
