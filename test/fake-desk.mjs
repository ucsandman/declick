#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [verb, a, b] = process.argv.slice(2);
if (!verb) process.exit(0); // the test runner may load this file directly; no verb means nothing to do
const log = process.env.FAKE_DESK_LOG;
if (log) appendFileSync(log, JSON.stringify([verb, a, b]) + '\n');
if (process.env.FAKE_DESK_STOP === '1') { console.error('deskclaw is STOPPED'); process.exit(3); }
if (verb === 'snapshot') {
  // FAKE_DESK_CLOSED stands in for a window that is gone: deskclaw exits 2 and prints no tree.
  if (process.env.FAKE_DESK_CLOSED === '1') { console.error('no window matching that title'); process.exit(2); }
  process.stdout.write(`@e1 Window "${a}" [0,0]
  @e2 Group "Number pad" [0,0]
    @e3 Button "Seven" [0,0]
  @e4 Group "Standard operators" [0,0]
    @e5 Button "Plus" [0,0]
    @e6 Button "Equals" [0,0]
  @e7 Text "Display is ${process.env.FAKE_DESK_DISPLAY || '0'}" [0,0]
`);
  process.exit(0);
}
if (['click', 'type', 'key', 'focus'].includes(verb)) {
  if (process.env.FAKE_DESK_ARMED !== '1') { console.error('acting is not armed'); process.exit(4); }
  console.log(`${verb} ok`); process.exit(0);
}
process.exit(1);
