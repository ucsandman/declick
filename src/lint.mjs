import { validateManifest } from './manifest.mjs';
import { describe } from './describe.mjs';
import { RESERVED } from './output.mjs';
import { validateStoredRecipe } from './recipes.mjs';
import { validateWebRecipe } from './engines/web.mjs';
import { derivedMutating } from './guard.mjs';

// Engines that send an http request built from baseUrl: the request path is shared, so is the rule.
const REQUEST = ['openapi', 'postman', 'har'];

const RESERVED_VERBS = ['describe'];

export function lint(m) {
  const errs = validateManifest(m);
  // Report contract errors alongside validation errors, not instead of them: the secret
  // scanner fires on any long unbroken string, so an early return can hide a real
  // contract failure. Bail out only when the manifest is too broken to describe.
  if (!Array.isArray(m?.verbs) || m.verbs.length === 0 || m.verbs.some(v => !Array.isArray(v?.args))) return errs;
  const d = describe(m);
  if (d.length >= 2000) errs.push(`describe is ${d.length} chars; limit 2000 (about 500 tokens); narrow with: declick add <source> --verbs a,b or --tag t`);
  if (REQUEST.includes(m.engine) && !/^https?:\/\/[^{]+$/.test(m.baseUrl || '')) errs.push(`baseUrl ${JSON.stringify(m.baseUrl)} must be an absolute http(s) url with no {variables}`);
  // A graphql adapter built from a schema file has no endpoint on purpose and says so at run time; a set one still has to be a url.
  if (m.engine === 'graphql' && m.baseUrl && !/^https?:\/\/[^{]+$/.test(m.baseUrl)) errs.push(`baseUrl ${JSON.stringify(m.baseUrl)} must be an absolute http(s) url with no {variables}`);
  const seen = new Set();
  for (const v of m.verbs) {
    if (seen.has(v.name)) errs.push(`duplicate verb ${v.name}`); seen.add(v.name);
    if (RESERVED_VERBS.includes(v.name)) errs.push(`${v.name} is a reserved verb name`);
    if ((v.description || '').length > 80) errs.push(`${v.name}: description over 80 chars`);
    // mutating is derived from the request method or the recipe steps: a manifest may raise it, never lower it.
    if (v.mutating === false && derivedMutating(m, v) === true) errs.push(`${v.name}: mutating false, but ${v.http?.method ? `${String(v.http.method).toUpperCase()} changes state` : 'its steps change state'}; remove the field or set it true`);
    for (const a of v.args || []) if (RESERVED.includes(a.name)) errs.push(`${v.name}: arg ${a.name} is reserved`);
    for (const f of v.flags || []) if (RESERVED.includes(f.name)) errs.push(`${v.name}: flag --${f.name} collides with a contract flag`);
    if (v.http?.path) for (const [, p] of v.http.path.matchAll(/\{([^}]+)\}/g)) if (!(v.args || []).some(a => a.name === p)) errs.push(`${v.name}: path parameter {${p}} has no arg`);
    // Both engines store steps under recipe, but a browser recipe and a UI Automation recipe are different languages.
    if (v.recipe) for (const e of (m.engine === 'web' ? validateWebRecipe : validateStoredRecipe)({ ...v.recipe, args: v.args })) errs.push(`${v.name}: ${e}`);
    if (m.engine === 'cli' && !v.cli?.argv?.length) errs.push(`${v.name}: cli.argv is missing; rebuild with declick build ${m.name}`);
    if (m.engine === 'sqlite' && !v.sqlite) errs.push(`${v.name}: sqlite table info is missing; rebuild with declick build ${m.name}`);
  }
  return errs;
}
