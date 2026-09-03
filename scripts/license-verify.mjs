#!/usr/bin/env node
// Verify a declick license key: node scripts/license-verify.mjs <key>   (LICENSE_SIGNING_SECRET in the env).
// The key is `<base64url payload>.<base64url HMAC-SHA256>`, minted by site/api/stripe-webhook.js on a paid checkout.
// Prints the payload on a valid signature, exit 0; exit 1 on a bad key or a missing secret. Never prints the secret.
import { createHmac, timingSafeEqual } from 'node:crypto';
const [key] = process.argv.slice(2);
const secret = process.env.LICENSE_SIGNING_SECRET;
const fail = m => { console.error(`invalid: ${m}`); process.exit(1); };
if (!key) fail('usage: node scripts/license-verify.mjs <license-key>');
if (!secret) fail('LICENSE_SIGNING_SECRET is not set');
const [body, sig] = key.trim().split('.');
if (!body || !sig) fail('a key has two dot-separated parts');
const want = createHmac('sha256', secret).update(body).digest();
const got = Buffer.from(sig, 'base64url');
if (want.length !== got.length || !timingSafeEqual(want, got)) fail('signature does not match');
console.log(JSON.stringify(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), null, 2));
