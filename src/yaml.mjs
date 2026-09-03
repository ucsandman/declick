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
  // Quoted scalars normally close on the same line `s` came from; `idx` (the rawLines index of
  // `s`) is optional and, when given, lets the scan continue into rawLines[idx+1...] (raw, never
  // comment-stripped: a `#` inside an open quote is literal) so a quote left open at end-of-line
  // keeps scanning instead of throwing. Folding across lines follows the block-scalar rule: a
  // blank line becomes a newline, anything else joins with a single space (foldLines).
  function scanQuoted(s, start, idx, q) {
    const decodeLine = (text, from) => {
      let p = from, out = '';
      while (p < text.length) {
        const c = text[p];
        if (c === q) {
          if (q === "'" && text[p + 1] === "'") { out += "'"; p += 2; continue; }
          return { decoded: out, closedAt: p + 1 };
        }
        if (q === '"' && c === '\\') {
          const nx = text[p + 1];
          if (nx === 'u') { out += String.fromCharCode(parseInt(text.slice(p + 2, p + 6), 16)); p += 6; continue; }
          out += ESC[nx] !== undefined ? ESC[nx] : nx; p += 2; continue;
        }
        out += c; p++;
      }
      return { decoded: out, closedAt: null };
    };
    const kind = q === '"' ? 'double' : 'single';
    const first = decodeLine(s, start + 1);
    if (first.closedAt !== null) return { value: first.decoded, end: first.closedAt, endLine: idx };
    if (idx === undefined || idx === null) throw new Error(`unterminated ${kind}-quoted string`);
    const chunks = [first.decoded];
    let li = idx;
    while (true) {
      li++;
      if (li >= n) err(`unterminated ${kind}-quoted string`, idx);
      const line = rawLines[li].replace(/^ +/, '').replace(/\s+$/, '');
      const seg = decodeLine(line, 0);
      chunks.push(seg.decoded);
      if (seg.closedAt !== null) return { value: foldLines(chunks), end: seg.closedAt, endLine: li };
    }
  }
  function parseDoubleAt(s, start, idx) { return scanQuoted(s, start, idx, '"'); }
  function parseSingleAt(s, start, idx) { return scanQuoted(s, start, idx, "'"); }
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
    // A plain key may itself contain ':' (OAuth scopes like write:pets, read:pets); per YAML
    // the split point is the FIRST colon that is followed by whitespace or end-of-line, not the
    // first colon anywhere. A leading ':' or whitespace means this line isn't a mapping entry.
    if (text[0] === ':' || /\s/.test(text[0])) return null;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
        return { key: text.slice(0, i), rest: text.slice(i + 1).trim() };
      }
    }
    return null;
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
        else {
          // Same rule as splitKeyValue's plain-key scan, adapted to flow terminators: the key ends
          // at the first ':' followed by whitespace, ',', '}' or end-of-input; a ':' followed by
          // anything else (OAuth scopes like write:pets) is part of the key, not the delimiter.
          const start = p;
          while (p < s.length && !(s[p] === ':' && (p + 1 === s.length || /[\s,}]/.test(s[p + 1])))) p++;
          key = s.slice(start, p).trim();
        }
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
      const val = remainder === '' ? parseValueAfter('', idx, parentIndent) : parseValueToken(remainder, idx, parentIndent);
      anchors[name] = val; return val;
    }
    if (s[0] === '*') { const name = s.slice(1).trim(); if (!(name in anchors)) err(`unknown alias *${name}`, idx); return anchors[name]; }
    if (s[0] === '|' || s[0] === '>') return parseBlockScalar(s, idx, parentIndent);
    if (s[0] === '{' || s[0] === '[') return parseFlow(s, idx);
    if (s[0] === '"' || s[0] === "'") {
      const r = (s[0] === '"' ? parseDoubleAt : parseSingleAt)(s, 0, idx);
      pos.i = r.endLine + 1;
      return r.value;
    }
    if (s[0] === '!') err('YAML tags are not supported', idx);
    // a plain (unquoted) scalar can fold onto following lines indented deeper than its own
    // key/item (same rule as `>` block scalars); a key with inline content can't also start a
    // nested block, so any such line here is continuation, not a sibling entry.
    const cont = [];
    while (pos.i < n) {
      const line = rawLines[pos.i];
      if (line.trim() === '') { cont.push(''); pos.i++; continue; }
      const t = stripLineComment(line).trim();
      if (t === '---' || t === '...') break;
      if (indentOf(line) <= parentIndent) break;
      cont.push(t); pos.i++;
    }
    while (cont.length && cont[cont.length - 1] === '') cont.pop();
    return cont.length ? foldLines([s, ...cont]) : resolvePlain(s);
  }
  const nestedOrNull = (minIndent) => { const v = parseNode(minIndent + 1); return v === undefined ? null : v; };
  function parseValueAfter(rest, idx, keyIndent) {
    if (rest !== '') return parseValueToken(rest, idx, keyIndent);
    // a block sequence may sit at the SAME indent as the mapping key it belongs to
    // (PyYAML/Kubernetes default style); check for that before falling back to nested-deeper lookup.
    const nidx = peek();
    if (nidx !== -1) {
      const c = contentAt(nidx);
      if (c.indent === keyIndent && (c.text === '-' || c.text.startsWith('- '))) return parseSeq(keyIndent);
    }
    return nestedOrNull(keyIndent);
  }

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
      arr.push(kv ? parseMapBody(indent + 2, { key: kv.key, rest: kv.rest, idx }) : parseValueToken(rest, idx, indent));
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
