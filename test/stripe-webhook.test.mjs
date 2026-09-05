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

// Replay + failure tests drive the handler twice (or inspect the ledger write) against a
// fetch stub that keeps the subscription's metadata in memory across calls, standing in
// for Stripe's own storage across a webhook retry.
function makeLedgerStub({ lineItems, ledgerId, ledgerPath, resend, enforceCap }) {
  const ledger = {};
  const emails = [];
  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.includes('/line_items')) return { json: async () => ({ data: lineItems }) };
    if (u.includes(`${ledgerPath}/${ledgerId}`)) {
      if (opts?.method === 'POST') {
        const body = new URLSearchParams(opts.body);
        const value = body.get('metadata[license_key]');
        // Stripe caps a metadata value at 500 characters; stand in for that here so a test
        // can prove the write survives real buyer data instead of assuming it fits.
        if (enforceCap && value.length > 500) return { json: async () => ({ error: { message: 'Value too long' } }) };
        ledger.license_key = value;
        return { json: async () => ({ metadata: ledger }) };
      }
      return { json: async () => ({ metadata: ledger }) };
    }
    if (u.includes('api.resend.com')) {
      emails.push(opts);
      if (resend?.fail) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, json: async () => ({ id: `email_${emails.length}` }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchStub, ledger, emails };
}

async function postRaw(handler, event, fetchStub) {
  const raw = Buffer.from(JSON.stringify(event));
  const req = makeReq(raw, sign(raw, ENV.STRIPE_WEBHOOK_SECRET));
  const res = makeRes();
  const savedEnv = { ...process.env }; Object.assign(process.env, ENV);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await handler(req, res);
  } finally {
    globalThis.fetch = savedFetch;
    process.env = savedEnv;
  }
  return res;
}

test('a Stripe retry of the same subscription checkout mints only once', async () => {
  const handler = loadHandler();
  const session = {
    id: 'cs_test_replay', payment_status: 'paid', status: 'complete', metadata: {},
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    subscription: 'sub_test_replay', payment_intent: null,
  };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object: session } };
  const lineItems = [{ quantity: 2, price: { lookup_key: 'declick_team_monthly', recurring: { interval: 'month' } } }];
  const { fetchStub, emails } = makeLedgerStub({ lineItems, ledgerId: 'sub_test_replay', ledgerPath: '/subscriptions' });

  const res1 = await postRaw(handler, event, fetchStub);
  assert.equal(res1.statusCode, 200);
  const body1 = JSON.parse(res1.body);
  assert.equal(body1.sent, true);
  assert.equal(emails.length, 1);

  const res2 = await postRaw(handler, event, fetchStub);
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.sent, false);
  assert.equal(body2.alreadyFulfilled, true);
  assert.equal(emails.length, 1, 'a replayed event must not mint or send a second license');
});

test('a Resend failure returns 500 and leaves the ledger unfulfilled so Stripe retries', async () => {
  const handler = loadHandler();
  const session = {
    id: 'cs_test_failure', payment_status: 'paid', status: 'complete', metadata: {},
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    subscription: 'sub_test_failure', payment_intent: null,
  };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object: session } };
  const lineItems = [{ quantity: 1, price: { lookup_key: 'declick_team_monthly', recurring: { interval: 'month' } } }];
  const { fetchStub, ledger } = makeLedgerStub({ lineItems, ledgerId: 'sub_test_failure', ledgerPath: '/subscriptions', resend: { fail: true } });

  const res = await postRaw(handler, event, fetchStub);
  assert.equal(res.statusCode, 500);
  assert.equal(ledger.license_key, undefined, 'the ledger must stay empty when the email failed to send');
});

test('a long email and name no longer overflow the ledger metadata cap: two deliveries send one email', async () => {
  const handler = loadHandler();
  // Stripe caps a metadata value at 500 characters. The minted license (email + name + ids
  // baked into its payload) can cross that for ordinary buyers; the ledger must hold a
  // fixed-size value (payload.id) that never can, so a real buyer's data can't defeat it.
  const email = `${'a'.repeat(90)}@example.com`;
  const name = 'B'.repeat(60);
  const session = {
    id: 'cs_test_longmeta', payment_status: 'paid', status: 'complete', metadata: {},
    customer_details: { email, name },
    subscription: 'sub_test_longmeta', payment_intent: null,
  };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object: session } };
  const lineItems = [{ quantity: 1, price: { lookup_key: 'declick_team_monthly', recurring: { interval: 'month' } } }];
  const { fetchStub, ledger, emails } = makeLedgerStub({ lineItems, ledgerId: 'sub_test_longmeta', ledgerPath: '/subscriptions', enforceCap: true });

  const res1 = await postRaw(handler, event, fetchStub);
  assert.equal(res1.statusCode, 200);
  const body1 = JSON.parse(res1.body);
  assert.equal(body1.sent, true);
  assert.equal(emails.length, 1);
  assert.ok(ledger.license_key, 'the ledger write must succeed, not be silently dropped by the cap');
  assert.ok(ledger.license_key.length < 500);

  const res2 = await postRaw(handler, event, fetchStub);
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.sent, false);
  assert.equal(body2.alreadyFulfilled, true);
  assert.equal(emails.length, 1, 'a long email and name must not defeat the ledger and cause a second mint+send');
});

test('a payment-mode session (support-yearly) ledgers on the PaymentIntent, not the subscription', async () => {
  const handler = loadHandler();
  const session = {
    id: 'cs_test_pi', payment_status: 'paid', status: 'complete', metadata: { declick: 'support-yearly' },
    customer_details: { email: 'buyer@example.com', name: 'Buyer' },
    subscription: null, payment_intent: 'pi_test_123',
  };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object: session } };
  const lineItems = [{ quantity: 1, price: { lookup_key: null } }];
  const { fetchStub, ledger, emails } = makeLedgerStub({ lineItems, ledgerId: 'pi_test_123', ledgerPath: '/payment_intents' });

  const res1 = await postRaw(handler, event, fetchStub);
  assert.equal(res1.statusCode, 200);
  const body1 = JSON.parse(res1.body);
  assert.equal(body1.sent, true);
  assert.equal(body1.tier, 'support');
  assert.equal(emails.length, 1);
  assert.ok(ledger.license_key, 'the PaymentIntent metadata should carry the ledger value');

  const res2 = await postRaw(handler, event, fetchStub);
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.sent, false);
  assert.equal(body2.alreadyFulfilled, true);
  assert.equal(emails.length, 1, 'a replayed payment-mode event must not mint or send a second license');
});
