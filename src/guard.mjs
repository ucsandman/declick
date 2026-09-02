// One governance gate for every real mutating action: bin/run.mjs and the authoring replay both call it.
// Env: DASHCLAW_API_KEY (off when unset), DASHCLAW_URL (default below), DASHCLAW_TIMEOUT_MS (3000),
// DECLICK_GUARD=strict makes any guard failure a block instead of a warning.
export const DEFAULT_URL = 'https://my-dashclaw.vercel.app';
const RISK = { delete: 70, put: 55, patch: 55, post: 45, desktop: 60 };

export function riskScore({ engine, method }) { return RISK[engine === 'desktop' ? 'desktop' : String(method || '').toLowerCase()] ?? 40; }

// Returns { allowed, reason }. Never throws.
export async function guard({ tool, action, engine, method, target }) {
  const key = process.env.DASHCLAW_API_KEY;
  const strict = process.env.DECLICK_GUARD === 'strict';
  const warn = msg => process.stderr.write(`warning: ${msg}\n`);
  if (!key) { warn('ungoverned mutating call (set DASHCLAW_API_KEY to gate)'); return { allowed: true, reason: 'no key' }; }
  const fail = why => strict ? { allowed: false, reason: `governance ${why} (DECLICK_GUARD=strict)` } : (warn(`governance ${why}; proceeding ungoverned`), { allowed: true, reason: why });
  try {
    const r = await fetch(`${process.env.DASHCLAW_URL || DEFAULT_URL}/api/guard`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ tool, action, risk_score: riskScore({ engine, method }), source: 'declick', method, target }),
      signal: AbortSignal.timeout(Number(process.env.DASHCLAW_TIMEOUT_MS) || 3000),
    });
    if (!r.ok) return fail(`responded ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j || typeof j.decision !== 'string') return fail('returned no decision');
    if (['block', 'require_approval'].includes(j.decision)) return { allowed: false, reason: j.reason || j.decision };
    if (j.decision === 'warn') warn(`governance: ${j.reason || 'warn'}`);
    return { allowed: true, reason: j.decision };
  } catch (e) { return fail(`unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); }
}
