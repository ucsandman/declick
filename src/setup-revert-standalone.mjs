#!/usr/bin/env node
// Copied byte-for-byte into every setup snapshot as revert.mjs, so `node ~/.declick/setup/<ts>/revert.mjs`
// still works after `npm rm -g declick`: node builtins only, nothing imported from the package. setup.mjs's
// own --revert imports the restore functions straight from here, so there is exactly one implementation of
// "undo a setup" whether it runs through the package or stands alone in the snapshot.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
export const START = '<!-- declick:start -->';
export const END = '<!-- declick:end -->';

// Strip only the marker block from a rules file, keeping every other line and edit the user made.
export function stripBlock(text) {
  const s = text.indexOf(START); const e = text.indexOf(END);
  if (s === -1 || e === -1) return text;
  const before = text.slice(0, s).replace(/\n*$/, '\n');
  const after = text.slice(e + END.length).replace(/^\n+/, '');
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

// Strip only the hook entry whose command names declick-nudge from settings.json; every other key stays.
export function stripHookEntry(obj) {
  if (!obj?.hooks?.PreToolUse) return obj;
  const arr = obj.hooks.PreToolUse.map(m => ({ ...m, hooks: (m.hooks || []).filter(h => !String(h.command || '').includes('declick-nudge')) })).filter(m => (m.hooks || []).length);
  const out = { ...obj, hooks: { ...obj.hooks } };
  if (arr.length) out.hooks.PreToolUse = arr; else delete out.hooks.PreToolUse;
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// Undo exactly the PATH edit the manifest recorded: the ;<bin> segment on Windows, the recorded line elsewhere.
export function undoPath(pathInfo, { dryRun = false } = {}) {
  if (!pathInfo || !pathInfo.kind || !pathInfo.added) return { action: 'n/a' };
  if (pathInfo.kind === 'win-user') {
    if (dryRun) return { action: 'would remove from user PATH' };
    const bin = pathInfo.bin;
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$p=[Environment]::GetEnvironmentVariable('PATH','User'); $parts=$p -split ';' | Where-Object { $_ -ne ${JSON.stringify(bin)} }; [Environment]::SetEnvironmentVariable('PATH', ($parts -join ';'), 'User')`],
      { encoding: 'utf8' });
    return { action: r.status === 0 ? 'removed from user PATH' : `could not update PATH: ${(r.stderr || '').trim()}` };
  }
  if (!pathInfo.file || !existsSync(pathInfo.file)) return { action: 'already gone' };
  if (dryRun) return { action: 'would remove profile line' };
  const text = readFileSync(pathInfo.file, 'utf8');
  const stripped = text.split('\n').filter(l => l !== pathInfo.line).join('\n');
  writeFileSync(pathInfo.file, stripped);
  return { action: 'removed profile line' };
}

// One file's restore per the revert rule: unedited since setup -> byte-exact restore or delete; edited -> keep
// the user's edit and strip only the piece setup added.
export function restoreFile(entry, snapshotDir, { dryRun = false } = {}) {
  const { path: p, existed, after, copy } = entry;
  if (!existsSync(p)) return { path: p, action: 'already gone' };
  const cur = sha256(readFileSync(p));
  if (cur === after) {
    if (dryRun) return { path: p, action: existed ? 'would restore' : 'would delete' };
    if (!existed) { unlinkSync(p); return { path: p, action: 'deleted' }; }
    writeFileSync(p, readFileSync(join(snapshotDir, copy)));
    return { path: p, action: 'restored' };
  }
  const text = readFileSync(p, 'utf8');
  if (basename(p) === 'settings.json') {
    let obj; try { obj = JSON.parse(text); } catch { return { path: p, action: 'not JSON; left untouched' }; }
    if (dryRun) return { path: p, action: 'hook entry removed, later edits kept' };
    writeFileSync(p, JSON.stringify(stripHookEntry(obj), null, 2) + '\n');
    return { path: p, action: 'hook entry removed, later edits kept' };
  }
  if (dryRun) return { path: p, action: 'block removed, later edits kept' };
  writeFileSync(p, stripBlock(text));
  return { path: p, action: 'block removed, later edits kept' };
}

export function restoreAll(manifest, snapshotDir, { dryRun = false } = {}) {
  return (manifest.files || []).map(f => restoreFile(f, snapshotDir, { dryRun }));
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  const dryRun = process.argv.includes('--dry-run');
  const rows = restoreAll(manifest, here, { dryRun });
  const pathRow = undoPath(manifest.path, { dryRun });
  for (const r of rows) console.log(`${r.action.padEnd(32)} ${r.path}`);
  console.log(`path: ${pathRow.action}`);
  const restored = rows.filter(r => r.action === 'restored' || r.action === 'deleted').length;
  console.log(`${restored} of ${rows.length} files restored`);
  // Adapters are the package's job: this standalone script only names what to run once it is reinstalled.
  for (const a of manifest.adapters || []) console.log(`declick remove ${a}`);
}

// Runs when invoked directly (node revert.mjs); importing the functions above never triggers this.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
