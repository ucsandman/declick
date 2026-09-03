import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(process.cwd(), 'src', 'hooks', 'declick-nudge.cjs');
const HOME = mkdtempSync(join(tmpdir(), 'declick-nudge-'));
for (const a of ['xapi', 'dashclaw-mcp', 'c7']) { mkdirSync(join(HOME, a)); writeFileSync(join(HOME, a, 'manifest.json'), '{}'); }
mkdirSync(join(HOME, 'hooks'));
writeFileSync(join(HOME, 'hooks', 'servers.json'), JSON.stringify({ 'dashclaw-local': 'dashclaw-mcp', 'plugin_context7_context7': 'c7' }));

let seq = 0;
const session = () => `probe-${Date.now()}-${seq++}`;
function call(sessionId, tool, input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: sessionId, tool_name: tool, tool_input: input }), encoding: 'utf8', env: { ...process.env, DECLICK_HOME: HOME, ...env } });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  if (!out) return null;
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch { return out; }
}

test('an MCP tool with an adapter names the adapter and the dashed verb, once per session', () => {
  const s = session();
  const a = call(s, 'mcp__xapi__search_news', { query: 'x' });
  assert.match(a, /declick run xapi search-news/);
  assert.equal(call(s, 'mcp__xapi__get_users_me', {}), null, 'second call in the same session is silent');
});

test('servers.json renames resolve a server name to its (possibly renamed) adapter', () => {
  assert.match(call(session(), 'mcp__dashclaw-local__dashclaw_guard', {}), /declick run dashclaw-mcp dashclaw-guard/);
  assert.match(call(session(), 'mcp__plugin_context7_context7__resolve-library-id', {}), /declick run c7 resolve-library-id/);
});

test('a server with no adapter and no servers.json entry stays silent', () => {
  assert.equal(call(session(), 'mcp__sidetap__tap', {}), null);
});

test('WebFetch carries the url; a chrome reader gets the web-tree nudge; a chrome click does not', () => {
  assert.match(call(session(), 'WebFetch', { url: 'https://example.com/x' }), /declick web tree https:\/\/example\.com\/x --selector/);
  assert.match(call(session(), 'mcp__claude-in-chrome__read_page', {}), /declick web tree/);
  assert.equal(call(session(), 'mcp__claude-in-chrome__form_input', {}), null);
  const s = session();
  call(s, 'WebFetch', { url: 'https://a.test' });
  assert.equal(call(s, 'mcp__claude-in-chrome__read_page', {}), null, 'the web key is shared across WebFetch and a chrome reader');
});

test('DECLICK_NUDGE_OFF silences every nudge', () => {
  assert.equal(call(session(), 'mcp__xapi__search_news', {}, { DECLICK_NUDGE_OFF: '1' }), null);
});

test('a bad payload exits 0 with no output', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
});

test('cleanup', () => { rmSync(HOME, { recursive: true, force: true }); });
