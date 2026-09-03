import { loadDefaults, defaultsLines } from './defaults.mjs';

// lint, build and skill all render describe, so a hand-edited defaults file must not take them down with it:
// an unreadable one is a line here, not a throw. Running a verb still fails loudly, since it cannot guess.
const storedDefaults = name => { try { return { file: loadDefaults(name) }; } catch { return { broken: true }; } };

// Manifest text comes from a spec or a recipe nobody wrote by hand: one bounded line, no backticks.
export const oneLine = (s, n = 200) => String(s).replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim().slice(0, n);

// Whatever a spec or an imported bundle put in a nested field, every string an agent reads back is one bounded line.
const scrub = (x, n = 200) => typeof x === 'string' ? oneLine(x, n) : Array.isArray(x) ? x.map(v => scrub(v, n)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v, n)])) : x;

// The machine-readable surface: everything an agent needs to call a verb, nothing that could be a secret.
export function describeJson(m, { verb } = {}) {
  const verbs = (verb ? m.verbs.filter(v => v.name === verb) : m.verbs)
    .map(v => ({ name: oneLine(v.name, 100), description: oneLine(v.description), mutating: v.mutating, args: (v.args || []).map(a => scrub(a)), flags: (v.flags || []).map(f => scrub({ ...f, description: f.description ?? '' })), returns: scrub(v.returns ?? null) }));
  const { file: defaults } = storedDefaults(m.name);
  return { name: oneLine(m.name, 100), engine: m.engine, source: oneLine(m.source, 500), baseUrl: m.baseUrl == null ? null : oneLine(m.baseUrl, 500), window: m.window == null ? null : oneLine(m.window, 500), builtAt: m.builtAt ?? null, auth: scrub(m.auth), ...(defaults ? { defaults } : {}), verbs };
}

// One line saying what comes back: the row fields, and the path --rows would unwrap by default.
function returnLine(r) {
  if (!r || r.shape === 'none') return null;
  const names = (r.fields || []).map(f => oneLine(f.name, 100));
  const body = names.length ? `{${names.join(', ')}}` : r.shape;
  if (r.shape === 'array') return `[ ${body} ]`;
  return r.rowsPath ? `[ ${body} ] rows: ${oneLine(r.rowsPath, 100)}` : body;
}

const sigOf = v => oneLine(v.name, 100) + v.args.map(a => (a.required === false ? ` [${oneLine(a.name, 100)}]` : ` <${oneLine(a.name, 100)}>`)).join('');

// Everything an agent needs to fill a value without a probe call: the allowed set, the default, one example.
const facetLine = x => [
  x.enum?.length ? `one of ${x.enum.map(e => oneLine(e, 40)).join('|')}` : null,
  x.default !== undefined ? `default: ${oneLine(x.default, 40)}` : null,
  x.example !== undefined ? `e.g. ${oneLine(x.example, 40)}` : null,
].filter(Boolean).join('  ');

// The whole describe() text has to clear lint's 2000-char ceiling: this is the budget for the verb block alone.
// 100 under the lint ceiling: bin/declick.mjs adds a `run:` line on top of this output and it must still fit.
const DESCRIBE_CAP = 1900;

