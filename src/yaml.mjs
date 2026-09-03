// Dependency-free YAML subset parser for OpenAPI specs: block/flow mappings and sequences,
// plain/quoted scalars, literal/folded block scalars, comments, anchors/aliases/merge keys.
// No eval, no dynamic property access from untrusted keys that could touch a prototype.

const stripLineComment = (raw) => {
  let inS = false, inD = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === '\\') { i++; continue; } if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
};
const indentOf = (line) => { let k = 0; while (k < line.length && line[k] === ' ') k++; return k; };

const ESC = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0', b: '\b', f: '\f', '/': '/', ' ': ' ' };
function parseDoubleAt(s, start) {
  let p = start + 1, out = '';
  while (p < s.length) {
    const c = s[p];
    if (c === '"') return { value: out, end: p + 1 };
    if (c === '\\') {
      const nx = s[p + 1];
      if (nx === 'u') { out += String.fromCharCode(parseInt(s.slice(p + 2, p + 6), 16)); p += 6; continue; }
      out += ESC[nx] !== undefined ? ESC[nx] : nx; p += 2; continue;
    }
    out += c; p++;
  }
  throw new Error('unterminated double-quoted string');
}
function parseSingleAt(s, start) {
  let p = start + 1, out = '';
  while (p < s.length) {
    if (s[p] === "'") { if (s[p + 1] === "'") { out += "'"; p += 2; continue; } return { value: out, end: p + 1 }; }
    out += s[p]; p++;
  }
  throw new Error('unterminated single-quoted string');
}
function foldLines(lines) {
  const parts = [];
  for (const l of lines) {
    if (l === '') parts.push('\n');
    else { if (parts.length && parts[parts.length - 1] !== '\n') parts.push(' '); parts.push(l); }
  }
  return parts.join('');
}
function resolvePlain(raw) {
  if (raw === '' || raw === '~' || /^null$/i.test(raw)) return null;
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  if (/^[-+]?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/[.eE]/.test(raw) && /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(raw)) return parseFloat(raw);
  return raw;
}

