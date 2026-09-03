// Manifest text comes from a spec or a recipe nobody wrote by hand: one bounded line, no backticks.
export const oneLine = (s, n = 200) => String(s).replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim().slice(0, n);

// Whatever a spec or an imported bundle put in a nested field, every string an agent reads back is one bounded line.
const scrub = (x, n = 200) => typeof x === 'string' ? oneLine(x, n) : Array.isArray(x) ? x.map(v => scrub(v, n)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v, n)])) : x;

// The machine-readable surface: everything an agent needs to call a verb, nothing that could be a secret.
export function describeJson(m, { verb } = {}) {
  const verbs = (verb ? m.verbs.filter(v => v.name === verb) : m.verbs)
    .map(v => ({ name: oneLine(v.name, 100), description: oneLine(v.description), mutating: v.mutating, args: (v.args || []).map(a => scrub(a)), flags: (v.flags || []).map(f => scrub({ ...f, description: f.description ?? '' })), returns: scrub(v.returns ?? null) }));
  return { name: oneLine(m.name, 100), engine: m.engine, source: oneLine(m.source, 500), baseUrl: m.baseUrl == null ? null : oneLine(m.baseUrl, 500), window: m.window == null ? null : oneLine(m.window, 500), builtAt: m.builtAt ?? null, auth: scrub(m.auth), verbs };
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

export function describe(m, { full = false, verb } = {}) {
  // The first line names the thing every verb acts on, in that engine's own words: a base url is not a database file.
  const label = { sqlite: 'db', mcp: 'server', graphql: 'endpoint' }[m.engine] || 'base';
  // An adapter with alternates says so here, or --server is a flag nothing tells the agent it can use.
  const alts = (m.servers?.length || 0) > 1 ? ` (+${m.servers.length - 1} more, --server <i|description>)` : '';
  const target = m.baseUrl ? `  ${label}: ${oneLine(String(m.baseUrl).replace(/^(sqlite|mcp):/, ''), 500)}${alts}`
    : m.window ? `  window: "${oneLine(m.window, 500)}"`
      : m.engine === 'cli' ? `  bin: ${oneLine((m.verbs?.[0]?.cli?.argv || []).join(' '), 500)}` : '';
  const lines = [`${oneLine(m.name, 100)} (${m.engine})  source: ${oneLine(m.source, 500)}${target}`];
  const verbs = verb ? m.verbs.filter(v => v.name === verb) : m.verbs;
  const w = Math.max(...verbs.map(v => sigOf(v).length));
  for (const v of verbs) {
    lines.push(`  ${sigOf(v).padEnd(w)}  ${oneLine(v.description)}${v.mutating ? ' [mutating]' : ''}`);
    if (full) for (const a of v.args || []) { const x = facetLine(a); if (x) lines.push(`      <${oneLine(a.name, 100)}>  ${x}`); }
    if (full) for (const f of v.flags || []) lines.push(`      --${oneLine(f.name, 100)}${f.required ? ' (required)' : ''}  ${oneLine(f.description ?? '')}  ${facetLine(f)}`.trimEnd());
    if (full) { const r = returnLine(v.returns); if (r) lines.push(`      -> ${r}`); }
  }
  const hasFlags = verbs.some(v => (v.flags || []).length);
  lines.push(`common: --json --fields --limit --rows --dry-run${hasFlags ? ' --full' : ''}   exit: 0 ok 1 err 2 missing 3 blocked 4 auth`);
  // The engines that share openapi's request path take ten more flags. They cost a line, so only --full spends it.
  if (full && ['openapi', 'postman', 'har'].includes(m.engine)) lines.push('request: --header --base-url --server --content-type --body-file --output --retry --timeout --curl --verbose');
  if (m.auth?.env?.length) lines.push(`auth env: ${m.auth.env.map(e => oneLine(e, 100)).join(', ')}`);
  return lines.join('\n');
}
