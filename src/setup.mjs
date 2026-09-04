// setup wires declick into the agents on this machine (PATH, MCP adapters, a rules block, the Claude Code
// hook) and can undo all of it byte-exactly. build() and removeAdapter() live in bin/declick.mjs (they close
// over the engine registry and the command table) and are passed in here rather than duplicated.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXIT } from './output.mjs';
import { HOME, listManifests, loadManifest, manifestDir } from './manifest.mjs';
import { installPath, binDir } from './launcher.mjs';
import { restoreAll, undoPath, START, END } from './setup-revert-standalone.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
export const clientHomeOf = () => process.env.DECLICK_CLIENT_HOME || homedir();
const readJson = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const kebabName = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tokenKey = name => `${name.toUpperCase().replace(/-/g, '_')}_TOKEN`;
const safeDirs = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
// A skipped server gets one readable line: an engine error carries the child's stderr, stack frames included.
const firstLine = msg => String(msg).split('\n')[0].replace(/\s+at [^ ]+ \(.*$/, '').replace(/\s+at .*$/, '').trim().slice(0, 200);

const RULES_BLOCK = `${START}
## declick first
Before an MCP tool, WebFetch, a browser read, a screenshot or raw curl, use the declick adapter: \`declick list\` (what exists) → \`declick describe <name> --verb <verb>\` (under 500 tokens) → \`declick run <name> <verb> … --fields a,b --limit N\` (trimmed JSON, exit 0 ok). A page's links, buttons and inputs: \`declick web tree <url> --selector <css> --limit 20\`; whether a page says X: \`declick web text <url> --grep X\`. A window: \`declick desk tree <title> --interactive\`. A target with no adapter you will hit twice: \`declick add <spec|mcp:…|graphql:…|cli:…> --name <n>\`. Never edit ~/.declick by hand. Subagents have no MCP tools; they have declick. Undo all of this with \`declick setup --revert\`.
${END}`;

// Rule targets, only the ones whose client dir exists; CLAUDE.md is created if .claude exists but CLAUDE.md
// does not. Deduped by real path so a CLAUDE.md that symlinks to AGENTS.md gets one block, not two.
export function rulesTargets(clientHome) {
  const candidates = [
    existsSync(join(clientHome, '.claude')) ? join(clientHome, '.claude', 'CLAUDE.md') : null,
    existsSync(join(clientHome, '.codex')) ? join(clientHome, '.codex', 'AGENTS.md') : null,
    existsSync(join(clientHome, '.agents')) ? join(clientHome, '.agents', 'AGENTS.md') : null,
  ].filter(Boolean);
  const seenReal = new Set(); const out = [];
  for (const c of candidates) {
    // A symlink resolution failure (Windows without the privilege) falls back to the path itself, not a crash.
    let real; try { real = existsSync(c) ? realpathSync(c) : c; } catch { real = c; }
    if (seenReal.has(real)) continue;
    seenReal.add(real); out.push(c);
  }
  return out;
}

function upsertBlock(text) {
  if (text.includes(START)) {
    const s = text.indexOf(START); const e = text.indexOf(END) + END.length;
    const already = text.slice(s, e) === RULES_BLOCK;
    return { text: already ? text : text.slice(0, s) + RULES_BLOCK + text.slice(e), action: already ? 'unchanged' : 'replaced' };
  }
  if (!text.length) return { text: `${RULES_BLOCK}\n`, action: 'added' };
  const sep = text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${sep}${RULES_BLOCK}\n`, action: 'added' };
}

// A minimal TOML reader for exactly the shape codex's config.toml uses: [mcp_servers.<name>] tables with a
// quoted command string, a quoted-string args array and/or a quoted url. Nothing else in TOML is read.
export function parseCodexToml(path) {
  if (!existsSync(path)) return {};
  const servers = {}; let cur = null;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const section = /^\[mcp_servers\.([^\]]+)\]$/.exec(line);
    if (section) { cur = servers[section[1]] = servers[section[1]] || {}; continue; }
    if (/^\[/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, valRaw] = kv;
    if (key === 'command' || key === 'url') { const m = /^"((?:[^"\\]|\\.)*)"$/.exec(valRaw.trim()); if (m) cur[key] = m[1].replace(/\\"/g, '"'); }
    else if (key === 'args') { const arr = /^\[(.*)\]$/.exec(valRaw.trim()); if (arr) cur.args = [...arr[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1].replace(/\\"/g, '"')); }
  }
  return servers;
}

const sourceOfServer = cfg => (cfg.url ? `mcp:${cfg.url}` : cfg.command ? `mcp:${[cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ')}` : null);
const GENERIC = new Set(['server', 'default', 'mcp', 'main']);

function collectFromMcpServers(obj, out) {
  for (const [name, cfg] of Object.entries(obj || {})) {
    const source = sourceOfServer(cfg || {});
    if (!source || out.some(s => s.source === source)) continue;
    out.push({ serverName: name, source, adapterName: kebabName(name) });
  }
}

// Every optional source, each read only if it exists: .claude.json (top level and every projects[*] entry),
// cwd's .mcp.json, plugin caches (adapter name falls back to the plugin dir when the server name is generic),
// and codex's config.toml.
export function gatherMcpSources(clientHome, cwd) {
  const out = [];
  const claudeJson = readJson(join(clientHome, '.claude.json'));
  if (claudeJson) {
    collectFromMcpServers(claudeJson.mcpServers, out);
    for (const proj of Object.values(claudeJson.projects || {})) collectFromMcpServers(proj?.mcpServers, out);
  }
  collectFromMcpServers(readJson(join(cwd, '.mcp.json'))?.mcpServers, out);
  const cacheDir = join(clientHome, '.claude', 'plugins', 'cache');
  for (const a of safeDirs(cacheDir)) for (const b of safeDirs(join(cacheDir, a))) for (const c of safeDirs(join(cacheDir, a, b))) {
    const mcp = readJson(join(cacheDir, a, b, c, '.mcp.json'));
    for (const [name, cfg] of Object.entries(mcp?.mcpServers || {})) {
      const source = sourceOfServer(cfg || {});
      if (!source || out.some(s => s.source === source)) continue;
      const adapterName = GENERIC.has(kebabName(name)) ? kebabName(c) : kebabName(name);
      out.push({ serverName: name, source, adapterName });
    }
  }
  for (const [name, cfg] of Object.entries(parseCodexToml(join(clientHome, '.codex', 'config.toml')))) {
    const source = sourceOfServer(cfg);
    if (!source || out.some(s => s.source === source)) continue;
    out.push({ serverName: name, source, adapterName: kebabName(name) });
  }
  return out;
}

const findExistingBySource = source => listManifests().map(n => { try { return loadManifest(n); } catch { return null; } }).filter(Boolean).find(m => m.source === source);
// The source of whatever adapter already lives at `name`, or null: checked before every build() attempt so
// adoption never lets build() overwrite an adapter someone else built under that name (build()'s own
// collision check only looks at real PATH binaries, not at declick's own manifests).
const adapterSourceIfExists = name => { try { return existsSync(join(manifestDir(name), 'manifest.json')) ? loadManifest(name).source : null; } catch { return null; } };

// The -mcp fallback for a server whose plain name is unusable: refused up front if that name too already
// belongs to a different adapter (never let build() overwrite it), otherwise built, with the same AUTH
// wording a first attempt would get and the original "both collide" wording for anything else.
async function tryFallback(s, name, build, dry) {
  const alt = `${name}-mcp`;
  const altTaken = adapterSourceIfExists(alt);
  if (altTaken && altTaken !== s.source) return { skip: `name ${alt} is taken by an adapter built from ${altTaken}; declick add ${s.source} --name <other-name>` };
  try { await build(s.source, { name: alt }, dry); return { name: alt }; }
  catch (e) {
    if (e.exit === EXIT.AUTH) return { skip: `needs ${tokenKey(alt)} in the vault` };
    return { skip: `${name} and ${alt} both collide: ${firstLine(e.message)}` };
  }
}

// One build attempt per server, never fatal: exit 4 (bearer needed) and a name collision are named for what
// they are, everything else reports the error's first line. Renamed adapters (and already-adapted servers)
// still land in the returned mapping, so the hook can resolve a server to its adapter without guessing.
async function adoptServers(sources, build, { dry } = {}) {
  const built = [], skipped = [], mapping = {};
  for (const s of sources) {
    const existing = findExistingBySource(s.source);
    if (existing) { mapping[s.serverName] = existing.name; skipped.push({ server: s.serverName, why: 'already adapted' }); continue; }
    const name = s.adapterName;
    const nameTaken = adapterSourceIfExists(name);
    if (nameTaken && nameTaken !== s.source) {
      const r = await tryFallback(s, name, build, dry);
      if (r.name) { built.push(r.name); mapping[s.serverName] = r.name; } else skipped.push({ server: s.serverName, why: r.skip });
      continue;
    }
    try { await build(s.source, { name }, dry); built.push(name); mapping[s.serverName] = name; }
    catch (e) {
      if (e.exit === EXIT.AUTH) { skipped.push({ server: s.serverName, why: `needs ${tokenKey(name)} in the vault` }); continue; }
      if (e.exit === EXIT.ERROR && /already resolves to|was not written by declick/.test(e.message)) {
        const r = await tryFallback(s, name, build, dry);
        if (r.name) { built.push(r.name); mapping[s.serverName] = r.name; } else skipped.push({ server: s.serverName, why: r.skip });
        continue;
      }
      skipped.push({ server: s.serverName, why: firstLine(e.message) });
    }
  }
  return { built, skipped, mapping };
}

export async function runSetup({ flags = {}, build, cwd = process.cwd(), clientHome = clientHomeOf() } = {}) {
  const dry = !!flags.dryRun;
  const sources = flags.noAdopt ? [] : gatherMcpSources(clientHome, cwd);
  const ruleFiles = flags.noRules ? [] : rulesTargets(clientHome);
  const hookWanted = !flags.noHook && existsSync(join(clientHome, '.claude'));
  const settingsPath = join(clientHome, '.claude', 'settings.json');
  const touched = [...ruleFiles, ...(hookWanted ? [settingsPath] : [])];

  if (dry) {
    const pathPlan = flags.noPath ? { kind: null, added: false } : installPath({ dry: true });
    const { built: wouldBuild, skipped } = await adoptServers(sources, build, { dry: true });
    const lines = [
      flags.noPath ? 'path: skipped (--no-path)' : (pathPlan.kind ? `path: would edit ${pathPlan.kind === 'win-user' ? 'the user PATH' : pathPlan.file}` : 'path: already on PATH'),
      ...wouldBuild.map(n => `would build adapter ${n}`),
      ...skipped.map(s => `skip ${s.server}: ${s.why}`),
      ...ruleFiles.map(f => `would write rules block to ${f}`),
      ...(hookWanted ? [`would install hook at ${settingsPath}`] : []),
    ];
    return { ok: true, data: { wouldWrite: touched, wouldBuild, path: pathPlan, skipped }, text: lines.join('\n') || 'nothing to do' };
  }

  // 1. Snapshot before any other write: an exact byte copy of every file this run might touch.
  const at = new Date().toISOString();
  const snapDir = join(HOME, 'setup', at.replace(/:/g, '-'));
  const filesDir = join(snapDir, 'files');
  let manifestFiles;
  try {
    mkdirSync(filesDir, { recursive: true });
    manifestFiles = touched.map((p, i) => {
      const existed = existsSync(p);
      if (existed) copyFileSync(p, join(filesDir, String(i)));
      return { path: p, existed, before: existed ? sha256(readFileSync(p)) : null, after: null, copy: existed ? `files/${i}` : null };
    });
  } catch (e) { throw Object.assign(new Error(`could not write the setup snapshot: ${e.message}`), { exit: EXIT.ERROR }); }

  // 2. PATH, before adopting servers: writeLauncher() (called once per adapter below) checks onPath()
  // against process.env.PATH, which a registry or profile-file edit never touches for this same process --
  // without also extending process.env.PATH here, every adapter built below would print its own
  // "add to PATH once" hint even though installPath just handled it.
  const pathResult = flags.noPath ? { kind: null, file: null, line: null, added: false } : installPath({ dry: false });
  if (pathResult.added) process.env.PATH = `${process.env.PATH}${delimiter}${binDir()}`;

  // 3. Adopt MCP servers, then the map the hook reads.
  const adopters = flags.noAdopt ? { built: [], skipped: [], mapping: {} } : await adoptServers(sources, build, { dry: false });
  if (!flags.noAdopt) { mkdirSync(join(HOME, 'hooks'), { recursive: true }); writeFileSync(join(HOME, 'hooks', 'servers.json'), JSON.stringify(adopters.mapping, null, 2) + '\n'); }

  // 4. Rules block, idempotent and upgrade-safe.
  const rulesResult = ruleFiles.map(f => {
    const before = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const { text, action } = upsertBlock(before);
    if (action !== 'unchanged') { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
    return { file: f, action };
  });

  // 5. Hook: shipped file copied into ~/.declick/hooks, one PreToolUse entry merged into settings.json.
  // Shell tools are matched too: the hook counts whether the call after a nudge was a declick call (nudge-stats.json).
  const HOOK_MATCHER = 'mcp__.*|WebFetch|Bash|PowerShell';
  let hookResult = { file: null, settings: null, action: 'skipped' };
  if (hookWanted) {
    const hookFile = join(HOME, 'hooks', 'declick-nudge.cjs');
    mkdirSync(dirname(hookFile), { recursive: true });
    copyFileSync(join(HERE, 'hooks', 'declick-nudge.cjs'), hookFile);
    const raw = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}';
    let obj; try { obj = raw.trim() ? JSON.parse(raw) : {}; } catch { obj = null; }
    if (obj === null) hookResult = { file: hookFile, settings: settingsPath, action: 'skipped', reason: 'settings.json is not valid JSON; hook not installed' };
    else {
      const cmd = `node "${hookFile.replace(/\\/g, '/')}"`;
      const already = (obj.hooks?.PreToolUse || []).find(m => (m.hooks || []).some(h => String(h.command || '').includes('declick-nudge')));
      // An entry from an older setup matched MCP and WebFetch only; the hook now also watches the shell call after a nudge to count it.
      if (already && already.matcher !== HOOK_MATCHER) {
        already.matcher = HOOK_MATCHER;
        writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n');
        hookResult = { file: hookFile, settings: settingsPath, action: 'updated', matcher: HOOK_MATCHER };
      } else if (already) hookResult = { file: hookFile, settings: settingsPath, action: 'present' };
      else {
        const entry = { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: cmd, timeout: 5, statusMessage: 'declick adapter check...' }] };
        const merged = { ...obj, hooks: { ...(obj.hooks || {}), PreToolUse: [...(obj.hooks?.PreToolUse || []), entry] } };
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
        hookResult = { file: hookFile, settings: settingsPath, action: 'added' };
      }
    }
  }

  // 6. Finish: fill in the after shas, write the manifest only if something actually changed.
  for (const f of manifestFiles) f.after = existsSync(f.path) ? sha256(readFileSync(f.path)) : null;
  const changed = manifestFiles.some(f => f.before !== f.after) || adopters.built.length > 0 || pathResult.added === true || hookResult.action === 'added';
  let snapshot = null;
  if (changed) {
    const manifest = { version: 1, at, clientHome, files: manifestFiles, adapters: adopters.built, path: { ...pathResult, bin: binDir() } };
    writeFileSync(join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    copyFileSync(join(HERE, 'setup-revert-standalone.mjs'), join(snapDir, 'revert.mjs'));
    writeFileSync(join(HOME, 'setup', 'latest'), basename(snapDir));
    snapshot = snapDir;
  } else rmSync(snapDir, { recursive: true, force: true });

  const data = { snapshot, path: pathResult, adapters: { built: adopters.built, skipped: adopters.skipped }, rules: rulesResult, hook: hookResult };
  const lines = [
    snapshot ? `snapshot: ${snapshot}` : 'no changes since the last run; nothing snapshotted',
    flags.noPath ? 'path: skipped (--no-path)' : `path: ${pathResult.added ? 'installed' : 'already on PATH'}`,
    `${adopters.built.length} of ${sources.length} MCP servers adapted`,
    ...adopters.skipped.map(s => `skip ${s.server}: ${s.why}`),
    ...rulesResult.map(r => `rules ${r.file}: ${r.action}`),
    `hook: ${hookResult.action}${hookResult.reason ? ` (${hookResult.reason})` : ''}`,
  ];
  return { ok: true, data, text: lines.join('\n') };
}

export function runRevert({ flags = {}, removeAdapter } = {}) {
  const dry = !!flags.dryRun;
  const latestPath = join(HOME, 'setup', 'latest');
  if (!existsSync(latestPath)) throw Object.assign(new Error('nothing to revert; declick setup has not run'), { exit: EXIT.NOT_FOUND });
  const snapName = readFileSync(latestPath, 'utf8').trim();
  const snapDir = join(HOME, 'setup', snapName);
  const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
  const rows = restoreAll(manifest, snapDir, { dryRun: dry });
  const pathRow = undoPath(manifest.path, { dryRun: dry });
  const removed = [];
  if (!flags.keepAdapters) for (const name of manifest.adapters || []) {
    if (dry) { removed.push({ name, action: 'would remove' }); continue; }
    try { removeAdapter(name); removed.push({ name, action: 'removed' }); } catch (e) { removed.push({ name, action: `could not remove: ${e.message}` }); }
  }
  if (!dry) { rmSync(join(HOME, 'hooks'), { recursive: true, force: true }); rmSync(latestPath, { force: true }); }
  const restoredCount = rows.filter(r => r.action === 'restored' || r.action === 'deleted').length;
  const summary = `${restoredCount} of ${rows.length} files restored`;
  const data = { files: rows, path: pathRow, adapters: removed, summary };
  const lines = [...rows.map(r => `${r.action}\t${r.path}`), `path: ${pathRow.action}`, ...removed.map(r => `${r.action}\t${r.name}`), summary];
  return { ok: true, data, text: lines.join('\n') };
}

export function runUninstall({ flags = {}, removeAdapter } = {}) {
  const hasSnapshot = existsSync(join(HOME, 'setup', 'latest'));
  if (flags.dryRun) {
    const data = { wouldRemove: HOME, revert: hasSnapshot ? 'declick setup --revert would run first' : 'no snapshot to revert' };
    return { ok: true, data, text: `would delete ${HOME}${hasSnapshot ? ' (after reverting setup)' : ''}` };
  }
  if (!flags.yes) throw Object.assign(new Error(`pass --yes to delete ${HOME} (adapters, recipes, audit log, snapshots)`), { exit: EXIT.ERROR });
  const revert = hasSnapshot ? runRevert({ flags: { keepAdapters: flags.keepAdapters }, removeAdapter }) : null;
  rmSync(HOME, { recursive: true, force: true });
  const data = { removed: HOME, revert: revert?.data ?? null, next: 'npm rm -g declick' };
  return { ok: true, data, text: `removed ${HOME}\nnpm rm -g declick` };
}

// declick doctor's integration section: what setup has done, and what an agent client still lacks.
export function integrationStatus(clientHome = clientHomeOf(), cwd = process.cwd()) {
  const latestPath = join(HOME, 'setup', 'latest');
  let at = null;
  if (existsSync(latestPath)) { try { at = JSON.parse(readFileSync(join(HOME, 'setup', readFileSync(latestPath, 'utf8').trim(), 'manifest.json'), 'utf8')).at; } catch { at = null; } }
  const hookInstalled = () => { const s = readJson(join(clientHome, '.claude', 'settings.json')); return (s?.hooks?.PreToolUse || []).some(m => (m.hooks || []).some(h => String(h.command || '').includes('declick-nudge'))); };
  const hasBlock = f => existsSync(f) && readFileSync(f, 'utf8').includes(START);
  const clients = [
    { client: 'claude', dir: join(clientHome, '.claude'), rulesFile: join(clientHome, '.claude', 'CLAUDE.md') },
    { client: 'codex', dir: join(clientHome, '.codex'), rulesFile: join(clientHome, '.codex', 'AGENTS.md') },
    { client: 'agents', dir: join(clientHome, '.agents'), rulesFile: join(clientHome, '.agents', 'AGENTS.md') },
  ].map(c => ({ client: c.client, rulesFile: c.rulesFile, rules: hasBlock(c.rulesFile), hook: c.client === 'claude' ? (existsSync(c.dir) ? hookInstalled() : 'n/a') : 'n/a' }));
  const sources = gatherMcpSources(clientHome, cwd);
  const mapping = readJson(join(HOME, 'hooks', 'servers.json')) || {};
  // Adapted means setup mapped it or an adapter with that exact source exists, however it was built.
  const unadapted = sources.filter(s => !(s.serverName in mapping) && !findExistingBySource(s.source)).map(s => s.serverName);
  // What the hook counted: nudges fired, and whether the next call was a declick call. A follow rate that stays low says the nudge is wrong, not the model.
  const ns = readJson(join(HOME, 'hooks', 'nudge-stats.json'));
  const nudge = ns ? { fired: ns.fired || 0, followed: ns.followed || 0, ignored: ns.ignored || 0, followRate: ns.fired ? Math.round(100 * (ns.followed || 0) / ns.fired) / 100 : null, since: ns.since || null, keys: ns.keys || {} } : { fired: 0, followed: 0, ignored: 0, followRate: null, since: null, keys: {} };
  return { setup: at, revertAvailable: existsSync(latestPath), clients, mcp: { total: sources.length, adapted: sources.length - unadapted.length, unadapted }, nudge };
}
