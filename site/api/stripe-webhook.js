// Stripe -> license email. One event, checkout.session.completed, verified against the endpoint's signing secret,
// then the session's line items decide the tier and seat count, a signed license is minted, and Resend delivers it.
// Zero dependencies: the signature is HMAC-SHA256 over `${t}.${rawBody}`, the license is HMAC-SHA256 over its payload.
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, LICENSE_SIGNING_SECRET, LICENSE_BCC (optional).
const { createHmac, timingSafeEqual, randomUUID } = require('node:crypto');

const FROM = 'declick <declick@practicalsystems.io>';
const REPLY_TO = 'wes@practicalsystems.io';
const TIERS = { declick_team_monthly: 'team', declick_team_yearly: 'team', declick_support_yearly: 'support' };
const b64 = s => Buffer.from(s).toString('base64url');
const readRaw = req => new Promise((res, rej) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });

function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${parts.t}.`).update(raw).digest('hex');
  return want.length === parts.v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}

// A license is a payload and a signature, both base64url, joined by a dot; scripts/license-verify.mjs checks it.
function mint(payload, secret) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const stripe = async (path, key) => {
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Basic ${Buffer.from(key + ':').toString('base64')}` } });
  const j = await r.json(); if (j.error) throw new Error(`stripe ${path}: ${j.error.message}`); return j;
};

function letter({ name, tier, seats, license, interval }) {
  const what = tier === 'support'
    ? 'production support for declick for one year: a named contact, a two business day response, and a private issue tracker'
    : `${seats} developer seat${seats === 1 ? '' : 's'} for commercial use of declick, billed ${interval === 'year' ? 'yearly' : 'monthly'}`;
  return [
    `Hi${name ? ` ${name}` : ''},`, '',
    `Thanks for buying ${what}. Your license is below. Keep it with your other credentials; it is your proof of purchase and it names what it covers.`, '',
    license, '',
    'What it covers: the Elastic License 2.0 that ships with declick, plus a commercial grant for the seats above while the subscription is active. Nothing in declick asks for this key today; if a later release does, this key will be the one it accepts.',
    '', 'Receipts and invoices come from Stripe, and you can change seats or cancel from the link in any of them.',
    '', `Reply to this email for anything at all, including support. It reaches me directly.`, '', 'Wes Sander', 'Practical Systems', 'https://declick.dev',
  ].join('\n');
}

async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('method not allowed'); }
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, LICENSE_SIGNING_SECRET, LICENSE_BCC } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !RESEND_API_KEY || !LICENSE_SIGNING_SECRET) { res.statusCode = 500; return res.end('webhook not configured'); }
  const raw = await readRaw(req);
  if (!verify(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) { res.statusCode = 400; return res.end('bad signature'); }
  const event = JSON.parse(raw.toString('utf8'));
  if (event.type !== 'checkout.session.completed') { res.statusCode = 200; return res.end('ignored'); }
  const session = event.data.object;
  if (session.payment_status !== 'paid' && session.status !== 'complete') { res.statusCode = 200; return res.end('not paid'); }
  const items = (await stripe(`/checkout/sessions/${session.id}/line_items?limit=10&expand[]=data.price`, STRIPE_SECRET_KEY)).data;
  const item = items.find(i => TIERS[i.price?.lookup_key]);
  if (!item && !session.metadata?.declick) {
    console.log(`declick webhook: ignoring session ${session.id}, not a declick price`);
    res.statusCode = 200; return res.end('ignored');
  }
  const tier = TIERS[item?.price?.lookup_key] || (session.metadata?.declick === 'support-yearly' ? 'support' : 'team');
  const seats = tier === 'support' ? 1 : Number(item?.quantity || 1);
  const email = session.customer_details?.email || session.customer_email;
  const name = session.customer_details?.name || '';
  if (!email) { res.statusCode = 200; return res.end('no email on session'); }
  const payload = { v: 1, id: randomUUID(), tier, seats, email, name, issued: new Date().toISOString().slice(0, 10), subscription: session.subscription || null, session: session.id, livemode: !!event.livemode };
  const license = mint(payload, LICENSE_SIGNING_SECRET);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [email], reply_to: REPLY_TO, ...(LICENSE_BCC ? { bcc: [LICENSE_BCC] } : {}),
      subject: `Your declick license${event.livemode ? '' : ' (test mode)'}`, text: letter({ name, tier, seats, license, interval: item?.price?.recurring?.interval }) }),
  });
  if (!r.ok) { res.statusCode = 502; return res.end(`resend ${r.status}`); }
  res.statusCode = 200; res.end(JSON.stringify({ sent: true, tier, seats, id: payload.id }));
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
