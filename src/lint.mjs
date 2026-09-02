import { validateManifest } from './manifest.mjs';
import { describe } from './describe.mjs';

export function lint(m) {
  const errs = validateManifest(m);
  // Report contract errors alongside validation errors, not instead of them: the secret
  // scanner fires on any long unbroken string, so an early return can hide a real
  // contract failure. Bail out only when the manifest is too broken to describe.
  if (!Array.isArray(m?.verbs) || m.verbs.length === 0 || m.verbs.some(v => !Array.isArray(v?.args))) return errs;
  const d = describe(m);
  if (d.length >= 2000) errs.push(`describe is ${d.length} chars; limit 2000 (about 500 tokens)`);
  const seen = new Set();
  for (const v of m.verbs) {
    if (seen.has(v.name)) errs.push(`duplicate verb ${v.name}`); seen.add(v.name);
    if ((v.description || '').length > 80) errs.push(`${v.name}: description over 80 chars`);
    if ((v.args || []).some(a => a.name === 'dry-run')) errs.push(`${v.name}: dry-run is reserved`);
  }
  return errs;
}
