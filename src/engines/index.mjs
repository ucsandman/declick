import * as openapi from './openapi.mjs';
import * as desktop from './desktop.mjs';

const notYet = (what, hint) => {
  const error = `${what} engine lands in declick 0.2; today: ${hint}`;
  return { compile: async () => { throw Object.assign(new Error(error), { exit: 1 }); }, execute: async () => ({ ok: false, exit: 1, error }) };
};

export const engines = {
  openapi, desktop,
  mcp: notYet('mcp', 'npm i -g mcporter'),
  web: notYet('web', 'npm i -g opencli'),
};

export const ENGINE_INFO = [
  { name: 'openapi', ready: true, source: 'spec.json | https://.../openapi.json', note: 'YAML specs: convert first with npx js-yaml spec.yaml > spec.json' },
  { name: 'desktop', ready: process.platform === 'win32', source: 'app:<window title>', note: 'needs deskclaw; declick doctor checks it' },
  { name: 'mcp', ready: false, source: 'mcp:<server>', note: 'lands in 0.2 (mcporter)' },
  { name: 'web', ready: false, source: 'https://<site>', note: 'lands in 0.2 (opencli)' },
];

export function pickEngine(source, override) {
  if (override) { if (!engines[override]) throw Object.assign(new Error(`unknown engine ${override}; one of ${Object.keys(engines).join(', ')}`), { exit: 1 }); return override; }
  if (typeof source !== 'string' || !source) throw Object.assign(new Error('usage: declick add <source>   source: spec.json | https://... | app:<window title> | mcp:<server>'), { exit: 1 });
  if (source.startsWith('app:')) return 'desktop';
  if (source.startsWith('mcp:')) return 'mcp';
  if (/\.ya?ml($|\?)/i.test(source)) throw Object.assign(new Error('YAML specs are not supported yet; convert with: npx js-yaml spec.yaml > spec.json'), { exit: 1 });
  if (/^https?:\/\//.test(source)) return /openapi|swagger|\.json$/i.test(source) ? 'openapi' : 'web';
  if (/\.json$/i.test(source)) return 'openapi';
  throw Object.assign(new Error(`cannot tell what ${source} is; use app:, mcp:, a URL, a spec file, or --engine openapi|desktop`), { exit: 1 });
}
