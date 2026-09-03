// One deskclaw snapshot line: <indent>@eN Type "Name" [x,y] followed by the fixed-order attribute tail
// (value, toggle, selected, enabled, expanded, offscreen, popup). The tail is matched strictly so a name
// or a value that happens to contain `" [1,2]` cannot be mistaken for the coordinates.
const ATTR = '(?: [a-z]+=(?:"(?:[^"\\\\]|\\\\.)*"|[A-Za-z]+))*';
const LINE = new RegExp(`^(\\s*)(@e\\d+) (\\S+) "(.*)" \\[(-?\\d+),(-?\\d+)\\](${ATTR})\\s*$`);
const PAIR = /([a-z]+)=("(?:[^"\\]|\\.)*"|[A-Za-z]+)/g;
const BOOLS = new Set(['selected', 'enabled', 'expanded', 'offscreen']);

// The array carries .offscreen: the "# offscreen=N" trailer, so "no Save button" and "the Save button is
// offscreen" stay different answers.
export function parseSnapshot(text) {
  const out = []; let offscreen = 0;
  for (const line of text.split(/\r?\n/)) {
    const trailer = /^#\s*offscreen=(\d+)\s*$/.exec(line);
    if (trailer) { offscreen = Number(trailer[1]); continue; }
    const m = LINE.exec(line);
    if (!m) continue;
    const el = { ref: m[2], depth: m[1].length / 2, type: m[3], name: m[4], x: Number(m[5]), y: Number(m[6]) };
    for (const [, k, raw] of m[7].matchAll(PAIR)) {
      const v = raw.startsWith('"') ? JSON.parse(raw) : raw;
      el[k] = BOOLS.has(k) ? v === 'true' : v;
    }
    out.push(el);
  }
  out.offscreen = offscreen;
  return out;
}

function segMatch(el, seg) {
  const i = seg.indexOf(':');
  const type = seg.slice(0, i), name = seg.slice(i + 1);
  if (type !== '*' && el.type !== type) return false;
  if (name === '*') return true;
  if (name.endsWith('*')) return el.name.startsWith(name.slice(0, -1));
  return el.name === name;
}

const endOf = (els, i) => { let j = i + 1; while (j < els.length && els[j].depth > els[i].depth) j++; return j; };

// Depth-first with backtracking: a segment that matches a node whose subtree cannot satisfy the
// rest of the path is abandoned and the next candidate is tried. First full match in tree order wins.
export function findByPath(els, path) {
  const search = (from, to, k) => {
    for (let i = from; i < to; i++) {
      if (!segMatch(els[i], path[k])) continue;
      if (k === path.length - 1) return els[i];
      const hit = search(i + 1, endOf(els, i), k + 1);
      if (hit) return hit;
    }
    return null;
  };
  return path.length ? search(0, els.length, 0) : null;
}

// Every element the path matches, in tree order: the rows of a list, not just its first row.
export function findAll(els, path) {
  const out = [];
  const walk = (from, to, k) => {
    for (let i = from; i < to; i++) {
      if (!segMatch(els[i], path[k])) continue;
      if (k === path.length - 1) { if (!out.includes(els[i])) out.push(els[i]); }
      else walk(i + 1, endOf(els, i), k + 1);
    }
  };
  if (path.length) walk(0, els.length, 0);
  return out;
}

// The element and its descendants, which is the scope a read-all field path is resolved in.
export function subtreeOf(els, el) { const i = els.indexOf(el); return i < 0 ? [] : els.slice(i, endOf(els, i)); }

const distance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

// What an agent should have written instead of the path that missed: how far the path got, everything
// under the deepest ancestor that did resolve, then the nearest names from anywhere in the tree. This is
// the whole point of the engine: a miss is answered with the real elements, never with a screenshot.
export function candidates(els, path, { under = 10, near = 5 } = {}) {
  let depth = 0, anc = null;
  for (let k = 1; k <= path.length; k++) { const hit = findByPath(els, path.slice(0, k)); if (!hit) break; anc = hit; depth = k; }
  const i = anc ? els.indexOf(anc) : -1;
  const scope = i < 0 ? els : els.slice(i + 1, endOf(els, i));
  const brief = e => ({ ref: e.ref, type: e.type, name: e.name });
  const list = scope.slice(0, under).map(brief);
  const seen = new Set(list.map(e => e.ref));
  const seg = path[depth] || '';
  const want = seg.slice(seg.indexOf(':') + 1).replace(/\*$/, '');
  const rest = els.filter(e => !seen.has(e.ref) && e.name)
    .map(e => [e, distance(want, e.name)]).sort((a, b) => a[1] - b[1]).slice(0, near).map(([e]) => brief(e));
  return { resolved: path.slice(0, depth), candidates: [...list, ...rest] };
}

export function treeDiff(recorded, live) {
  const key = e => `${e.type}:${e.name}`;
  const a = new Set(recorded.map(key)), b = new Set(live.map(key));
  return { missing: [...a].filter(k => !b.has(k)), added: [...b].filter(k => !a.has(k)) };
}
