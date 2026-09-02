import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(`site/${f}`, 'utf8');

test('index.html has the SEO floor', () => {
  const h = read('index.html');
  assert.match(h, /<title>[^<]{20,70}<\/title>/);
  assert.match(h, /<meta name="description" content="[^"]{60,160}"/);
  assert.match(h, /<link rel="canonical" href="https:\/\/declick\.dev\/"/);
  assert.match(h, /<meta property="og:title"/); assert.match(h, /<meta property="og:image" content="https:\/\/declick\.dev\/og\.png"/);
  assert.match(h, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(h, /npm i -g declick/); assert.match(h, /github\.com\/ucsandman\/declick/);
  assert.ok(!h.includes('\u2014'), 'no em dashes');
});
test('robots, sitemap, llms', () => {
  assert.match(read('robots.txt'), /Sitemap: https:\/\/declick\.dev\/sitemap\.xml/);
  assert.match(read('sitemap.xml'), /<loc>https:\/\/declick\.dev\/<\/loc>/);
  const l = read('llms.txt'); assert.match(l, /^# declick/); assert.match(l, /github\.com\/ucsandman\/declick/);
});
test('og.html is 1200x630 and self contained', () => {
  const o = read('og.html');
  assert.match(o, /width:\s*1200px/); assert.match(o, /height:\s*630px/);
  assert.ok(!/<link[^>]+href="http/.test(o) && !/<script[^>]+src=/.test(o), 'no external assets');
});
test('vercel.json uses clean urls and sets headers', () => {
  const v = JSON.parse(read('vercel.json'));
  assert.equal(v.cleanUrls, true); assert.ok(Array.isArray(v.headers));
});
