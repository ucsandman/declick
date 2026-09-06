import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT } from './output.mjs';

// A store is a directory the team shares (a synced folder, a network share, a cloned git repo) or a read-only
// https base: one bundle per adapter, <store>/<name>.json in the exact shape declick export prints, plus
// index.json so a listing (and an https store) never has to open every bundle. Bundles carry auth key NAMES,
// never values: each machine still reads its own env or vault at run time.
// home() is copied from defaults.mjs for the reason given there: keep this file out of the manifest/describe chain.
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const fail = (msg, exit = EXIT.ERROR) => Object.assign(new Error(msg), { exit });
const HTTP_TIMEOUT_MS = 15000;

export const storeConfigPath = () => join(home(), 'store.json');
const isHttp = s => /^https?:\/\//i.test(String(s || ''));
const isGit = dir => existsSync(join(dir, '.git'));

// DECLICK_STORE wins over the file so one shell (or one CI job) can point at a different store without
// rewriting what the user set; both empty is "no store", which every command names with the same fix.
export function storeLocation() {
  const env = process.env.DECLICK_STORE;
  if (env) return describeLocation(env.trim());
  const p = storeConfigPath();
  if (!existsSync(p)) return null;
  let file;
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw fail(`${p} is not valid JSON (${e.message}); run: declick store set <dir|https://...>`); }
  if (!file || typeof file.path !== 'string' || !file.path) throw fail(`${p} must be {"path": "<dir or https://...>"}; run: declick store set <dir|https://...>`);
  return describeLocation(file.path);
}

// PowerShell hands a native command a literal ~; bash expands it. Both spellings must land on the same folder.
const expandHome = p => p.replace(/^~(?=$|[\\/])/, homedir());
export const describeLocation = loc => isHttp(loc)
  ? { path: loc.replace(/\/+$/, ''), kind: 'http', git: false }
  : { path: resolve(expandHome(loc)), kind: 'dir', git: isGit(resolve(expandHome(loc))) };

export const requireStore = () => storeLocation() || (() => { throw fail('no store is set; run: declick store set <dir|https://...> (or set DECLICK_STORE)', EXIT.NOT_FOUND); })();

// A directory store is created if missing, so the first push from a fresh team folder needs no mkdir first;
// an https store is only remembered, it is read on the first pull.
export function setStore(loc) {
  if (typeof loc !== 'string' || !loc.trim()) throw fail('store set needs a directory or an https:// base');
  const d = describeLocation(loc.trim());
  if (d.kind === 'dir') {
    if (existsSync(d.path) && !statSync(d.path).isDirectory()) throw fail(`${d.path} exists and is not a directory`);
    mkdirSync(d.path, { recursive: true });
  }
  mkdirSync(home(), { recursive: true });
  writeFileSync(storeConfigPath(), JSON.stringify({ path: d.path }, null, 2) + '\n');
  return d;
}

// Key order is whatever each writer used; two bundles that say the same thing must hash the same.
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v);
// defaults are the one part of a bundle a user tunes locally on purpose, so they never make two adapters "differ".
export const bundleHash = b => createHash('sha256').update(stable({ manifest: b.manifest, recipes: b.recipes || {} })).digest('hex').slice(0, 16);

const atomicWrite = (p, text) => { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, p); };
const bundlePath = (dir, name) => join(dir, `${name}.json`);
const indexPath = dir => join(dir, 'index.json');