export function parseYaml(text) {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const n = rawLines.length;
  const anchors = Object.create(null);
  const pos = { i: 0 };
  const lineNo = (i) => i + 1;
  const err = (msg, idx) => { throw new Error(`yaml parse error at line ${lineNo(idx)}: ${msg}`); };

  // skip a leading `---` document-start marker; everything after a later one is a second document we don't parse.
  { let j = 0; while (j < n && (rawLines[j].trim() === '' || rawLines[j].trim().startsWith('#'))) j++;
    pos.i = j < n && stripLineComment(rawLines[j]).trim() === '---' ? j + 1 : 0; }

  function peek() {
    let j = pos.i;
    while (j < n) {
      const t = rawLines[j].trim();
      if (t === '' || t.startsWith('#')) { j++; continue; }
      if (t === '---' || t === '...') return -1;
      return j;
    }
    return -1;
  }
  const contentAt = (idx) => { const s = stripLineComment(rawLines[idx]); const indent = indentOf(s); return { indent, text: s.slice(indent).replace(/\s+$/, '') }; };
  const guardTag = (text, idx) => {
    if (text === '?' || text.startsWith('? ')) err('complex mapping keys (?) are not supported', idx);
    if (text[0] === '!') err('YAML tags are not supported', idx);
  };
  function setKey(obj, key, value, idx) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') err(`unsafe key ${JSON.stringify(key)}`, idx);
    if (key === '<<') { for (const s of Array.isArray(value) ? value : [value]) if (s && typeof s === 'object') for (const k of Object.keys(s)) if (!(k in obj)) obj[k] = s[k]; return; }
    obj[key] = value;
  }
  function splitKeyValue(text, idx) {
    if (text[0] === '{' || text[0] === '[') return null;
    if (text[0] === '"' || text[0] === "'") {
      const r = (text[0] === '"' ? parseDoubleAt : parseSingleAt)(text, 0);
      let p = r.end; while (text[p] === ' ') p++;
      if (text[p] !== ':') return null;
      p++; while (text[p] === ' ') p++;
      return { key: r.value, rest: text.slice(p) };
    }
    const m = /^([^:\s][^:]*?):(\s+(.*)|$)/.exec(text);
    return m ? { key: m[1], rest: (m[3] || '').trim() } : null;
  }
  function parseFlow(s, idx) {
    let p = 0;
    const skipWs = () => { while (p < s.length && /\s/.test(s[p])) p++; };
    function value() {
      skipWs();
      const c = s[p];
      if (c === '{') return map();
      if (c === '[') return seq();
      if (c === '"' || c === "'") { const r = (c === '"' ? parseDoubleAt : parseSingleAt)(s, p); p = r.end; return r.value; }
      const start = p; while (p < s.length && !',]}'.includes(s[p])) p++;
      return resolvePlain(s.slice(start, p).trim());
    }
    function seq() {
      p++; const arr = []; skipWs();
      if (s[p] === ']') { p++; return arr; }
      while (true) {
        arr.push(value()); skipWs();
        if (s[p] === ',') { p++; skipWs(); if (s[p] === ']') { p++; break; } continue; }
        if (s[p] === ']') { p++; break; }
        err('expected , or ] in flow sequence', idx);
      }
      return arr;
    }
    function map() {
      p++; const obj = {}; skipWs();
      if (s[p] === '}') { p++; return obj; }
      while (true) {
        skipWs();
        let key;
        if (s[p] === '"' || s[p] === "'") { const r = (s[p] === '"' ? parseDoubleAt : parseSingleAt)(s, p); p = r.end; key = r.value; }
        else { const start = p; while (p < s.length && s[p] !== ':') p++; key = s.slice(start, p).trim(); }
        skipWs(); if (s[p] !== ':') err('expected : in flow mapping', idx); p++;
        setKey(obj, key, value(), idx); skipWs();
        if (s[p] === ',') { p++; skipWs(); if (s[p] === '}') { p++; break; } continue; }
        if (s[p] === '}') { p++; break; }
        err('expected , or } in flow mapping', idx);
      }
      return obj;
    }
    return value();
  }
  function parseBlockScalar(s, idx, parentIndent) {
    const style = s[0]; let chomp = 'clip', explicitIndent = null;
    for (const ch of s.slice(1)) {
      if (ch === '-') chomp = 'strip'; else if (ch === '+') chomp = 'keep';
      else if (/[0-9]/.test(ch)) explicitIndent = parentIndent + Number(ch);
      else err(`bad block scalar header ${JSON.stringify(s)}`, idx);
    }
    const raw = []; let bodyIndent = explicitIndent;
    while (pos.i < n) {
      const line = rawLines[pos.i];
      if (line.trim() === '') { raw.push(''); pos.i++; continue; }
      const ind = indentOf(line);
      if (bodyIndent === null) { if (ind <= parentIndent) break; bodyIndent = ind; }
      if (ind < bodyIndent) break;
      raw.push(line.slice(bodyIndent)); pos.i++;
    }
    let trailingBlanks = 0;
    while (raw.length && raw[raw.length - 1] === '') { raw.pop(); trailingBlanks++; }
    const body = style === '>' ? foldLines(raw) : raw.join('\n');
    if (chomp === 'strip') return body;
    if (chomp === 'keep') return body + '\n'.repeat(trailingBlanks + 1);
    return raw.length ? body + '\n' : '';
  }
  function parseValueToken(s, idx, parentIndent) {
    if (s[0] === '&') {
      const m = /^&(\S+)\s*(.*)$/.exec(s); const [, name, remainder] = m;
      const val = remainder === '' ? nestedOrNull(parentIndent) : parseValueToken(remainder, idx, parentIndent);
      anchors[name] = val; return val;
    }
    if (s[0] === '*') { const name = s.slice(1).trim(); if (!(name in anchors)) err(`unknown alias *${name}`, idx); return anchors[name]; }
    if (s[0] === '|' || s[0] === '>') return parseBlockScalar(s, idx, parentIndent);
    if (s[0] === '{' || s[0] === '[') return parseFlow(s, idx);
    if (s[0] === '"' || s[0] === "'") return (s[0] === '"' ? parseDoubleAt : parseSingleAt)(s, 0).value;
    if (s[0] === '!') err('YAML tags are not supported', idx);
    return resolvePlain(s);
  }
  const nestedOrNull = (minIndent) => { const v = parseNode(minIndent + 1); return v === undefined ? null : v; };
  function parseValueAfter(rest, idx, keyIndent) { return rest === '' ? nestedOrNull(keyIndent) : parseValueToken(rest, idx, keyIndent); }

  function parseSeq(indent) {
    const arr = [];
    while (true) {
      const idx = peek(); if (idx === -1) break;
      const { indent: ind, text } = contentAt(idx);
      if (ind !== indent || !(text === '-' || text.startsWith('- '))) break;
      pos.i = idx + 1;
      const rest = text === '-' ? '' : text.slice(2);
      if (rest === '') { arr.push(nestedOrNull(indent)); continue; }
      guardTag(rest, idx);
      const kv = splitKeyValue(rest, idx);
      arr.push(kv ? parseMapBody(indent + 2, { key: kv.key, rest: kv.rest, idx }) : parseValueToken(rest, idx, indent + 2));
    }
    return arr;
  }
  function parseMapBody(indent, first) {
    const obj = {}; let pending = first;
    while (true) {
      let key, rest, idx;
      if (pending) { ({ key, rest, idx } = pending); pending = null; }
      else {
        const pidx = peek(); if (pidx === -1) break;
        const c = contentAt(pidx); if (c.indent !== indent) break;
        guardTag(c.text, pidx);
        const kv = splitKeyValue(c.text, pidx); if (!kv) break;
        pos.i = pidx + 1; key = kv.key; rest = kv.rest; idx = pidx;
      }
      setKey(obj, key, parseValueAfter(rest, idx, indent), idx);
    }
    return obj;
  }
  function parseNode(minIndent) {
    const idx = peek(); if (idx === -1) return null;
    const { indent, text } = contentAt(idx);
    if (indent < minIndent) return undefined;
    guardTag(text, idx);
    if (text === '-' || text.startsWith('- ')) return parseSeq(indent);
    if (splitKeyValue(text, idx)) return parseMapBody(indent, null);
    pos.i = idx + 1;
    return parseValueToken(text, idx, indent);
  }

  const root = parseNode(0);
  return root === undefined ? null : root;
}

// Path-like strings (no newline) go by extension; raw text goes by whether it looks like JSON.
export function isYaml(pathOrText) {
  const s = String(pathOrText);
  if (!/\n/.test(s) && /\.(ya?ml)$/i.test(s)) return true;
  if (!/\n/.test(s) && /\.json$/i.test(s)) return false;
  return !s.trim().startsWith('{') && !s.trim().startsWith('[');
}
