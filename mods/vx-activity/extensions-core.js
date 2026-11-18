// Activity-bar extensions: any mod folder may ship vx-extension.json (see docs/extensions.md).
// Pure: manifest checks, the merge with the built-in views, badges, and the layout edit.
export const MANIFEST_FILE = "vx-extension.json";
export const VIEW_PREFIX = "ext-";
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SAFE_MOD = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const BADGE_MAX = 999;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// { manifest } or { error } for the vx-extension.json text found in mods/<folder>/.
export function parseManifest(source, folder) {
  let raw = null;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { error: `${folder}/${MANIFEST_FILE}: ${error.message}` };
  }
  if (!isObject(raw)) {
    return { error: `${folder}/${MANIFEST_FILE}: not an object` };
  }
  const id = text(raw.id);
  if (!id || !SAFE_ID.test(id)) {
    return { error: `${folder}/${MANIFEST_FILE}: "id" must be letters, digits, - or _` };
  }
  const mod = text(raw.view?.mod) ?? folder;
  if (!SAFE_MOD.test(mod)) {
    return { error: `${folder}/${MANIFEST_FILE}: "view.mod" is not a mod name` };
  }
  const name = text(raw.name) ?? id;
  return {
    manifest: {
      id,
      name,
      title: text(raw.title) ?? name,
      icon: text(raw.icon) ?? `mods/${folder}/icon.svg`,
      view: { mod, props: isObject(raw.view?.props) ? raw.view.props : {} },
      badge: text(raw.badge),
      folder,
    },
  };
}

// The built-in views, then one per extension (sorted by id; an id already taken is skipped).
export function mergeViews(builtins, manifests) {
  const taken = new Set(builtins.map((view) => view.id));
  const extensions = [];
  for (const manifest of [...manifests].sort((left, right) => left.id.localeCompare(right.id))) {
    const id = `${VIEW_PREFIX}${manifest.id}`;
    if (taken.has(id)) {
      continue;
    }
    taken.add(id);
    extensions.push({ id, icon: manifest.icon, title: manifest.title, name: manifest.name, extension: manifest });
  }
  return [...builtins, ...extensions];
}

// A shared() value as a badge: a non-empty string, or a positive number (capped at 999+).
export function badgeText(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return value > BADGE_MAX ? `${BADGE_MAX}+` : String(Math.floor(value));
  }
  return text(value);
}

export function stackChild(view) {
  return { id: view.id, type: "block", content: { mod: view.extension.view.mod, props: view.extension.view.props } };
}

// A copy of `tree` whose stack `stackId` has `child` (added, or its content brought up to date),
// or null when nothing needs to change or there is no such stack.
export function withStackChild(tree, stackId, child) {
  let changed = false;
  const walk = (node) => {
    if (node.id === stackId && Array.isArray(node.children)) {
      const at = node.children.findIndex((candidate) => candidate.id === child.id);
      if (at === -1) {
        changed = true;
        return { ...node, children: [...node.children, child] };
      }
      if (JSON.stringify(node.children[at].content) === JSON.stringify(child.content)) {
        return node;
      }
      changed = true;
      return { ...node, children: node.children.map((candidate, index) => (index === at ? { ...candidate, content: child.content } : candidate)) };
    }
    return Array.isArray(node.children) ? { ...node, children: node.children.map(walk) } : node;
  };
  const next = walk(tree);
  return changed ? next : null;
}
