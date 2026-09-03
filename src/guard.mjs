// One governance gate for every real mutating action: bin/run.mjs, src/ui.mjs and the authoring replay call it.
// Env: DASHCLAW_API_KEY (off when unset), DASHCLAW_URL (required once the key is set, https unless loopback),
// DASHCLAW_TIMEOUT_MS (3000), DECLICK_GUARD=open turns a guard failure back into a warning.
// The local policy file (src/policy.mjs, DECLICK_POLICY) decides first, so a block holds with no key and no network.
import { policyDecision } from './policy.mjs';
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
  // A chain is as mutating as the verbs it runs; compile resolved that from the target manifests and wrote it
  // per step, so a hand-edited composite cannot claim to be read-only. Steps missing entirely is the floor.
  if (m?.engine === 'compose') { const steps = v?.compose?.steps; return !Array.isArray(steps) || steps.some(s => !!s.mutating); }
  if (READONLY[m?.engine]) return Array.isArray(v?.recipe?.steps) && v.recipe.steps.some(s => MUTATES.has(stepKey(s)));
  if (v?.http?.method) return !['get', 'head'].includes(String(v.http.method).toLowerCase());
  return null;
}

// What DashClaw's /api/guard is posted. `action` is kept beside `action_type` for a guard that still reads the
// old name; the adapter, engine, method and redacted args ride in the tool object a policy can match on.
const hostOf = t => { try { return new URL(String(t)).hostname; } catch { return null; } };
export function guardBody({ tool, action, engine, method, target, args }) {
  const host = hostOf(target);
  return {
    action_type: action, action, agent_id: 'declick', agent_name: 'declick', risk_score: riskScore({ engine, method }), target,
    // agent_id and declared_goal are what DashClaw needs to keep the decision as an action record.
    declared_goal: `declick run ${tool} ${action}`,
    tool: { name: tool, engine, method, source: 'declick', args: redactArgs(args) },
    ...(host ? { systems_touched: [host] } : {}),
  };
}

// Returns { allowed, decision, reason, source?, approvalId? }. Throws only for an invalid policy file, which
// fails closed: the caller turns that into exit 1, because a policy nobody can read is not a policy.
export async function guard({ tool, action, engine, method, target, args }) {
  const key = process.env.DASHCLAW_API_KEY;
  const strict = isStrict();
  const warn = msg => process.stderr.write(`warning: ${msg}\n`);
  // The local floor runs first: it needs no key, no url and no request, so it holds when DashClaw is off. Every
  // caller of this gate is a mutating action, which is what a rule's `mutating` field is matched against.
  const local = policyDecision({ adapter: tool, verb: action, mutating: true });
  if (local && local.decision !== 'allow') {
    const reason = local.reason || `rule ${local.rule}`;
    if (local.decision === 'block') return { allowed: false, decision: 'block', reason, source: 'policy' };
    warn(`policy: ${reason}`);
    // A warning is not a decision: with a key set, DashClaw still gets to say what happens.
    if (!key) return { allowed: true, decision: 'warn', reason, source: 'policy' };
  }
  // No key means the owner chose not to run DashClaw: that's a config, not a fault, so it stays silent on stderr.
  if (!key) return { allowed: true, decision: 'skipped', reason: 'no guard configured' };
  const fail = why => strict
    ? { allowed: false, decision: 'block', reason: `governance ${why} (strict; set DECLICK_GUARD=open to proceed ungoverned)` }
    : (warn(`governance ${why}; proceeding ungoverned`), { allowed: true, decision: 'failed-open', reason: why });
  const { url, error } = guardUrl();
  if (error) return fail(error);
  try {
    // DashClaw reads an API key from x-api-key; a bearer is an OAuth token there and an oc_live key sent as one is
    // "invalid token". The body is DashClaw's guard input: action_type, a tool object, systems_touched; record=true
    // makes the decision an action record the dashboard shows. Fields it does not know are stripped, not refused.
    const r = await fetch(`${url}/api/guard?record=true`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(guardBody({ tool, action, engine, method, target, args })),
      signal: AbortSignal.timeout(Number(process.env.DASHCLAW_TIMEOUT_MS) || 3000),
    });
    if (!r.ok) return fail(`responded ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j || typeof j.decision !== 'string') return fail('returned no decision');
    const reason = j.reason || j.decision;
    // An approval is pending, not refused: the caller needs the id to go and clear it.
    if (j.decision === 'require_approval') {
      const id = j.approvalId ?? j.approval_id ?? j.decision_id ?? j.action_id ?? j.id;
      return { allowed: false, decision: 'require_approval', reason, ...(id ? { approvalId: String(id) } : {}) };
    }
    if (j.decision === 'block') return { allowed: false, decision: 'block', reason };
    if (j.decision === 'warn') { warn(`governance: ${reason}`); return { allowed: true, decision: 'warn', reason }; }
    // allow_contained is DashClaw's allow inside a sandbox it owns; to the caller that is an allow.
    return { allowed: true, decision: 'allow', reason: j.decision };
  } catch (e) { return fail(`unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); }
}
