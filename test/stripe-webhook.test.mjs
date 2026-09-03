// site/api/stripe-webhook.js is CommonJS (require/module.exports) but this repo's package.json is
// "type": "module", so it can't be required or import()ed directly. Load it the way Node's own CJS
// loader would, via Module.wrap, so the real file under test runs unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

const TARGET = new URL('../site/api/stripe-webhook.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function loadHandler() {
  const src = readFileSync(TARGET, 'utf8');
  const fn = (0, eval)(Module.wrap(src));
  const mod = { exports: {} };
  fn(mod.exports, Module.createRequire(TARGET), mod, TARGET, TARGET.replace(/[^\\/]+$/, ''));
  return mod.exports;
}

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  RESEND_API_KEY: 're_dummy',
  LICENSE_SIGNING_SECRET: 'license_secret_dummy',
};

function sign(raw, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${v1}`;
}

function makeReq(raw, signature) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'stripe-signature': signature };
  queueMicrotask(() => { req.emit('data', raw); req.emit('end'); });
  return req;
}

function makeRes() {
  return { statusCode: 200, body: undefined, end(b) { this.body = b; } };
}

function buildEvent({ lineItems, metadata = {} }) {
  const session = {
    id: 'cs_test_123',
    payment_status: 'paid',
    status: 'complete',
    metadata,
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    subscription: null,
  };
  return { type: 'checkout.session.completed', livemode: false, data: { object: session }, _lineItems: lineItems };
}

async function post(handler, eventObj, fetchStub) {
  const event = { ...eventObj }; delete event._lineItems;
  const raw = Buffer.from(JSON.stringify(event));
  const req = makeReq(raw, sign(raw, ENV.STRIPE_WEBHOOK_SECRET));
  const res = makeRes();
  const savedEnv = { ...process.env }; Object.assign(process.env, ENV);
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/line_items')) return { json: async () => ({ data: eventObj._lineItems }) };
    if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email_1' }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = savedFetch;
    process.env = savedEnv;
  }
  return { res, calls };
}

test('a paid session for a foreign price with no declick metadata is ignored, not licensed', async () => {
  const handler = loadHandler();
  const event = buildEvent({
    lineItems: [{ quantity: 1, price: { lookup_key: null, recurring: { interval: 'year' } } }],
    metadata: {},
  });
  const { res, calls } = await post(handler, event);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ignored');
  assert.ok(!calls.some(c => c.url.includes('api.resend.com')), 'no license email should be sent');
});

test('a paid session with a declick TIERS lookup key still mints and emails a license', async () => {
  const handler = loadHandler();
  const event = buildEvent({
    lineItems: [{ quantity: 3, price: { lookup_key: 'declick_team_monthly', recurring: { interval: 'month' } } }],
    metadata: {},
  });
  const { res, calls } = await post(handler, event);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.sent, true);
  assert.equal(body.tier, 'team');
  assert.equal(body.seats, 3);
  assert.ok(calls.some(c => c.url.includes('api.resend.com')), 'a license email should be sent');
});

test('a paid session with declick.support-yearly metadata and no matching price still mints support', async () => {
  const handler = loadHandler();
  const event = buildEvent({
    lineItems: [{ quantity: 1, price: { lookup_key: null } }],
    metadata: { declick: 'support-yearly' },
  });
  const { res, calls } = await post(handler, event);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.sent, true);
  assert.equal(body.tier, 'support');
  assert.ok(calls.some(c => c.url.includes('api.resend.com')), 'a license email should be sent');
});
