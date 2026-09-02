export function describe(m, { full = false } = {}) {
  const lines = [`${m.name} (${m.engine})  source: ${m.source}`];
  const w = Math.max(...m.verbs.map(v => (v.name + v.args.map(a => ` <${a.name}>`).join('')).length));
  for (const v of m.verbs) {
    const sig = v.name + v.args.map(a => (a.required === false ? ` [${a.name}]` : ` <${a.name}>`)).join('');
    lines.push(`  ${sig.padEnd(w)}  ${v.description}${v.mutating ? ' [mutating]' : ''}`);
    if (full) for (const f of v.flags || []) lines.push(`      --${f.name}  ${f.description || ''}`.trimEnd());
  }
  lines.push(`common: --json --fields --limit --dry-run   exit: 0 ok 1 err 2 missing 3 blocked 4 auth`);
  if (m.auth?.env?.length) lines.push(`auth env: ${m.auth.env.join(', ')}`);
  return lines.join('\n');
}
