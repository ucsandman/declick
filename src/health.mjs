import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXIT } from './output.mjs';

// home() and KEBAB are copied from cache.mjs for the reason given there: bin/run.mjs and the desktop engine load
// this on every call, and importing manifest.mjs would pull describe.mjs and the defaults file in behind it.
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// One verb's run health, read off ~/.declick/<adapter>/last-error.json. No failures[verb] is ok; a failure with no
// tree diff is failing (a bad key, a block, a closed window, a typo'd arg); a failure carrying a diff is broken,
// the desktop element miss that repair re-authors. last-run.json is the newest call of any verb, so it is a
// label beside the machine, never a state of it.
export const HEALTH_STATES = ['ok', 'failing', 'broken'];
// run, preview and author are an exit 0 (preview: under --dry-run or from the cache); fail is any other exit of
// a manifest verb; miss is the desktop engine losing an element path; repair is declick repair saving the verb.
export const HEALTH_EVENTS = ['run', 'preview', 'author', 'fail', 'miss', 'repair'];
// event -> from -> to. An event with no entry for a state is refused there: a writer leaves the record as it
// was, a caller gets IllegalTransitionError.
export const HEALTH_TABLE = {
  run: { ok: 'ok', failing: 'ok', broken: 'ok' },
  // A preview sent nothing and a cache hit asked nobody, so neither proves the verb works again.
  preview: { ok: 'ok', failing: 'failing', broken: 'broken' },
  author: { ok: 'ok', failing: 'ok', broken: 'ok' },
  // A later failure of a broken verb keeps its diff: the element miss is still what repair needs.
  fail: { ok: 'failing', failing: 'failing', broken: 'broken' },
  miss: { ok: 'broken', failing: 'broken', broken: 'broken' },
  // Repair is seeded with the recorded diff, so it is legal only where a miss left one.
  repair: { broken: 'ok' },
};
export const HEALTH_STATE_LABELS = { ok: 'ok', failing: 'failing', broken: 'element path stopped resolving' };
// What a caller can ask for; fail and miss are outcomes the runtime records, never requests.
const REQUESTABLE = ['run', 'preview', 'author', 'repair'];

export class IllegalTransitionError extends Error {
  constructor(message, { current, requested, allowed }) {
    super(message);
    this.name = 'IllegalTransitionError';
    this.code = 'illegal_transition';
    this.exit = EXIT.ERROR;
    this.current = current; this.requested = requested; this.allowed = allowed;
    // bin/declick.mjs's top-level catch puts e.exit and e.data on the envelope as they are.
    this.data = { error: 'illegal_transition', current, requested, allowed };
  }
}

export const canApply = (state, event) => Object.hasOwn(HEALTH_TABLE, event) && Object.hasOwn(HEALTH_TABLE[event], state);
export const nextEvents = state => REQUESTABLE.filter(e => canApply(state, e));
export function assertApply(state, event, { adapter, verb } = {}) {
  if (canApply(state, event)) return HEALTH_TABLE[event][state];
  const who = adapter && verb ? `${adapter} ${verb}` : 'this verb';
  const msg = event === 'repair'
    ? `${who} ${state === 'ok' ? 'has no recorded failure' : 'is failing'} (${state}); repair needs a recorded element miss. Run it to record one, or re-author it: declick author ${adapter || '<name>'} --verb ${verb || '<verb>'} --goal "..."`
    : `${event} is not allowed for ${who} (${state}); allowed: ${nextEvents(state).join(', ') || 'none'}`;
  throw new IllegalTransitionError(msg, { current: state, requested: event, allowed: nextEvents(state) });
}

const dirOf = name => join(home(), String(name));
const errPath = name => join(dirOf(name), 'last-error.json');
const runPath = name => join(dirOf(name), 'last-run.json');
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
// Same pattern as store.mjs: a reader sees the old file or the new one, never half of one read as "no failure".
const atomicWrite = (p, text) => {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try { renameSync(tmp, p); } catch (e) { rmSync(tmp, { force: true }); throw e; }
};
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
// A file written before the failures map is one record: the newest failure, of le.verb.
function failuresOf(le) {
  if (!isObj(le)) return {};
  if (isObj(le.failures)) return Object.fromEntries(Object.entries(le.failures).filter(([, f]) => isObj(f)));
  if (typeof le.verb !== 'string' || !le.verb) return {};
  const { verb, data, failures, ...rest } = le;
  return { [verb]: rest };
}
// The top-level record every older reader knows: {verb, error, exit?, data?, diff?, at}, the newest failure.
function lastOf(le) {
  if (!isObj(le) || typeof le.verb !== 'string') return null;
  const { failures, ...rest } = le;
  return rest;
}

export function readHealth(name) {
  if (!KEBAB.test(String(name))) return { lastRun: null, failures: {}, last: null };
  const le = readJson(errPath(name));
  return { lastRun: readJson(runPath(name)), failures: failuresOf(le), last: lastOf(le) };
}

