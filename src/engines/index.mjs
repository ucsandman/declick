import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as openapi from './openapi.mjs';
import * as desktop from './desktop.mjs';
import * as mcp from './mcp.mjs';
import * as web from './web.mjs';
import * as graphql from './graphql.mjs';
import * as postman from './postman.mjs';
import * as har from './har.mjs';
import * as sqlite from './sqlite.mjs';
import * as cli from './cli.mjs';
import * as compose from './compose.mjs';
import { findChrome } from '../cdp.mjs';
import { parseYaml } from '../yaml.mjs';

export const engines = { openapi, desktop, mcp, web, graphql, postman, har, sqlite, cli, compose };

// ready is what this machine can compile today, so declick engines and declick doctor never promise a
// tool that is not here. Every source string below is runnable as written.
export const ENGINE_INFO = [
  { name: 'openapi', ready: true, source: 'spec.json | spec.yaml | https://.../openapi.json', note: 'openapi 3 and swagger 2, json or yaml; a url spec is fetched once at compile time' },
  { name: 'desktop', ready: process.platform === 'win32', source: 'app:<window title>', note: process.platform === 'win32' ? 'needs deskclaw; declick doctor checks it' : 'Windows only (deskclaw UI Automation); not available on this platform' },
  { name: 'mcp', ready: true, source: 'mcp:<command args> | mcp:https://host/mcp', note: 'stdio servers spawn the command; http servers take a bearer from <NAME>_TOKEN' },
  { name: 'web', ready: !!findChrome(), source: 'web:https://<site> --recipes <dir>', note: 'needs Chrome or Edge; one recipe json per verb, and errors carry candidates instead of screenshots' },
  { name: 'graphql', ready: true, source: 'graphql:https://.../graphql | schema.json | schema.graphql', note: 'introspects the endpoint; bearer from <NAME>_TOKEN when it answers 401' },
  { name: 'postman', ready: true, source: 'collection.json | insomnia.json', note: 'postman v2.1 collections and insomnia v4 exports; recorded secrets become env keys' },
  { name: 'har', ready: true, source: 'capture.har', note: 'browser network capture; --host picks the API host when the capture has several' },
  { name: 'sqlite', ready: true, source: 'sqlite:<path> | data.db', note: 'introspects tables and views into list, get, insert, update, delete and a parameterized query' },
  { name: 'cli', ready: true, source: 'cli:<binary> [fixed args]', note: 'compiled from the tool own --help; the binary must be on PATH' },
  { name: 'compose', ready: true, source: 'compose:<chain.json>', note: 'chains verbs from adapters already built into one verb; every step still runs as its own guarded, audited command' },
];

const PREFIX = [['app:', 'desktop'], ['mcp:', 'mcp'], ['web:', 'web'], ['graphql:', 'graphql'], ['sqlite:', 'sqlite'], ['cli:', 'cli'], ['compose:', 'compose']];
const FORMS = 'spec.json | spec.yaml | https://... | app:<window title> | mcp:<command args> | web:<url> | graphql:<url> | sqlite:<path> | cli:<binary> | collection.json | capture.har | schema.graphql | compose:<chain.json>';
const fail = msg => Object.assign(new Error(msg), { exit: 1 });

