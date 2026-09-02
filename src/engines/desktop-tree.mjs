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

export function findByPath(els, path) {
  let start = 0, parent = null;
  for (const seg of path) {
    let hit = null;
    for (let i = start; i < els.length; i++) {
      const el = els[i];
      if (parent && el.depth <= parent.depth) break;
      if (segMatch(el, seg)) { hit = el; start = i + 1; break; }
    }
    if (!hit) return null;
    parent = hit;
  }
  return parent;
}

export function treeDiff(recorded, live) {
  const key = e => `${e.type}:${e.name}`;
  const a = new Set(recorded.map(key)), b = new Set(live.map(key));
  return { missing: [...a].filter(k => !b.has(k)), added: [...b].filter(k => !a.has(k)) };
}