export function describe(m, { full = false, verb, limit, offset } = {}) {
  // The first line names the thing every verb acts on, in that engine's own words: a base url is not a database file.
  const label = { sqlite: 'db', mcp: 'server', graphql: 'endpoint' }[m.engine] || 'base';
  // An adapter with alternates says so here, or --server is a flag nothing tells the agent it can use.
  const alts = (m.servers?.length || 0) > 1 ? ` (+${m.servers.length - 1} more, --server <i|description>)` : '';
  const target = m.baseUrl ? `  ${label}: ${oneLine(String(m.baseUrl).replace(/^(sqlite|mcp):/, ''), 500)}${alts}`
    : m.window ? `  window: "${oneLine(m.window, 500)}"`
      : m.engine === 'cli' ? `  bin: ${oneLine((m.verbs?.[0]?.cli?.argv || []).join(' '), 500)}` : '';
  const header = `${oneLine(m.name, 100)} (${m.engine})  source: ${oneLine(m.source, 500)}${target}`;
  const allVerbs = verb ? m.verbs.filter(v => v.name === verb) : m.verbs;
  const total = allVerbs.length;
  // Coerced here, not trusted from the caller: offset/limit arithmetic below would silently string-concat otherwise.
  const start = Number(offset) || 0;
  const hasLimit = limit != null;
  const lim = hasLimit ? Number(limit) : undefined;
  // Explicit paging shows exactly the requested slice; the default page fills itself up to the char budget.
  const pool = hasLimit ? allVerbs.slice(start, start + lim) : allVerbs.slice(start);
  const w = pool.length ? Math.max(...pool.map(v => sigOf(v).length)) : 0;
  const blockOf = v => {
    const block = [`  ${sigOf(v).padEnd(w)}  ${oneLine(v.description)}${v.mutating ? ' [mutating]' : ''}`];
    if (full) for (const a of v.args || []) { const x = facetLine(a); if (x) block.push(`      <${oneLine(a.name, 100)}>  ${x}`); }
    if (full) for (const f of v.flags || []) block.push(`      --${oneLine(f.name, 100)}${f.required ? ' (required)' : ''}  ${oneLine(f.description ?? '')}  ${facetLine(f)}`.trimEnd());
    if (full) { const r = returnLine(v.returns); if (r) block.push(`      -> ${r}`); }
    return block;
  };
  // Everything that isn't a verb line, so the loop below can stop with room left for it. The footer's own length
  // depends on how many verbs it names, but never more digits than `total`, so sizing it at `total` is a safe max.
  const hasFlags = allVerbs.some(v => (v.flags || []).length);
  const commonLine = `common: --json --fields --limit --rows --where --dry-run${hasFlags ? ' --full' : ''}   exit: 0 ok 1 err 2 missing 3 blocked 4 auth`;
  const requestLine = full && ['openapi', 'postman', 'har'].includes(m.engine) ? 'request: --header --base-url --server --content-type --body-file --output --retry --timeout --curl --verbose' : null;
  const authLine = m.auth?.env?.length ? `auth env: ${m.auth.env.map(e => oneLine(e, 100)).join(', ')}` : null;
  // A defaults file changes what every run of this adapter answers, so it is said out loud here rather than
  // leaving an agent to wonder where a --limit it never typed came from.
  const stored = storedDefaults(m.name);
  const defaultsLine = stored.broken ? `defaults: unreadable, run: declick defaults ${oneLine(m.name, 100)} --clear`
    : stored.file && Object.keys(stored.file).length ? oneLine(`defaults: ${defaultsLines(stored.file).join('; ')}`, 300) : null;
  const footerLine = n => `  ... ${n} more verbs (${total} total): declick describe ${oneLine(m.name, 100)} --grep <text> | --offset N --limit N | --verb v`;
  const tailBudget = [commonLine, requestLine, authLine, defaultsLine].filter(Boolean).reduce((s, l) => s + l.length + 1, 0) + footerLine(total).length + 1;
  const verbBudget = DESCRIBE_CAP - header.length - 1 - tailBudget;
  const shown = [], shownBlocks = [];
  let used = 0;
  for (const v of pool) {
    const block = blockOf(v);
    const added = block.reduce((s, l) => s + l.length + 1, 0);
    // Always take at least one verb per page; only a single verb too big to fit can still blow the lint ceiling.
    if (!hasLimit && shown.length > 0 && used + added > verbBudget) break;
    used += added;
    shown.push(v); shownBlocks.push(block);
  }
  const lines = [header, ...shownBlocks.flat()];
  const remaining = Math.max(0, total - (start + shown.length));
  if (remaining > 0) lines.push(footerLine(remaining));
  lines.push(commonLine);
  if (requestLine) lines.push(requestLine);
  if (authLine) lines.push(authLine);
  if (defaultsLine) lines.push(defaultsLine);
  return lines.join('\n');
}
