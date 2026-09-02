import * as openapi from './openapi.mjs';
import * as desktop from './desktop.mjs';

const notYet = (what, hint) => ({
  compile: async () => { throw Object.assign(new Error(`${what} engine arrives in phase 4. ${hint}`), { exit: 4 }); },
  execute: async () => ({ ok: false, exit: 4, error: `${what} engine arrives in phase 4. ${hint}` }),
});

export const engines = {
  openapi, desktop,
  mcp: notYet('mcp', 'install: npm i -g mcporter'),
  web: notYet('web', 'install: npm i -g opencli'),
};

export function pickEngine(source) {
  if (source.startsWith('app:')) return 'desktop';
  if (source.startsWith('mcp:')) return 'mcp';
  if (/^https?:\/\//.test(source)) return /openapi|swagger|\.json$|\.ya?ml$/i.test(source) ? 'openapi' : 'web';
  if (/\.(json|ya?ml)$/i.test(source)) return 'openapi';
  throw Object.assign(new Error(`cannot tell what ${source} is; use app:, mcp:, a URL, or a spec file`), { exit: 1 });
}
