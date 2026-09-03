#!/usr/bin/env node
// Test double for deskclaw 0.3: the same commands, the same line format (indent @eN Type "Name" [x,y]
// plus the fixed-order attribute tail), the same exit codes and the same arm gate. Read verbs are never
// gated; acting verbs need FAKE_DESK_ARMED=1. FAKE_DESK_STATE makes acting stick across processes, which
// is what the double needs to answer a second snapshot differently from the first.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const [verb, a, b] = argv;
if (!verb) process.exit(0); // the test runner may load this file directly; no verb means nothing to do
const log = process.env.FAKE_DESK_LOG;
if (log) appendFileSync(log, JSON.stringify(argv) + '\n');
if (process.env.FAKE_DESK_STOP === '1') { console.error('deskclaw is STOPPED'); process.exit(3); }

const statePath = process.env.FAKE_DESK_STATE;
const state = (() => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } })();
const save = () => { if (statePath) writeFileSync(statePath, JSON.stringify(state)); };
const armed = () => { if (process.env.FAKE_DESK_ARMED !== '1') { console.error('acting is not armed'); process.exit(4); } };
const jstr = s => JSON.stringify(String(s));

// One element per row: [depth, type, name, attributes]. Attributes render in deskclaw's fixed order.
function rows(title) {
  const on = state.toggle ?? (process.env.FAKE_DESK_TOGGLE || 'off');
  const expanded = state.expanded ?? false;
  const entry = state.entry ?? process.env.FAKE_DESK_ENTRY ?? '';
  const r = [];
  r.push([0, 'Window', title, {}]);
  if (state.shifted) r.push([1, 'Group', 'Banner', {}]);
  r.push([1, 'Group', 'Number pad', {}]);
  r.push([2, 'Button', 'Seven', {}]);
  r.push([1, 'Group', 'Standard operators', {}]);
  r.push([2, 'Button', 'Plus', {}]);
  r.push([2, 'Button', 'Equals', {}]);
  r.push([1, 'Text', `Display is ${process.env.FAKE_DESK_DISPLAY || '0'}`, {}]);
  r.push([1, 'Edit', 'Entry', entry ? { value: entry } : {}]);
  r.push([1, 'CheckBox', 'Scientific', { toggle: on }]);
  r.push([1, 'ComboBox', 'Mode', { value: 'Standard', expanded }]);
  r.push([1, 'Button', 'Paste', { enabled: false }]);
  r.push([1, 'List', 'History', {}]);
  r.push([2, 'ListItem', 'row-1', state.selected === 'row-1' ? { selected: true } : {}]);
  r.push([3, 'Text', 'Expression', { value: '7 + 7' }]);
  r.push([3, 'Text', 'Answer', { value: '14' }]);
  r.push([2, 'ListItem', 'row-2', state.selected === 'row-2' ? { selected: true } : {}]);
  r.push([3, 'Text', 'Expression', { value: '1 + 1' }]);
  r.push([3, 'Text', 'Answer', { value: '2' }]);
  r.push([1, 'Text', 'Status', { value: process.env.FAKE_DESK_STATUS || 'ready', offscreen: true }]);
  return r.map(([depth, type, name, at], i) => ({ ref: `@e${i + 1}`, depth, type, name, ...at }));
}

function line(e) {
  let s = `${'  '.repeat(e.depth)}${e.ref} ${e.type} "${e.name}" [0,0]`;
  if (e.value) s += ` value=${jstr(e.value)}`;
  if (e.toggle) s += ` toggle=${e.toggle}`;
  if (e.selected === true) s += ' selected=true';
  if (e.enabled === false) s += ' enabled=false';
  if (e.expanded !== undefined) s += ` expanded=${e.expanded}`;
  if (e.offscreen === true) s += ' offscreen=true';
  if (e.popup !== undefined) s += ` popup=${jstr(e.popup)}`;
  return s;
}

const el = ref => rows(state.title || 'Calculator').find(e => e.ref === ref);
const gone = () => { console.error(`no element ${a} in the last snapshot`); process.exit(2); };
// FAKE_DESK_CLOSED stands in for a window that is gone; FAKE_DESK_OPEN_FILE for one that is not there
// until something starts it, which is what a launch step has to prove it did.
const closed = () => process.env.FAKE_DESK_CLOSED === '1' || (!!process.env.FAKE_DESK_OPEN_FILE && !existsSync(process.env.FAKE_DESK_OPEN_FILE));

if (verb === 'windows') {
  if (closed()) process.exit(0);
  console.log(`@w1 "${state.title || 'Calculator'}" (fake, 1) FakeWindowClass [0,0,400,300] focused=true`);
  process.exit(0);
}
if (verb === 'snapshot') {
  if (closed()) { console.error('no window matching that title'); process.exit(2); }
  state.title = a; state.n = (state.n || 0) + 1;
  // The tree an agent found and the tree it acts on are two different reads; shifting refs at snapshot N
  // reproduces the window that repainted in between.
  if (Number(process.env.FAKE_DESK_SHIFT_AT) && state.n >= Number(process.env.FAKE_DESK_SHIFT_AT)) state.shifted = true;
  save();
  process.stdout.write(rows(a).map(line).join('\n') + '\n# offscreen=1\n');
  process.exit(0);
}
if (verb === 'read') {
  const prop = (argv.indexOf('--prop') > 0 ? argv[argv.indexOf('--prop') + 1] : 'value') || 'value';
  const e = el(a); if (!e) gone();
  const v = prop === 'name' || prop === 'text' ? e.name : prop === 'value' ? e.value
    : prop === 'toggle' ? e.toggle : prop === 'selected' ? String(e.selected === true)
      : prop === 'enabled' ? String(e.enabled !== false) : undefined;
  if (v === undefined) { console.error(`'${a}' exposes no ${prop}`); process.exit(2); }
  console.log(v); process.exit(0);
}
if (verb === 'clipboard') {
  if (a === 'get') { console.log(state.clipboard ?? process.env.FAKE_DESK_CLIPBOARD ?? ''); process.exit(0); }
  if (a === 'set') { armed(); state.clipboard = b ?? ''; save(); console.log(`clipboard set (${String(b ?? '').length} chars)`); process.exit(0); }
  console.error('usage: desk clipboard get | desk clipboard set "<text>"'); process.exit(2);
}
if (['click', 'type', 'key', 'focus', 'dismiss', 'scroll', 'expand', 'collapse', 'select', 'context', 'toggle'].includes(verb)) {
  armed();
  if (['key', 'focus'].includes(verb) && closed()) { console.error('no window matching that title'); process.exit(2); }
  if (['click', 'type', 'scroll', 'expand', 'collapse', 'select', 'context', 'toggle'].includes(verb) && !el(a)) gone();
  if (verb === 'toggle') { const want = b || (el(a).toggle === 'on' ? 'off' : 'on'); state.toggle = want; save(); console.log(`toggled ${a} (${want})`); process.exit(0); }
  if (verb === 'expand') { state.expanded = true; save(); }
  if (verb === 'collapse') { state.expanded = false; save(); }
  if (verb === 'select') { state.selected = el(a).name; save(); }
  if (verb === 'type') { state.entry = b ?? ''; save(); }
  console.log(`${verb} ok`); process.exit(0);
}
process.exit(1);
