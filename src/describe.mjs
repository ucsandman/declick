// The machine-readable surface: everything an agent needs to call a verb, nothing that could be a secret.
export function describeJson(m, { verb } = {}) {
  const verbs = (verb ? m.verbs.filter(v => v.name === verb) : m.verbs)
    .map(v => ({ name: v.name, description: v.description, mutating: v.mutating, args: v.args, flags: v.flags || [] }));
  return { name: m.name, engine: m.engine, source: m.source, baseUrl: m.baseUrl ?? null, window: m.window ?? null, builtAt: m.builtAt ?? null, auth: m.auth, verbs };
}

export function describe(m, { full = false, verb } = {}) {
  const target = m.baseUrl ? `  base: ${m.baseUrl}` : m.window ? `  window: "${m.window}"` : '';
  const lines = [`${m.name} (${m.engine})  source: ${m.source}${target}`];
  const verbs = verb ? m.verbs.filter(v => v.name === verb) : m.verbs;
  const w = Math.max(...verbs.map(v => (v.name + v.args.map(a => ` <${a.name}>`).join('')).length));
  for (const v of verbs) {
    const sig = v.name + v.args.map(a => (a.required === false ? ` [${a.name}]` : ` <${a.name}>`)).join('');
    lines.push(`  ${sig.padEnd(w)}  ${v.description}${v.mutating ? ' [mutating]' : ''}`);
    if (full) for (const f of v.flags || []) lines.push(`      --${f.name}${f.required ? ' (required)' : ''}  ${f.description || ''}`.trimEnd());
  }
  const hasFlags = verbs.some(v => (v.flags || []).length);
  lines.push(`common: --json --fields --limit --dry-run${hasFlags ? ' --full' : ''}   exit: 0 ok 1 err 2 missing 3 blocked 4 auth`);
  if (m.auth?.env?.length) lines.push(`auth env: ${m.auth.env.join(', ')}`);
  return lines.join('\n');
}
