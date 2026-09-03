#!/usr/bin/env node
'use strict';
// declick-nudge.cjs — PreToolUse [mcp__.*|WebFetch]. Advisory, never blocks.
//
// The failure it watches: a raw MCP result, a WebFetch of a whole page, or a Chrome DOM read lands in
// context in full and every later turn re-reads it, while a declick adapter that answers the same question
// as trimmed JSON (--fields a,b --limit N) already sits in ~/.declick. `declick setup` installs this hook
// and writes ~/.declick/hooks/servers.json (server name -> adapter name, including renames); this file reads
// that map instead of guessing. One nudge per adapter per session, then silence.
//
// Env: DECLICK_HOME overrides ~/.declick. DECLICK_NUDGE_OFF=1 disables. Never throws past main(): a bad
// payload, a missing map or a write failure all exit 0 silently, the same as "nothing to say".
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.DECLICK_HOME || path.join(os.homedir(), '.declick');
const STATE_DIR = path.join(os.tmpdir(), 'declick-nudge');
const STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Chrome tools that read a page: the element tree replaces them. A click or a form fill stays untouched.
const CHROME_READERS = new Set(['computer', 'read_page', 'get_page_text', 'find', 'navigate']);

function serversMap() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'hooks', 'servers.json'), 'utf8')); } catch { return {}; }
}
// The map first (it also carries renames like foo -> foo-mcp); the server name itself only when its own
// adapter directory exists, so an unmapped server with no adapter stays silent instead of guessing.
function adapterFor(server) {
  const mapped = serversMap()[server];
  if (mapped) return mapped;
  try { return fs.statSync(path.join(HOME, server, 'manifest.json')).isFile() ? server : null; } catch { return null; }
}

function statePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return path.join(STATE_DIR, `${safe}.json`);
}
function seen(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Date.now() - (raw.at || 0) > STATE_MAX_AGE_MS ? {} : raw.keys || {};
  } catch { return {}; }
}
function remember(file, keys) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ keys, at: Date.now() }), 'utf8'); } catch { /* best effort */ }
}

// Returns { key, text } or null when there is nothing cheaper to point at.
function advise(tool, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  if (m) {
    const [, server, mcpTool] = m;
    if (server === 'claude-in-chrome') {
      if (!CHROME_READERS.has(mcpTool)) return null;
      return {
        key: 'web',
        text: 'declick first: a page is a tree, not a screenshot or DOM dump. '
          + '`declick web tree <url> --selector <css> --limit 20` returns its links, buttons and inputs as JSON, '
          + 'and `curl -s <url> | grep -c <text>` answers "does the page say X", both at a fraction of a '
          + 'read_page/computer result. Use the Chrome tools only for a click, a form, or a visual question.',
      };
    }
    const adapter = adapterFor(server);
    if (!adapter) return null;
    const verb = mcpTool.replace(/_/g, '-');
    return {
      key: adapter,
      text: `declick first: the \`${server}\` MCP server has a declick adapter (\`${adapter}\`). `
        + `\`declick run ${adapter} ${verb} --help\` shows the flags and `
        + `\`declick run ${adapter} ${verb} <args> --fields a,b --limit N\` returns trimmed JSON instead of the `
        + `full MCP payload; \`declick describe ${adapter} --grep ${verb.split('-')[0]}\` lists the verbs. `
        + 'It works from every subagent, MCP does not.',
    };
  }
  if (tool === 'WebFetch') {
    const url = (input && input.url) || '<url>';
    return {
      key: 'web',
      text: 'declick first: for an HTML page, `declick web tree '
        + `${url} --selector <css> --limit 20\` returns its links, buttons and inputs as JSON and `
        + `\`curl -s ${url} | grep -c <text>\` answers "does the page say X", instead of the whole page through `
        + 'WebFetch. Keep WebFetch for a JSON or text endpoint, or when you need prose summarised.',
    };
  }
  return null;
}

function main() {
  if (process.env.DECLICK_NUDGE_OFF === '1') process.exit(0);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  let hit;
  try { hit = advise(payload.tool_name, payload.tool_input); } catch { process.exit(0); }
  if (!hit) process.exit(0);
  const file = statePath(payload.session_id);
  const keys = seen(file);
  if (keys[hit.key]) process.exit(0);
  keys[hit.key] = 1;
  remember(file, keys);
  try { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hit.text } })); } catch { /* stdout gone is not fatal */ }
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
