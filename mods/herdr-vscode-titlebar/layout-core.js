export function findNode(node, id) {
  if (!node) {
    return null;
  }
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) {
      return hit;
    }
  }
  return null;
}

// A deep copy of `tree` where the node `id` has `content` (null when there's no such node).
export function withContent(tree, id, content) {
  let found = false;
  const walk = (node) => {
    const copy = { ...node };
    if (node.id === id) {
      copy.content = content;
      found = true;
    }
    if (Array.isArray(node.children)) {
      copy.children = node.children.map(walk);
    }
    return copy;
  };
  const out = walk(tree);
  return found ? out : null;
}

// A deep copy of `tree` with child `childId` of node `parentId` moved first ("left") or last
// ("right"); null when nothing moves.
export function withChildAt(tree, parentId, childId, side) {
  const parent = findNode(tree, parentId);
  const kids = parent?.children ?? [];
  const index = kids.findIndex((child) => child.id === childId);
  if (index < 0 || (side === "left" ? index === 0 : index === kids.length - 1)) {
    return null;
  }
  const others = kids.filter((child) => child.id !== childId);
  const ordered = side === "left" ? [kids[index], ...others] : [...others, kids[index]];
  const walk = (node) => {
    const copy = { ...node };
    if (node.id === parentId) {
      copy.children = ordered;
    } else if (Array.isArray(node.children)) {
      copy.children = node.children.map(walk);
    }
    return copy;
  };
  return walk(tree);
}
