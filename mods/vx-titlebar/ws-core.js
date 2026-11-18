// The workspace model: which folders a workspace has, and which repo a mod should show.

const MAX_RELATIVE_LEVELS_UP = 2;
const WORKSPACE_EXTENSION = /\.code-workspace$/;

export const baseName = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || "/";
export const parentOf = (path) => {
  const trimmed = String(path ?? "").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
};

// An absolute path with "." and ".." folded away. `rel` may itself be absolute.
export function resolvePath(base, rel) {
  const relative = String(rel ?? "");
  const parts = relative.startsWith("/") ? [] : String(base ?? "/").split("/");
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (parts.length > 1) {
        parts.pop();
      }
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  const out = parts.filter((part, index) => part || index === 0).join("/");
  return out.startsWith("/") ? out : `/${out}`;
}

const rootName = (folder, path) => (typeof folder.name === "string" && folder.name ? folder.name : baseName(path));

// A parsed .code-workspace file as roots, in the file's order. Paths are relative to the file.
export function rootsFromWorkspace(file, json) {
  const dir = parentOf(file);
  const seen = new Set();
  const roots = [];
  for (const folder of Array.isArray(json?.folders) ? json.folders : []) {
    if (!folder || typeof folder.path !== "string") {
      continue;
    }
    const path = resolvePath(dir, folder.path);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    roots.push({ name: rootName(folder, path), path });
  }
  return roots;
}

export const workspaceName = (file) => baseName(file).replace(WORKSPACE_EXTENSION, "");

// The workspace root holding `cwd` (the deepest, for nested roots), or null.
export function rootFor(cwd, roots) {
  if (!cwd) {
    return null;
  }
  const holding = (roots ?? []).filter((root) => cwd === root.path || cwd.startsWith(`${root.path}/`));
  return holding.reduce((best, root) => (!best || root.path.length > best.path.length ? root : best), null);
}

/**
 * Which folder a mod shows, and why.
 * focus: { cwd, branch, on } for the focused terminal (cwd null for a mod pane or none).
 * active: { root, on, name, by } -- by "pick" when you chose it (a panel's repo switcher, a
 * click in Files); vx-workspace turns a pick into "click" as soon as focus moves elsewhere.
 * Rules, first that applies:
 *   0. a repo you just picked                           -> that repo      ("picked")
 *   1. the focused terminal is inside a workspace root  -> that root      ("root")
 *   2. the focused terminal is inside some other repo   -> its folder     ("repo")
 *   3. the repo picked earlier                          -> that repo      ("active")
 *   4. the focused terminal's folder, else the space's  -> that folder    ("focus" | "space")
 */
export function chooseContext({ focus, roots, active, spaceFolder }) {
  const on = focus?.on ?? null;
  const cwd = focus?.cwd ?? null;
  const activeContext = (source) => ({ cwd: active.root, on: active.on ?? null, source, root: rootFor(active.root, roots) });
  if (active?.root && active.by === "pick") {
    return activeContext("picked");
  }
  const root = on === null ? rootFor(cwd, roots) : null;
  if (root) {
    return { cwd: root.path, on: null, source: "root", root };
  }
  if (cwd && focus?.branch) {
    return { cwd, on, source: "repo", root: null };
  }
  if (active?.root) {
    return activeContext("active");
  }
  if (cwd) {
    return { cwd, on, source: "focus", root: null };
  }
  return { cwd: spaceFolder ?? null, on: null, source: "space", root: null };
}

export const contextKey = (context) => JSON.stringify([context?.cwd ?? null, context?.on ?? null]);

// `to` relative to `fromDir` ("../x"), for folders written into a workspace file.
export function relativePath(fromDir, to) {
  const from = resolvePath("/", fromDir).split("/").filter(Boolean);
  const target = resolvePath("/", to).split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) {
    common++;
  }
  const up = from.slice(common).map(() => "..");
  return [...up, ...target.slice(common)].join("/") || ".";
}

// A folder as VS Code writes it: relative to the file when that's no more than two levels up,
// absolute otherwise; `name` only when it differs from the folder's own name.
export function folderEntry(fileDir, path, name) {
  const rel = relativePath(fileDir, path);
  const levelsUp = rel.split("/").filter((part) => part === "..").length;
  const entry = { path: levelsUp > MAX_RELATIVE_LEVELS_UP ? path : rel };
  if (name && name !== baseName(path)) {
    entry.name = name;
  }
  return entry;
}

function renameFolder(folder, path, name) {
  const renamed = { ...folder };
  if (name && name !== baseName(path)) {
    renamed.name = name;
  } else {
    delete renamed.name;
  }
  return renamed;
}

function applyFolderEdit(folders, fileDir, op) {
  const indexOf = (path) => folders.findIndex((folder) => typeof folder?.path === "string" && resolvePath(fileDir, folder.path) === path);
  if (op.type === "add") {
    for (const path of op.paths) {
      if (indexOf(path) < 0) {
        folders.push(folderEntry(fileDir, path));
      }
    }
    return;
  }
  const index = indexOf(op.path);
  if (index < 0) {
    return;
  }
  if (op.type === "remove") {
    folders.splice(index, 1);
  } else if (op.type === "rename") {
    folders[index] = renameFolder(folders[index], op.path, op.name);
  } else if (op.type === "move") {
    const [folder] = folders.splice(index, 1);
    folders.splice(Math.max(0, Math.min(folders.length, op.to)), 0, folder);
  }
}

// One edit to a parsed workspace file; folders are matched by their resolved path.
//   { type: "add", paths }  { type: "remove", path }  { type: "rename", path, name }
//   { type: "move", path, to }   (to: the new index)
export function editFolders(json, fileDir, op) {
  const folders = [...(Array.isArray(json?.folders) ? json.folders : [])];
  applyFolderEdit(folders, fileDir, op);
  return { ...json, folders };
}

// VS Code writes workspace files with tabs.
export const stringifyWorkspace = (json) => `${JSON.stringify(json, null, "\t")}\n`;

export const newWorkspace = (fileDir, paths) => ({ folders: paths.map((path) => folderEntry(fileDir, path)), settings: {} });
