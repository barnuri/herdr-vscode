// Go to File (⌘P): rank workspace files for a query, VS Code-style. Pure: tested under node.
// A file matches when the query's characters appear in order in its path; a contiguous hit in
// the file name ranks first, then in the path, then scattered ones (fewer gaps first).

export function scorePath(path, query) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const slash = p.lastIndexOf("/");
  const name = p.slice(slash + 1);
  const inName = name.indexOf(q);
  if (inName >= 0) return 10000 - (inName === 0 ? 0 : 500) - name.length - p.length / 100;
  const inPath = p.indexOf(q);
  if (inPath >= 0) return 5000 - p.length;
  let at = -1;
  let gaps = 0;
  let nameHits = 0;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (next !== at + 1) gaps++;
    if (next > slash) nameHits++;
    at = next;
  }
  return 1000 + nameHits * 10 - gaps * 25 - p.length / 10;
}

// items: [{ root, rel }] -> best `limit` matches, highest score first.
export function rankFiles(items, query, limit = 60) {
  const out = [];
  for (const it of items) {
    const s = scorePath(it.rel, query);
    if (s >= 0) out.push({ ...it, score: s });
  }
  return out.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length).slice(0, limit);
}
