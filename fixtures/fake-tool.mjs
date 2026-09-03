#!/usr/bin/env node
// A stand-in for a real command-line tool, so the cli engine can be compiled and run against a real
// child process in tests. Help is written in the common style: Usage:, a Commands: block, Options: lines.
// FAKE_TOOL_BARE=1 drops the Commands: block (a tool with no subcommands); FAKE_TOOL_NOHELP=1 makes
// --help print nothing so the engine has to fall back to -h.
const TOP = `Usage: fake <command> [options]

A pretend widget tool used to test the declick cli engine.

Commands:
  list      List widgets, newest first
  get       Show one widget by id
  create    Create a widget
  delete    Delete a widget

Options:
  -j, --json     Print JSON instead of text
  -h, --help     Print help
`;
const BARE = `Usage: fake [prefix] [options]

Print every widget as one line.

Options:
  -j, --json         Print JSON instead of text
  -t, --tag <tag>    Only widgets carrying this tag
  -h, --help         Print help
`;
const HELP = {
  list: `Usage: fake list [prefix] [options]

Options:
  -j, --json         Print JSON instead of text
  -t, --tag <tag>    Only widgets carrying this tag
`,
  get: `Usage: fake get <id> [options]

Options:
  -j, --json     Print JSON instead of text
`,
  create: `Usage: fake create [options]

Options:
  -n, --name <name>    Name for the new widget
      --tags <a,b>     Comma separated tags (default: none)
  -j, --json           Print JSON instead of text
`,
  delete: `Usage: fake delete <id> [options]

Options:
  -f, --force    Delete without confirming
  -j, --json     Print JSON instead of text
`,
};
const WIDGETS = [{ id: 7, name: 'gamma', tags: ['b', 'c'] }, { id: 1, name: 'alpha', tags: ['a'] }];
const byId = id => WIDGETS.filter(w => String(w.id) === id)[0];
const die = (msg, code) => { process.stderr.write(msg + '\n'); process.exit(code); };
const out = (rows, json) => process.stdout.write((json ? JSON.stringify(rows) : [].concat(rows).map(w => `${w.id}  ${w.name}  ${w.tags.join(',')}`).join('\n')) + '\n');

const bare = process.env.FAKE_TOOL_BARE === '1';
const argv = process.argv.slice(2);
const help = t => { if (process.env.FAKE_TOOL_NOHELP === '1' && argv.includes('--help')) process.exit(1); process.stdout.write(t); process.exit(0); };
const cmd = bare ? 'list' : argv[0];
if (!bare && (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help')) help(TOP);
if (bare && (argv.includes('--help') || argv.includes('-h'))) help(BARE);
const rest = bare ? argv : argv.slice(1);
if (!HELP[cmd]) die(`unknown command ${cmd}`, 1);
if (rest.includes('--help') || rest.includes('-h')) help(HELP[cmd]);

const flags = {}; const pos = [];
const TAKES = { json: 0, force: 0, f: 0, j: 0, name: 1, tags: 1, tag: 1, n: 1, t: 1 };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('-')) { pos.push(a); continue; }
  const name = a.replace(/^--?/, '').split('=')[0];
  if (!(name in TAKES)) die(`unknown option ${a}`, 1);
  flags[name] = a.includes('=') ? a.slice(a.indexOf('=') + 1) : TAKES[name] ? rest[++i] : true;
}
const json = !!(flags.json || flags.j);
if (cmd === 'list') {
  const tag = flags.tag || flags.t;
  out(WIDGETS.filter(w => (!pos[0] || w.name.startsWith(pos[0])) && (!tag || w.tags.includes(tag))), json);
} else if (cmd === 'get') {
  if (!pos[0]) die('get needs an id', 1);
  const w = byId(pos[0]);
  if (!w) die(`widget ${pos[0]} not found`, 2);
  out(json ? w : [w], json);
} else if (cmd === 'create') {
  const name = flags.name || flags.n;
  if (!name || name === true) die('create needs --name <name>', 1);
  out(json ? { id: 9, name, tags: String(flags.tags || '').split(',').filter(Boolean) } : [{ id: 9, name, tags: [] }], json);
} else if (cmd === 'delete') {
  if (!pos[0]) die('delete needs an id', 1);
  if (!(flags.force || flags.f)) die(`refusing to delete ${pos[0]} without --force`, 1);
  const w = byId(pos[0]);
  if (!w) die(`widget ${pos[0]} not found`, 2);
  process.stdout.write(json ? JSON.stringify({ deleted: w.id }) + '\n' : `deleted ${w.id}\n`);
}
