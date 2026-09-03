// The 2026-09-03 incident: guard.mjs sent a bearer header and a flat body DashClaw's /api/guard never accepted,
// and 566 tests stayed green because every one of them mocked the endpoint. This file runs guardBody()'s real
// output through a validator mirroring DashClaw's own GUARD_INPUT_SCHEMA (test/fixtures/dashclaw-guard-schema.json,
// transcribed from DashClaw's app/lib/validate.js) so a future wire-format drift fails here, with no server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { guardBody } from '../src/guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'dashclaw-guard-schema.json'), 'utf8'));

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

// One checker per schema type, mirroring validate.js's FIELD_TYPE_VALIDATORS (order of checks preserved).
const CHECKERS = {
  string: (key, value, rule) => {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (value.length === 0 && rule.required) return `${key} cannot be empty`;
    if (rule.maxLength && value.length > rule.maxLength) return `${key} exceeds max length of ${rule.maxLength}`;
    if (rule.enum && !rule.enum.includes(value)) return `${key} must be one of: ${rule.enum.join(', ')}`;
    return null;
  },
  integer: (key, value, rule) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be an integer`;
    if (rule.min !== undefined && value < rule.min) return `${key} must be >= ${rule.min}`;
    if (rule.max !== undefined && value > rule.max) return `${key} must be <= ${rule.max}`;
    return null;
  },
  boolean: (key, value) => (typeof value !== 'boolean' ? `${key} must be a boolean` : null),
  array: (key, value, rule) => {
    if (!Array.isArray(value)) return `${key} must be an array`;
    if (rule.maxItems && value.length > rule.maxItems) return `${key} exceeds max items of ${rule.maxItems}`;
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') return `${key}[${i}] must be a string`;
      if (value[i].length > 500) return `${key}[${i}] exceeds max length of 500`;
    }
    return null;
  },
  object: (key, value) => (isPlainObject(value) ? null : `${key} must be an object`),
};

// Mirrors validateGuardInput's alias normalization: action -> action_type, intent -> declared_goal, only when
// the canonical key is absent. Unknown top-level keys (anything not a key of schema.fields) are stripped by
// DashClaw's validate(), which only ever iterates Object.entries(schema) -- they are never a validation error.
function validateGuardInput(body, schemaFixture) {
  const errors = [];
  const src = isPlainObject(body) ? body : {};
  const normalized = { ...src };
  for (const [key, rule] of Object.entries(schemaFixture.fields)) {
    if (rule.alias && src[key] !== undefined && src[key] !== null && normalized[rule.alias] == null) {
      normalized[rule.alias] = src[key];
    }
  }
  for (const [key, rule] of Object.entries(schemaFixture.fields)) {
    const value = normalized[key];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(`${key} is required`);
      continue;
    }
    const checker = CHECKERS[rule.type];
    const err = checker ? checker(key, value, rule) : null;
    if (err) errors.push(err);
  }
  return { valid: errors.length === 0, errors };
}

// DashClaw never sees the in-memory object guardBody() returns, only JSON.stringify() of it (a key with value
// undefined, e.g. an omitted target, is dropped by JSON.stringify). Validate what actually reaches the wire.
const wire = args => JSON.parse(JSON.stringify(guardBody(args)));

// A dial cranked to failing on purpose and back: this documents the two runs the task asked for rather than
// leaving them as a manual step nobody can repeat. Restores the real schema immediately after.
test('the validator actually rejects a wrong type (proves it is not a rubber stamp)', () => {
  const body = wire({ tool: 'gov', action: 'delete-pet', engine: 'openapi', method: 'delete', target: 'https://api.example.com/pet/7', args: { id: '7' } });
  const broken = JSON.parse(JSON.stringify(schema));
  broken.fields.tool = { type: 'string' };
  const result = validateGuardInput(body, broken);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['tool must be a string']);
});

test('schema fixture itself still shapes tool as object and action_type as required', () => {
  assert.equal(schema.fields.tool.type, 'object');
  assert.equal(schema.fields.action_type.required, true);
});

const cases = {
  'openapi delete': wire({ tool: 'gov', action: 'delete-pet', engine: 'openapi', method: 'delete',
    target: 'https://api.example.com/pet/7', args: { id: '7' } }),
  'desktop verb': wire({ tool: 'notes', action: 'click', engine: 'desktop', method: undefined,
    target: undefined, args: { x: 10, y: 20 } }),
  'mcp verb with 30 redacted args': wire({ tool: 'qa-notes', action: 'create-note', engine: 'mcp', method: 'tool',
    target: undefined, args: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`arg${i}`, `value-${i}`])) }),
  'target with no host': wire({ tool: 'files', action: 'write', engine: 'openapi', method: 'put',
    target: 'not-a-url', args: {} }),
};

for (const [label, body] of Object.entries(cases)) {
  test(`guardBody(${label}) validates against DashClaw's real GUARD_INPUT_SCHEMA with zero errors`, () => {
    const result = validateGuardInput(body, schema);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  test(`guardBody(${label}): action_type mirrors action, tool is a plain object, agent_id and declared_goal are present`, () => {
    assert.equal(typeof body.action_type, 'string');
    assert.equal(body.action_type, body.action);
    assert.equal(isPlainObject(body.tool), true);
    assert.equal(typeof body.agent_id, 'string');
    assert.ok(body.agent_id.length > 0);
    assert.equal(typeof body.declared_goal, 'string');
    assert.ok(body.declared_goal.length > 0);
  });

  test(`guardBody(${label}): no top-level key is a known DashClaw name sent with the wrong type`, () => {
    for (const [key, value] of Object.entries(body)) {
      const rule = schema.fields[key];
      if (!rule) continue; // unknown to DashClaw: it strips these, not an error
      const checker = CHECKERS[rule.type];
      assert.equal(checker(key, value, rule), null, `${key} should match schema type ${rule.type}`);
    }
  });
}

test('target with no host omits systems_touched but keeps target as a plain string', () => {
  const body = cases['target with no host'];
  assert.equal(body.systems_touched, undefined);
  assert.equal(body.target, 'not-a-url');
});
