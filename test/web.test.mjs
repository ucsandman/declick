import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DECLICK_HOME = mkdtempSync(join(tmpdir(), 'declick-web-'));
const { compile, execute, validateWebRecipe, snapshot, pageText } = await import('../src/engines/web.mjs');
const { findChrome, launch } = await import('../src/cdp.mjs');
const { shape } = await import('../src/output.mjs');
const { describe } = await import('../src/describe.mjs');

const root = join(process.cwd(), 'fixtures', 'web');
const srv = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const p = join(root, rel === '/' ? 'index.html' : rel);
  if (!p.startsWith(root) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(p));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}/`;
after(() => srv.close());

const chrome = findChrome();
// The one skip that is allowed: no browser on the box. Everything else must run the real thing.
const skip = chrome ? false : 'no Chrome or Edge found; install Chrome or set CHROME=<path to chrome.exe>';
const m = await compile(`web:${site}`, { name: 'fixture-site', recipes: join(process.cwd(), 'fixtures', 'web-recipes') });

test('compile turns a recipe dir into verbs and keeps the origin as the window', () => {
  assert.equal(m.engine, 'web');
  assert.equal(m.window, site.replace(/\/$/, ''));
  assert.deepEqual(m.verbs.map(v => v.name), ['click-counter', 'list-items', 'read-title', 'search']);
  assert.deepEqual(m.verbs.map(v => v.mutating), [true, false, false, true]);
  assert.deepEqual(m.verbs.find(v => v.name === 'search').args, [{ name: 'query' }]);
  assert.deepEqual(m.verbs.find(v => v.name === 'list-items').returns, { shape: 'array', fields: [{ name: 'sku' }, { name: 'name' }, { name: 'price' }, { name: 'href' }] });
  assert.match(describe(m).split('\n')[0], new RegExp(`window: "${site.replace(/\/$/, '')}"`));
});

test('validateWebRecipe rejects a recipe that cannot replay', () => {
  assert.deepEqual(validateWebRecipe({ steps: [{ goto: '/' }, { find: '#a', as: 'a' }, { click: 'a' }] }), []);
  const errs = validateWebRecipe({ steps: [{ nope: 1 }, { click: 'ghost' }, { find: '#a' }], returns: 'missing' });
  assert.ok(errs.some(e => /unknown step/.test(e)), errs.join('; '));
  assert.ok(errs.some(e => /ghost is not located by an earlier find/.test(e)), errs.join('; '));
  assert.ok(errs.some(e => /find needs "as"/.test(e)), errs.join('; '));
  assert.ok(errs.some(e => /returns "missing"/.test(e)), errs.join('; '));
});

test('dry-run previews the steps without launching a browser', async () => {
  const real = process.env.CHROME;
  process.env.CHROME = join(tmpdir(), 'no-such-chrome.exe');
  const r = await execute(m, 'search', ['widget'], { dryRun: true });
  if (real === undefined) delete process.env.CHROME; else process.env.CHROME = real;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.steps[0].goto, `${site.replace(/\/$/, '')}/`);
  assert.ok(r.data.steps.some(s => s.would === 'type' && s.text === 'widget'), JSON.stringify(r.data.steps));
  assert.equal(r.meta.steps, 8);
});

test('an undeclared placeholder fails before the browser starts', async () => {
  const bad = { ...m, verbs: [{ name: 'oops', description: 'x', args: [], mutating: false, recipe: { steps: [{ goto: '/' }, { find: '#q', as: 'q' }, { type: ['q', '{{nope}}'] }] } }] };
  const r = await execute(bad, 'oops', [], { dryRun: true });
  assert.equal(r.exit, 1); assert.match(r.error, /undeclared \{\{nope\}\}/);
});

test('a missing browser names CHROME', { skip }, async () => {
  const real = process.env.CHROME;
  process.env.CHROME = join(tmpdir(), 'no-such-chrome.exe');
  const r = await execute(m, 'read-title', [], {});
  if (real === undefined) delete process.env.CHROME; else process.env.CHROME = real;
  assert.equal(r.exit, 1); assert.match(r.error, /CHROME/);
});

test('read-title drives a real browser and returns the title', { skip }, async () => {
  const r = await execute(m, 'read-title', [], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, 'Declick Web Fixture');
  assert.equal(r.meta.steps, 2);
});

test('list-items returns rows the 0.3 projection can trim', { skip }, async () => {
  const r = await execute(m, 'list-items', [], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.length, 3);
  assert.deepEqual(r.data[0], { sku: 'A-1', name: 'Alpha', price: '10', href: '/docs.html#a' });
  const { data, meta } = shape(r.data, { fields: ['sku', 'name'], limit: 2 });
  assert.deepEqual(data, [{ sku: 'A-1', name: 'Alpha' }, { sku: 'B-2', name: 'Bravo' }]);
  assert.equal(meta.count, 3); assert.equal(meta.truncated, true);
});

test('search types into the real form and reads the result', { skip }, async () => {
  const r = await execute(m, 'search', ['bolts'], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, 'found bolts');
});

test('click-counter is mutating and increments the real counter', { skip }, async () => {
  assert.equal(m.verbs.find(v => v.name === 'click-counter').mutating, true);
  const r = await execute(m, 'click-counter', [], {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data, '1');
});

test('a find miss exits 2 with candidates instead of a screenshot', { skip }, async () => {
  const miss = { ...m, verbs: [{ name: 'miss', description: 'x', args: [], mutating: false, recipe: { steps: [{ goto: '/' }, { find: '#nope', as: 'x', timeout: 500 }, { read: 'x', as: 'y' }], returns: 'y' } }] };
  const r = await execute(miss, 'miss', [], {});
  assert.equal(r.exit, 2, JSON.stringify(r));
  assert.match(r.error, /#nope/);
  assert.ok(Array.isArray(r.data.candidates) && r.data.candidates.length, JSON.stringify(r.data));
  assert.ok(r.data.candidates.length <= 10);
  assert.ok(r.data.candidates.some(c => c.id === 'bump' && c.tag === 'button'), JSON.stringify(r.data.candidates));
  assert.ok(r.data.candidates.some(c => c.name === 'q'), JSON.stringify(r.data.candidates));
});

test('DECLICK_CDP reuses a browser that is already running', { skip }, async () => {
  const browser = await launch();
  process.env.DECLICK_CDP = browser.url;
  try {
    const r = await execute(m, 'read-title', [], {});
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data, 'Declick Web Fixture');
    assert.equal(browser.proc.exitCode, null, 'a browser declick attached to must survive the run');
  } finally { delete process.env.DECLICK_CDP; try { browser.proc.kill(); } catch {} }
});

test('snapshot returns a compact tree with the interactive elements first', { skip }, async () => {
  const s = await snapshot(site, { limit: 12 });
  assert.equal(s.title, 'Declick Web Fixture');
  assert.ok(s.nodes.length <= 12);
  assert.ok(s.nodes[0].interactive, JSON.stringify(s.nodes[0]));
  assert.ok(s.nodes.some(n => n.role === 'link' && n.href === '/docs.html'), JSON.stringify(s.nodes));
  assert.ok(s.nodes.some(n => n.role === 'button' && n.name === 'Add one'), JSON.stringify(s.nodes));
});

test('snapshot --grep matches role:name or href and returns only matching nodes', { skip }, async () => {
  const s = await snapshot(site, { grep: /add one/i, limit: 12 });
  assert.ok(s.nodes.length > 0, JSON.stringify(s.nodes));
  assert.ok(s.nodes.every(n => /add one/i.test(`${n.role}:${n.name}`) || (n.href && /add one/i.test(n.href))), JSON.stringify(s.nodes));
  const byHref = await snapshot(site, { grep: /docs\.html/i, limit: 12 });
  assert.ok(byHref.nodes.length > 0, JSON.stringify(byHref.nodes));
  assert.ok(byHref.nodes.every(n => n.href && /docs\.html/i.test(n.href)), JSON.stringify(byHref.nodes));
});

test('snapshot --grep with no match is NOT_FOUND', { skip }, async () => {
  await assert.rejects(snapshot(site, { grep: /zzzznomatch/i }), e => {
    assert.equal(e.exit, 2);
    assert.match(e.message, /no element matches \/zzzznomatch\/ on/);
    return true;
  });
});

test('pageText returns numbered non-empty lines from the fixture', { skip }, async () => {
  const p = await pageText(site, {});
  assert.equal(p.title, 'Declick Web Fixture');
  assert.equal(p.url, site);
  assert.ok(p.lines.every(l => l.text.trim() === l.text && l.text.length > 0), JSON.stringify(p.lines));
  assert.deepEqual(p.lines.map(l => l.n), p.lines.map((_, i) => i + 1));
  assert.deepEqual(p.lines[0], { n: 1, text: 'Declick Web Fixture' });
  assert.ok(p.lines.some(l => l.text === 'Add one'), JSON.stringify(p.lines));
});

test('pageText --grep filters lines and keeps the n from the full text', { skip }, async () => {
  const full = await pageText(site, {});
  const wanted = full.lines.find(l => l.text === 'Add one');
  const filtered = await pageText(site, { grep: /add one/i });
  assert.deepEqual(filtered.lines, [wanted]);
});

test('pageText --grep with no match is NOT_FOUND', { skip }, async () => {
  await assert.rejects(pageText(site, { grep: /zzzznomatch/i }), e => {
    assert.equal(e.exit, 2);
    assert.match(e.message, /no line matches \/zzzznomatch\/ on/);
    return true;
  });
});

test('pageText --selector scopes the text to that element', { skip }, async () => {
  const p = await pageText(site, { selector: '#items' });
  assert.equal(p.lines.length, 3);
  assert.deepEqual(p.lines.map(l => l.text), ['Alpha10details', 'Bravo20details', 'Charlie30details']);
  assert.deepEqual(p.lines.map(l => l.n), [1, 2, 3]);
});