// Two machines pushing at the same instant both read index.json, both add their own line, and the second rename
// wins with the first entry gone. mkdir is atomic on every filesystem a shared folder lives on (local, SMB, NFS),
// so a lock directory serialises the read-modify-write; a lock older than STALE_MS belongs to a push that died.
const LOCK_WAIT_MS = 5000, LOCK_STALE_MS = 30000;
function withIndexLock(dir, fn) {
  const lock = join(dir, 'index.lock');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* vanished: retry */ }
      if (age > LOCK_STALE_MS) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* the other holder cleaned it */ } continue; }
      if (Date.now() > until) throw fail(`${lock} is held by another push; wait for it or delete the directory if no push is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ } }
}

// The bundles on disk are the truth; index.json is the listing. A directory store whose index lags (a push that
// died between the two writes, a file dropped in by hand) still lists every bundle, with the entry rebuilt.
function bundleEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json' && KEBAB.test(f.slice(0, -5)))
    .map(f => { try { return indexEntry(JSON.parse(readFileSync(join(dir, f), 'utf8')), null); } catch { return null; } }).filter(b => b?.name);
}
const mergeIndex = (idx, dir) => {
  const seen = new Set(idx.adapters.map(a => a.name));
  return { adapters: [...idx.adapters, ...bundleEntries(dir).filter(e => !seen.has(e.name))].sort((a, b) => a.name.localeCompare(b.name)) };
};

async function fetchJson(url, what) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { accept: 'application/json' } }); }
  catch (e) { throw fail(`${what}: ${url} did not answer (${e.name === 'TimeoutError' ? `no response in ${HTTP_TIMEOUT_MS / 1000}s` : e.message})`); }
  if (r.status === 404) return null;
  if (!r.ok) throw fail(`${what}: ${url} answered ${r.status}`);
  try { return await r.json(); } catch (e) { throw fail(`${what}: ${url} is not JSON (${e.message})`); }
}

// The index is a convenience for listing and the only listing an https store has; a directory store that lost
// its index still lists from the bundles on disk so nothing is invisible.
export async function readIndex(store) {
  if (store.kind === 'http') {
    const idx = await fetchJson(`${store.path}/index.json`, 'store index');
    if (!idx) throw fail(`${store.path}/index.json is missing; an https store needs the index a push writes`, EXIT.NOT_FOUND);
    return normIndex(idx);
  }
  const p = indexPath(store.path);
  let idx = { adapters: [] };
  if (existsSync(p)) { try { idx = normIndex(JSON.parse(readFileSync(p, 'utf8'))); } catch { /* rebuilt from the bundles */ } }
  return mergeIndex(idx, store.path);
}
const normIndex = idx => ({ adapters: Array.isArray(idx?.adapters) ? idx.adapters.filter(a => a && KEBAB.test(String(a.name))) : [] });

const indexEntry = (bundle, prev) => ({
  name: bundle.manifest.name, engine: bundle.manifest.engine, verbs: bundle.manifest.verbs.length, source: bundle.manifest.source,
  hash: bundleHash(bundle), pushedAt: prev?.pushedAt ?? new Date().toISOString(), by: prev?.by ?? `${userInfo().username}@${hostname()}`,
});

export async function readBundle(store, name) {
  if (!KEBAB.test(String(name))) throw fail(`bad adapter name ${JSON.stringify(name)}: must be kebab-case`);
  if (store.kind === 'http') return fetchJson(`${store.path}/${name}.json`, `bundle ${name}`);
  const p = bundlePath(store.path, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw fail(`${p} is not valid JSON (${e.message})`); }
}

// One bundle file and one index line, both written atomically: a teammate listing mid-push sees the old entry
// or the new one, never a torn file. Returns what changed so push can say "unchanged" instead of touching git.
export function writeBundle(store, bundle) {
  if (store.kind === 'http') throw fail(`${store.path} is an https store, which is read-only; push to a directory or a git checkout`);
  mkdirSync(store.path, { recursive: true });
  const name = bundle.manifest.name;
  const hash = bundleHash(bundle);
  let prev = null;
  try { prev = existsSync(bundlePath(store.path, name)) ? JSON.parse(readFileSync(bundlePath(store.path, name), 'utf8')) : null; } catch { prev = null; }
  const unchanged = !!prev && bundleHash(prev) === hash && stable(prev.defaults || null) === stable(bundle.defaults || null);
  const readIdx = () => { try { return existsSync(indexPath(store.path)) ? normIndex(JSON.parse(readFileSync(indexPath(store.path), 'utf8'))) : { adapters: [] }; } catch { return { adapters: [] }; } };
  const old = readIdx().adapters.find(a => a.name === name);
  if (unchanged && old && old.hash === hash) return { path: bundlePath(store.path, name), hash, unchanged: true, files: [] };
  atomicWrite(bundlePath(store.path, name), JSON.stringify(bundle, null, 2) + '\n');
  // The index is re-read under the lock: what another push added since the check above is kept, not clobbered.
  withIndexLock(store.path, () => {
    const idx = mergeIndex(readIdx(), store.path);
    const cur = idx.adapters.find(a => a.name === name);
    const entry = indexEntry(bundle, cur && cur.hash === hash ? cur : null);
    const adapters = [...idx.adapters.filter(a => a.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name));
    atomicWrite(indexPath(store.path), JSON.stringify({ adapters }, null, 2) + '\n');
  });
  return { path: bundlePath(store.path, name), hash, unchanged: false, files: [`${name}.json`, 'index.json'] };
}

// git is shelled only when the store root carries .git and the caller did not say --no-git; every outcome is a
// word in meta.git so an agent can tell "pulled" from "skipped" without reading stderr.
const git = (dir, args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000 }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' }; };

export function gitPull(store) {
  if (store.kind !== 'dir' || !store.git) return 'none';
  const r = git(store.path, ['pull', '--ff-only', '--quiet']);
  if (r.missing) throw fail('git is not installed but the store is a git checkout; install git or pass --no-git');
  if (!r.ok) throw fail(`git pull failed in ${store.path}: ${r.out.split('\n')[0] || 'unknown error'}; fix the checkout or pass --no-git`);
  return 'pulled';
}

export function gitPush(store, files, message) {
  if (store.kind !== 'dir' || !store.git || !files.length) return 'none';
  const add = git(store.path, ['add', '--', ...files]);
  if (add.missing) throw fail('git is not installed but the store is a git checkout; install git or pass --no-git');
  if (!add.ok) throw fail(`git add failed in ${store.path}: ${add.out.split('\n')[0]}`);
  const commit = git(store.path, ['commit', '--quiet', '-m', message, '--', ...files]);
  if (!commit.ok) { if (/nothing to commit|no changes added/i.test(commit.out)) return 'unchanged'; throw fail(`git commit failed in ${store.path}: ${commit.out.split('\n')[0]}`); }
  const remote = git(store.path, ['remote']);
  if (!remote.out) return 'committed (no remote)';
  const push = git(store.path, ['push', '--quiet']);
  if (!push.ok) throw fail(`git push failed in ${store.path}: ${push.out.split('\n')[0] || 'unknown error'}; the bundle is committed locally, push it by hand or fix the remote`);
  return 'pushed';
}

// What pull would do per adapter, from the index and the local bundles the caller already loaded: the plan is
// the dry-run output and the real run walks the same list, so the preview can never differ from the deed.
export function comparePlan(index, local) {
  const rows = index.adapters.map(a => {
    const mine = local[a.name];
    if (!mine) return { name: a.name, engine: a.engine, state: 'new', store: a.hash, local: null };
    const hash = bundleHash(mine);
    return { name: a.name, engine: a.engine, state: hash === a.hash ? 'in-sync' : 'update', store: a.hash, local: hash };
  });
  const known = new Set(index.adapters.map(a => a.name));
  for (const name of Object.keys(local).sort()) if (!known.has(name)) rows.push({ name, engine: local[name].manifest.engine, state: 'local-only', store: null, local: bundleHash(local[name]) });
  return rows;
}
