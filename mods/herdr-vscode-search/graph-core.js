// Commit-graph lanes, like `git log --graph`, from commits newest first ({ hash, parents }).
// Per row: col, top/bottom (cols with a line above/below), span (the joint's [min, max]), joined, forks.
import { splitRecords } from "./git-core.js";

export const GRAPH_FORMAT = "--format=%H%x00%P%x00%D%x00%an%x00%at%x00%s%x1e";

const REF_KINDS = [
  { prefix: "HEAD -> ", kind: "head" },
  { prefix: "tag: ", kind: "tag" },
];

export function parseGraphLog(stdout) {
  return splitRecords(stdout).map(([hash, parents, refs, author, at, subject]) => ({
    hash,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    refs: refs ? refs.split(", ").map((ref) => ref.trim()).filter(Boolean) : [],
    author,
    at: Number(at),
    subject,
  }));
}

function refLabel(ref) {
  const prefixed = REF_KINDS.find(({ prefix }) => ref.startsWith(prefix));
  if (prefixed) {
    return { kind: prefixed.kind, name: ref.slice(prefixed.prefix.length) };
  }
  if (ref === "HEAD") {
    return { kind: "head", name: "HEAD" };
  }
  if (ref.includes("/") && !ref.startsWith("refs/")) {
    return { kind: "remote", name: ref };
  }
  return { kind: "branch", name: ref };
}

// "HEAD -> main", "origin/main", "tag: v1" -> labels with a kind for colouring.
export function refLabels(refs) {
  return refs.map(refLabel);
}

const occupiedColumns = (lanes) => lanes.map((hash, index) => (hash ? index : -1)).filter((index) => index >= 0);

export function layoutGraph(commits) {
  // The commit each column is waiting for.
  const lanes = [];
  const rows = [];
  let width = 0;
  const freeColumn = () => {
    const index = lanes.indexOf(null);
    if (index >= 0) {
      return index;
    }
    lanes.push(null);
    return lanes.length - 1;
  };
  const columnFor = (parent) => {
    const existing = lanes.indexOf(parent);
    if (existing >= 0) {
      return existing;
    }
    const column = freeColumn();
    lanes[column] = parent;
    return column;
  };
  for (const commit of commits) {
    const top = occupiedColumns(lanes);
    let col = lanes.indexOf(commit.hash);
    if (col < 0) {
      col = freeColumn();
    }
    const joined = [];
    lanes.forEach((hash, index) => {
      if (hash === commit.hash && index !== col) {
        joined.push(index);
        lanes[index] = null;
      }
    });
    lanes[col] = commit.parents[0] ?? null;
    const forks = commit.parents.slice(1).map(columnFor);
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
    const bottom = occupiedColumns(lanes);
    const linked = [col, ...joined, ...forks];
    const span = [Math.min(...linked), Math.max(...linked)];
    width = Math.max(width, col + 1, ...top.map((index) => index + 1), ...bottom.map((index) => index + 1));
    rows.push({ col, top, bottom, span, joined, forks });
  }
  return { rows, width };
}
