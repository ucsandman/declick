const LINE = /^(\s*)(@e\d+) (\S+) "(.*)" \[(-?\d+),(-?\d+)\]\s*$/;

export function parseSnapshot(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({ ref: m[2], depth: m[1].length / 2, type: m[3], name: m[4], x: Number(m[5]), y: Number(m[6]) });
  }
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

// Depth-first with backtracking: a segment that matches a node whose subtree cannot satisfy the
// rest of the path is abandoned and the next candidate is tried. First full match in tree order wins.
export function findByPath(els, path) {
  const subtreeEnd = i => { let j = i + 1; while (j < els.length && els[j].depth > els[i].depth) j++; return j; };
  const search = (from, to, k) => {
    for (let i = from; i < to; i++) {
      if (!segMatch(els[i], path[k])) continue;
      if (k === path.length - 1) return els[i];
      const hit = search(i + 1, subtreeEnd(i), k + 1);
      if (hit) return hit;
    }
    return null;
  };
  return path.length ? search(0, els.length, 0) : null;
}

export function treeDiff(recorded, live) {
  const key = e => `${e.type}:${e.name}`;
  const a = new Set(recorded.map(key)), b = new Set(live.map(key));
  return { missing: [...a].filter(k => !b.has(k)), added: [...b].filter(k => !a.has(k)) };
}
