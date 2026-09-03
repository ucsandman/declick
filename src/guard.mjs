// One governance gate for every real mutating action: bin/run.mjs, src/ui.mjs and the authoring replay call it.
// Env: DASHCLAW_API_KEY (off when unset), DASHCLAW_URL (required once the key is set, https unless loopback),
// DASHCLAW_TIMEOUT_MS (3000), DECLICK_GUARD=open turns a guard failure back into a warning.
const RISK = { delete: 70, put: 55, patch: 55, post: 45, desktop: 60 };
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|::1)$/;
// Mirrors the scanner in manifest.mjs: an argument that looks like a credential never reaches the guard log.
const SECRETISH = /\b(sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|^[A-Za-z0-9]{32,}$/;

export function riskScore({ engine, method }) { return RISK[engine === 'desktop' ? 'desktop' : String(method || '').toLowerCase()] ?? 40; }

// Strict is the default once a key is set: a governance endpoint that cannot answer stops the action.
export const isStrict = () => process.env.DECLICK_GUARD === 'strict' || (!!process.env.DASHCLAW_API_KEY && process.env.DECLICK_GUARD !== 'open');

// No hardcoded endpoint: a key pointed at nowhere is a configuration error, not a silent pass.
export function guardUrl() {
  const raw = process.env.DASHCLAW_URL;
  if (!raw) return { error: 'DASHCLAW_URL is not set; set it beside DASHCLAW_API_KEY or unset the key' };
  let u; try { u = new URL(String(raw)); } catch { return { error: `DASHCLAW_URL ${raw} is not a url` }; }
  if (u.protocol !== 'https:' && !LOOPBACK.test(u.hostname)) return { error: `DASHCLAW_URL ${u.origin} must be https unless the host is loopback` };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

const one = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  if (SECRETISH.test(s)) return '<redacted>';
  return s.length > 64 ? `${s.slice(0, 64)}...` : s;
};
// What the action was called with, small enough to store and clean enough to keep forever.
export const redactArgs = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, one(v)]));

// Steps that only look. Everything else moves something, so the verb is mutating whatever the recipe claims.
const READONLY = { desktop: new Set(['window', 'find', 'read', 'wait']), web: new Set(['goto', 'find', 'read', 'read-all', 'wait-for', 'wait']) };
const stepKey = s => Object.keys(s || {}).find(k => k !== 'as' && k !== 'fields');
export function stepsMutate(engine, steps) {
  const ro = READONLY[engine];
  if (!ro || !Array.isArray(steps)) return true;
  return steps.some(s => !ro.has(stepKey(s)));
}

// Steps that unambiguously change something. A web recipe may also run eval, which the engine treats as
// mutating by default but a recipe is allowed to declare read-only; a click never gets that benefit.
const MUTATES = new Set(['click', 'type', 'key']);

// The floor a verb's mutating flag may not go below. null when the engine gives nothing to derive from,
// so an imported manifest can still be trusted for engines that declare their own semantics.
export function derivedMutating(m, v) {
  if (READONLY[m?.engine]) return Array.isArray(v?.recipe?.steps) && v.recipe.steps.some(s => MUTATES.has(stepKey(s)));
  if (v?.http?.method) return !['get', 'head'].includes(String(v.http.method).toLowerCase());
  return null;
}

// Returns { allowed, decision, reason, approvalId? }. Never throws.
export async function guard({ tool, action, engine, method, target, args }) {
  const key = process.env.DASHCLAW_API_KEY;
  const strict = isStrict();
  const warn = msg => process.stderr.write(`warning: ${msg}\n`);
  if (!key) { warn('ungoverned mutating call (set DASHCLAW_API_KEY to gate)'); return { allowed: true, decision: 'skipped', reason: 'no DASHCLAW_API_KEY' }; }
  const fail = why => strict
    ? { allowed: false, decision: 'block', reason: `governance ${why} (strict; set DECLICK_GUARD=open to proceed ungoverned)` }
    : (warn(`governance ${why}; proceeding ungoverned`), { allowed: true, decision: 'failed-open', reason: why });
  const { url, error } = guardUrl();
  if (error) return fail(error);
  try {
    const r = await fetch(`${url}/api/guard`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ tool, action, risk_score: riskScore({ engine, method }), source: 'declick', method, target, args: redactArgs(args) }),
      signal: AbortSignal.timeout(Number(process.env.DASHCLAW_TIMEOUT_MS) || 3000),
    });
    if (!r.ok) return fail(`responded ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j || typeof j.decision !== 'string') return fail('returned no decision');
    const reason = j.reason || j.decision;
    // An approval is pending, not refused: the caller needs the id to go and clear it.
    if (j.decision === 'require_approval') {
      const id = j.approvalId ?? j.approval_id ?? j.id;
      return { allowed: false, decision: 'require_approval', reason, ...(id ? { approvalId: String(id) } : {}) };
    }
    if (j.decision === 'block') return { allowed: false, decision: 'block', reason };
    if (j.decision === 'warn') { warn(`governance: ${reason}`); return { allowed: true, decision: 'warn', reason }; }
    return { allowed: true, decision: 'allow', reason: j.decision };
  } catch (e) { return fail(`unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); }
}
