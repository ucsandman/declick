// Zero-dep Chrome DevTools Protocol client: launch (or attach to) a browser and drive one page.
// No puppeteer, no screenshots: every helper answers with text an agent can act on.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const err = (msg, exit = 1) => Object.assign(new Error(msg), { exit });
const home = () => process.env.DECLICK_HOME || join(homedir(), '.declick');
const FLAGS = ['--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--remote-allow-origins=*'];

// Edge is Chromium and speaks the same protocol, so a Windows box without Chrome still works.
function candidates() {
  if (process.env.CHROME) return [process.env.CHROME];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return [join(pf, 'Google/Chrome/Application/chrome.exe'), join(pf86, 'Google/Chrome/Application/chrome.exe'), join(local, 'Google/Chrome/Application/chrome.exe'),
      join(pf86, 'Microsoft/Edge/Application/msedge.exe'), join(pf, 'Microsoft/Edge/Application/msedge.exe')];
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export function findChrome() { return candidates().find(existsSync) || null; }

// --remote-debugging-port=0 picks a free port and announces it on stderr; that line is the only way to learn it.
function wsLine(proc, timeout) {
  return new Promise((res, rej) => {
    let buf = '';
    const finish = (e, url) => { clearTimeout(timer); proc.stderr.off('data', onData); proc.off('exit', onExit); e ? rej(e) : res(url); };
    const onData = d => { buf += d; const hit = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (hit) finish(null, hit[1]); };
    const onExit = code => finish(err(`browser exited ${code}: ${buf.trim().split('\n').slice(-2).join(' ') || 'no output'}`));
    const timer = setTimeout(() => finish(err(`browser printed no DevTools endpoint after ${timeout}ms`)), timeout);
    proc.stderr.setEncoding('utf8'); proc.stderr.on('data', onData); proc.on('exit', onExit);
  });
}

export async function launch({ timeout = 30000 } = {}) {
  const bin = findChrome();
  if (!bin) throw err('no Chrome or Edge found; install Chrome or set CHROME=<path to the browser executable>');
  const base = join(home(), '.web-profile');
  let last;
  // A profile another declick run already locked never prints the endpoint, so fall back to a private one.
  for (const dir of [base, `${base}-${process.pid}`]) {
    mkdirSync(dir, { recursive: true });
    const proc = spawn(bin, [...FLAGS, `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('error', e => { last = err(`cannot start ${bin}: ${e.message}`); });
    try {
      const url = await wsLine(proc, timeout);
      proc.stderr.resume(); // chrome blocks on a full stderr pipe once nobody reads it
      return { proc, url };
    } catch (e) { last = e; try { proc.kill(); } catch {} }
  }
  throw err(`${bin} did not start: ${last.message}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(err(`cannot connect to ${url}`)); });
  return new Conn(ws);
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.n = 0; this.waiting = new Map(); this.dead = null;
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const w = this.waiting.get(msg.id); if (!w) return; // events are not awaited: every helper polls instead
      this.waiting.delete(msg.id);
      msg.error ? w.rej(err(`${w.method}: ${msg.error.message}`)) : w.res(msg.result);
    };
    ws.onerror = () => {};
    ws.onclose = () => this.bury(err('browser connection closed'));
  }
  bury(e) { this.dead = e; for (const w of this.waiting.values()) w.rej(e); this.waiting.clear(); }
  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.n;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(err(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.waiting.set(id, { method, res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const q = v => JSON.stringify(v);

// Page-side element lookup: a css selector, or text=<what the human sees>, exact match first, then the shortest containing one.
const FIND = `(function (sel) {
  if (sel.indexOf('text=') === 0) {
    var want = sel.slice(5).replace(/\\s+/g, ' ').trim().toLowerCase();
    var txt = function (e) { return String(e.value || e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase(); };
    var vis = Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,label,li,td,th,h1,h2,h3,h4,p,span,div,summary,option'))
      .filter(function (e) { return e.getClientRects().length > 0; });
    var exact = vis.filter(function (e) { return txt(e) === want; });
    var part = vis.filter(function (e) { return txt(e).indexOf(want) > -1; }).sort(function (a, b) { return txt(a).length - txt(b).length; });
    return exact[0] || part[0] || null;
  }
  return document.querySelector(sel);
})`;

// What an agent needs to fix a broken selector without looking at a picture of the page.
const CANDIDATES = `(function (limit) {
  return Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,summary,[role=button],[onclick]'))
    .filter(function (e) { return e.getClientRects().length > 0; })
    .slice(0, limit)
    .map(function (e) {
      return { tag: e.tagName.toLowerCase(), text: String(e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60), id: e.id || null, name: e.getAttribute('name') || null };
    });
})`;

// A field selector is "sel" (text of the first match), "@attr" (attribute of the row) or "sel@attr".
const ROWS = `(function (css, fields) {
  var text = function (e) { return String(('value' in e && e.value) || e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim(); };
  return Array.prototype.slice.call(document.querySelectorAll(css)).map(function (row) {
    if (!fields) return text(row);
    var out = {};
    Object.keys(fields).forEach(function (k) {
      var parts = String(fields[k]).split('@');
      var el = parts[0] ? row.querySelector(parts[0]) : row;
      out[k] = !el ? null : parts[1] ? el.getAttribute(parts[1]) : text(el);
    });
    return out;
  });
})`;

// The compact accessible tree: enough to write the next recipe, small enough to read in a token budget.
const TREE = `(function (sel, limit) {
  var root = sel ? document.querySelector(sel) : document.body;
  if (!root) return null;
  var ROLE = { A: 'link', BUTTON: 'button', SELECT: 'select', TEXTAREA: 'textbox', FORM: 'form', IMG: 'image', H1: 'heading', H2: 'heading', H3: 'heading', LI: 'listitem', UL: 'list', OL: 'list', TABLE: 'table', NAV: 'navigation', LABEL: 'label', SUMMARY: 'summary' };
  var hot = function (e) { return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].indexOf(e.tagName) > -1 || e.hasAttribute('onclick') || e.getAttribute('role') === 'button'; };
  var name = function (e) { return String(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('alt') || e.getAttribute('title') || e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80); };
  var els = Array.prototype.slice.call(root.querySelectorAll('*'));
  if (root !== document.body) els.unshift(root);
  var out = [];
  els.forEach(function (e) {
    if (!e.getClientRects().length) return;
    var role = e.getAttribute('role') || (e.tagName === 'INPUT' ? (e.type || 'text') : ROLE[e.tagName]);
    if (!role && !hot(e)) return;
    var n = name(e);
    if (!n && !e.id && !e.getAttribute('href')) return;
    out.push({ role: role || e.tagName.toLowerCase(), name: n, id: e.id || null, href: e.getAttribute('href'), value: ('value' in e && e.value) ? String(e.value).slice(0, 80) : null, interactive: hot(e) });
  });
  out.sort(function (a, b) { return (b.interactive ? 1 : 0) - (a.interactive ? 1 : 0); });
  return out.slice(0, limit);
})`;

const KEYS = {
  Enter: { keyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Tab: { keyCode: 9, key: 'Tab', code: 'Tab' },
  Escape: { keyCode: 27, key: 'Escape', code: 'Escape' },
  Backspace: { keyCode: 8, key: 'Backspace', code: 'Backspace' },
  ArrowDown: { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  ArrowUp: { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  Space: { keyCode: 32, key: ' ', code: 'Space', text: ' ' },
};

class Page {
  constructor(conn, sessionId, targetId, proc) { this.conn = conn; this.sessionId = sessionId; this.targetId = targetId; this.proc = proc; }
  send(method, params, timeout) { return this.conn.send(method, params, this.sessionId, timeout); }

  async evaluate(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw err(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async callOn(objectId, fn, args = []) {
    const r = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true });
    if (r.exceptionDetails) throw err(`call failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async navigate(url) {
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw err(`cannot open ${url}: ${r.errorText}`);
    await this.waitForLoad();
  }
  // Polling beats Page.loadEventFired here: a load that already fired can never be missed.
  async waitForLoad(timeout = 30000) {
    const until = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate('document.readyState === "complete"')) return true;
      if (Date.now() > until) throw err(`page did not finish loading in ${timeout}ms`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
  // Returns an objectId handle, or null when nothing matches.
  async find(sel) {
    const r = await this.send('Runtime.evaluate', { expression: `${FIND}(${q(sel)})`, returnByValue: false });
    if (r.exceptionDetails) throw err(`bad selector ${sel}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.objectId || null;
  }
  async waitFor(sel, timeout = 10000) {
    const until = Date.now() + timeout;
    for (;;) {
      const hit = await this.find(sel);
      if (hit) return hit;
      if (Date.now() > until) return null;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  // A real mouse click at the element's centre; an element with no layout box still gets a DOM click.
  async click(objectId) {
    try { await this.send('DOM.scrollIntoViewIfNeeded', { objectId }); } catch {}
    let box = null;
    try { box = (await this.send('DOM.getBoxModel', { objectId })).model; } catch {}
    if (!box) { await this.callOn(objectId, 'function () { this.click(); }'); return 'dom'; }
    const c = box.content;
    const x = (c[0] + c[2] + c[4] + c[6]) / 4, y = (c[1] + c[3] + c[5] + c[7]) / 4;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    return 'mouse';
  }
  async type(objectId, text) {
    await this.callOn(objectId, 'function () { this.focus(); if ("value" in this) this.value = ""; }');
    await this.send('Input.insertText', { text });
  }
  async key(name) {
    const k = KEYS[name];
    if (!k) throw err(`unsupported key ${name}; one of ${Object.keys(KEYS).join(', ')}`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  // prop: text (default) | value | href | attr:<name>
  readText(objectId, prop = 'text') {
    return this.callOn(objectId, `function (p) {
      if (p === 'value') return this.value === undefined ? null : String(this.value);
      if (p === 'href') return this.href === undefined ? this.getAttribute('href') : String(this.href);
      if (p && p.indexOf('attr:') === 0) return this.getAttribute(p.slice(5));
      return String(this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim();
    }`, [prop]);
  }
  readAll(css, fields) { return this.evaluate(`${ROWS}(${q(css)}, ${fields ? q(fields) : 'null'})`); }
  candidates(limit = 10) { return this.evaluate(`${CANDIDATES}(${Number(limit) || 10})`); }
  tree(selector, limit = 60) { return this.evaluate(`${TREE}(${selector ? q(selector) : 'null'}, ${Number(limit) || 60})`); }
  url() { return this.evaluate('location.href'); }
  title() { return this.evaluate('document.title'); }

  async close() {
    try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000); } catch {}
    if (this.proc) { try { await this.conn.send('Browser.close', {}, undefined, 5000); } catch {} }
    try { this.conn.ws.close(); } catch {}
    if (this.proc) {
      try { this.proc.stderr?.destroy(); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc.unref();
    }
  }
}

// DECLICK_CDP=ws://... or http://127.0.0.1:9222 reuses a browser the human is already logged into.
async function attachUrl(target) {
  if (target.startsWith('ws://') || target.startsWith('wss://')) return target;
  const base = target.replace(/\/+$/, '');
  const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5000) }).catch(e => { throw err(`cannot reach ${base}: ${e.message}`); });
  const j = await r.json().catch(() => ({}));
  if (!j.webSocketDebuggerUrl) throw err(`${base}/json/version has no webSocketDebuggerUrl; start Chrome with --remote-debugging-port`);
  return j.webSocketDebuggerUrl;
}

// One page, launched headless or attached to a running browser. Always close() it, including on failure.
export async function open({ url } = {}) {
  const attach = process.env.DECLICK_CDP;
  const { proc, url: ws } = attach ? { proc: null, url: await attachUrl(attach) } : await launch();
  let conn;
  try { conn = await connect(ws); } catch (e) { if (proc) { try { proc.kill(); } catch {} } throw e; }
  let page;
  try {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    page = new Page(conn, sessionId, targetId, proc);
    await page.send('Page.enable');
    await page.send('DOM.enable');
    await page.send('Runtime.enable');
  } catch (e) {
    try { conn.ws.close(); } catch {}
    if (proc) { try { proc.kill(); } catch {} }
    throw e;
  }
  if (url) { try { await page.navigate(url); } catch (e) { await page.close(); throw e; } }
  return page;
}
