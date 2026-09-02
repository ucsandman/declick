import { validateManifest } from './manifest.mjs';
import { describe } from './describe.mjs';
import { RESERVED } from './output.mjs';
import { validateStoredRecipe } from './recipes.mjs';

const RESERVED_VERBS = ['describe'];

export function lint(m) {
  const errs = validateManifest(m);
  // Report contract errors alongside validation errors, not instead of them: the secret
  // scanner fires on any long unbroken string, so an early return can hide a real
  // contract failure. Bail out only when the manifest is too broken to describe.
  if (!Array.isArray(m?.verbs) || m.verbs.length === 0 || m.verbs.some(v => !Array.isArray(v?.args))) return errs;
  const d = describe(m);
  if (d.length >= 2000) errs.push(`describe is ${d.length} chars; limit 2000 (about 500 tokens); narrow with: declick add <source> --verbs a,b or --tag t`);
  if (m.engine === 'openapi' && !/^https?:\/\/[^{]+$/.test(m.baseUrl || '')) errs.push(`baseUrl ${JSON.stringify(m.baseUrl)} must be an absolute http(s) url with no {variables}`);
  const seen = new Set();
  for (const v of m.verbs) {
    if (seen.has(v.name)) errs.push(`duplicate verb ${v.name}`); seen.add(v.name);
    if (RESERVED_VERBS.includes(v.name)) errs.push(`${v.name} is a reserved verb name`);
    if ((v.description || '').length > 80) errs.push(`${v.name}: description over 80 chars`);
    for (const a of v.args || []) if (RESERVED.includes(a.name)) errs.push(`${v.name}: arg ${a.name} is reserved`);
    for (const f of v.flags || []) if (RESERVED.includes(f.name)) errs.push(`${v.name}: flag --${f.name} collides with a contract flag`);
    if (v.http?.path) for (const [, p] of v.http.path.matchAll(/\{([^}]+)\}/g)) if (!(v.args || []).some(a => a.name === p)) errs.push(`${v.name}: path parameter {${p}} has no arg`);
    if (v.recipe) for (const e of validateStoredRecipe({ ...v.recipe, args: v.args })) errs.push(`${v.name}: ${e}`);
  }
  return errs;
}