// The marker that says what a document really is sits in its first bytes, and a capture can be tens of
// megabytes, so a source is routed from its head and never parsed whole to be routed.
const CONTENT = [
  // A chain says so in its first object; no other format declares a compose key, so this is read first.
  [/^\s*\{[\s\S]{0,400}"compose"\s*:\s*true/, 'compose'],
  [/"(openapi|swagger)"\s*:\s*"|^\s*(openapi|swagger)\s*:\s*["']?\d/m, 'openapi'],
  [/schema\.getpostman\.com|"_postman_id"|"_type"\s*:\s*"(export|request|workspace)"/, 'postman'],
  [/"log"\s*:\s*\{[\s\S]{0,400}"entries"\s*:/, 'har'],
  [/"__schema"\s*:/, 'graphql'],
  // A big spec (Stripe, Twilio, Slack) can serialize components/paths/definitions before its own openapi/swagger
  // key ever shows inside the head window; its first key still says what it is.
  [/^\s*\{\s*"(components|paths|definitions|info)"\s*:/, 'openapi'],
];
const sniff = text => CONTENT.find(([re]) => re.test(text))?.[1] || null;

function head(path, bytes = 65536) {
  try {
    if (!statSync(path).isFile()) return '';
    const fd = openSync(path, 'r'); const buf = Buffer.alloc(bytes);
    try { return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('utf8'); } finally { closeSync(fd); }
  } catch { return ''; }
}

// What a url looks like, used when it cannot be read at all: an offline machine still routes a spec.
const shapeOf = url => (/openapi|swagger|api-docs|\.ya?ml($|\?)|\.json($|\?)/i.test(url) ? 'openapi' : /graphql|\/gql(\/|$|\?)/i.test(url) ? 'graphql' : 'web');

const get = (url, init) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), ...init });

// One ranged GET of the first 64KB, then the smallest legal graphql query there is: every graphql server
// answers {__typename} and nothing else does, so no site is misrouted and no probe changes anything.
export async function probe(url) {
  let text = '', r;
  try {
    r = await get(url, { headers: { range: 'bytes=0-65535', accept: 'application/json, application/yaml, text/plain, */*' } });
    text = (await r.text()).slice(0, 65536);
  } catch { return shapeOf(url); }
  const byContent = sniff(text);
  if (byContent) return byContent;
  // The head window missed every marker, but the url itself already says spec (.json, .yaml, openapi, swagger,
  // api-docs) and is not graphql: trust that shape over a guess from a truncated body, and let the openapi
  // engine's own loader give the real error if the shape turns out wrong. A non-2xx or an html body under a
  // spec-shaped url is never a spec either, so that fails add outright instead of falling through to web.
  if (shapeOf(url) === 'openapi') {
    if (!r.ok) throw fail(`GET ${url} -> ${r.status}`);
    if (/text\/html/i.test(r.headers.get('content-type') || '')) throw fail('not a spec: got text/html');
    return 'openapi';
  }
  try {
    const r2 = await get(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{__typename}"}' });
    const j = await r2.json();
    if (typeof j?.data?.__typename === 'string') return 'graphql';
  } catch { /* not a graphql endpoint */ }
  const doc = docOf(text);
  return doc?.openapi || doc?.swagger ? 'openapi' : 'web';
}

function docOf(text) {
  try { return JSON.parse(text); } catch { /* not json */ }
  try { const y = parseYaml(text); return y && typeof y === 'object' ? y : null; } catch { return null; }
}

const SELF = fileURLToPath(import.meta.url);
// pickEngine has synchronous callers all the way up to declick add, so the request runs in a child of
// this same file: node src/engines/index.mjs --probe <url> prints one engine name and exits.
function probeUrl(url) {
  const r = spawnSync(process.execPath, [SELF, '--probe', url], { encoding: 'utf8', timeout: 20000 });
  const out = String(r.stdout || '').trim();
  if (out.startsWith('ERROR:')) throw fail(out.slice(6));
  return engines[out] ? out : shapeOf(url);
}

export function pickEngine(source, override) {
  if (override) { if (!engines[override]) throw fail(`unknown engine ${override}; one of ${Object.keys(engines).join(', ')}`); return override; }
  if (typeof source !== 'string' || !source) throw fail(`usage: declick add <source>   source: ${FORMS}`);
  for (const [p, e] of PREFIX) if (source.startsWith(p)) return e;
  if (/\.(db|sqlite|sqlite3)($|\?)/i.test(source)) return 'sqlite';
  if (/\.har($|\?)/i.test(source)) return 'har';
  if (/\.(graphql|gql)($|\?)/i.test(source)) return 'graphql';
  if (/^https?:\/\//.test(source)) return probeUrl(source);
  if (/\.ya?ml($|\?)/i.test(source)) return 'openapi';
  if (/\.json($|\?)/i.test(source)) return sniff(head(source)) || 'openapi';
  throw fail(`cannot tell what ${source} is; source: ${FORMS}, or force one with --engine ${Object.keys(engines).join('|')}`);
}

if (process.argv[2] === '--probe' && resolve(process.argv[1] || '') === SELF) {
  probe(process.argv[3] || '').then(e => process.stdout.write(e), err => { process.stdout.write(`ERROR:${err.message}`); process.exitCode = 1; });
}