export function verbState(h, verb) {
  const f = h?.failures && Object.hasOwn(h.failures, verb) ? h.failures[verb] : null;
  if (!f) return 'ok';
  return isObj(f.diff) ? 'broken' : 'failing';
}

// What declick status, declick list and the ui read: the worst state of the manifest's own verbs, one entry per
// verb that is not ok (newest first), and the command that fixes a broken one. A verb no longer in the manifest
// is ignored, so a removed verb's stale record never shows.
export function healthOf(name, m, h = readHealth(name)) {
  const failing = (m?.verbs || []).map(v => v.name).filter(verb => verbState(h, verb) !== 'ok').map(verb => {
    const f = h.failures[verb], state = verbState(h, verb);
    return { verb, state, exit: f.exit, error: f.error, at: f.at, allowedNext: nextEvents(state) };
  }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const state = failing.reduce((w, f) => (HEALTH_STATES.indexOf(f.state) > HEALTH_STATES.indexOf(w) ? f.state : w), 'ok');
  const nextActions = m?.engine === 'desktop' ? failing.filter(f => canApply(f.state, 'repair')).map(f => `declick repair ${name} ${f.verb}`) : [];
  return { state, failing, nextActions };
}

const record = ({ verb, error, exit, data, diff, at }) => ({ verb, error, ...(exit !== undefined ? { exit } : {}), ...(data !== undefined ? { data } : {}), ...(diff ? { diff } : {}), at });

// The one place either file is written. An event the table refuses for the verb's state, and every identity that
// carries nothing new, leaves the stored record exactly as it was. Returns the verb's state afterwards.
function apply(name, verb, event, { error, exit, data, diff, at = new Date().toISOString() } = {}) {
  if (!KEBAB.test(String(name)) || typeof verb !== 'string' || !verb || !HEALTH_EVENTS.includes(event)) return null;
  const le = readJson(errPath(name));
  const failures = failuresOf(le), last = lastOf(le);
  const from = verbState({ failures }, verb);
  if (!canApply(from, event)) return from;
  const to = HEALTH_TABLE[event][from];
  let top;
  if (event === 'fail' || event === 'miss') {
    // A miss brings its own diff; any other failure keeps the one a miss of this verb left, as run.mjs always did.
    const keep = event === 'miss' ? diff : to === 'broken' ? failures[verb].diff : undefined;
    failures[verb] = { error, ...(exit !== undefined ? { exit } : {}), ...(keep ? { diff: keep } : {}), at };
    top = record({ verb, ...failures[verb], data: event === 'fail' ? data : undefined });
  } else if (to === 'ok' && from !== 'ok') {
    delete failures[verb];
    const newest = Object.keys(failures).sort((a, b) => String(failures[b].at || '').localeCompare(String(failures[a].at || '')))[0];
    if (!newest) { rmSync(errPath(name), { force: true }); return to; }
    top = record({ verb: newest, ...failures[newest], data: last?.verb === newest ? last.data : undefined });
  } else return to;
  mkdirSync(dirOf(name), { recursive: true });
  atomicWrite(errPath(name), JSON.stringify({ ...top, failures }, null, 2) + '\n');
  return to;
}

// bin/run.mjs, once per invocation of a verb. last-run.json keeps today's fields plus cache:true on a hit; the
// health record moves only for a verb the manifest has. Never throws: a breadcrumb must not fail the run.
export function recordRun(name, { verb, known = true, ok, exit, dryRun = false, cache = false, error, data } = {}) {
  try {
    if (!KEBAB.test(String(name)) || typeof verb !== 'string' || !verb) return null;
    const at = new Date().toISOString();
    mkdirSync(dirOf(name), { recursive: true });
    atomicWrite(runPath(name), JSON.stringify({ verb, ok, exit, dryRun: !!dryRun, ...(cache ? { cache: true } : {}), at, ...(ok ? {} : { error }) }, null, 2) + '\n');
    if (!known) return null;
    return apply(name, verb, ok ? (dryRun || cache ? 'preview' : 'run') : 'fail', { error, exit, data, at });
  } catch { return null; }
}

// The desktop engine, when an element path stops resolving.
export function recordMiss(name, verb, { error, diff } = {}) {
  try { return apply(name, verb, 'miss', { error, diff: isObj(diff) ? diff : { missing: [], added: [] } }); } catch { return null; }
}

// Everything else that moves one verb: a real desktop replay (run), a saved recipe (author, repair).
export function recordEvent(name, verb, event, details) {
  try { return apply(name, verb, event, details); } catch { return null; }
}

// The ui's last-run cell. A dry run and a cache hit worked, but nothing live answered, so they say so.
export function lastRunLabel(lr) {
  if (!lr) return 'never run';
  if (!lr.ok) return `exit ${lr.exit}`;
  return lr.cache ? 'cached ok' : lr.dryRun ? 'preview ok' : 'ok';
}
