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
