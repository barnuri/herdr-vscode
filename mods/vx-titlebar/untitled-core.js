// Untitled buffers (VS Code's "Untitled-N"): their names and where Save As writes them. Pure.
export const UNTITLED_PREFIX = "Untitled-";
export const SAVE_AS_KEY = "vx.untitled.saveas";
export const UNTITLED_COUNTER_KEY = "vx.untitled.next";
const UNTITLED_NAME = /^Untitled-(\d+)$/;
const FOLDER_ONLY = new Set(["~", ".", ".."]);

export const isUntitledName = (name) => UNTITLED_NAME.test(String(name ?? ""));

// The dirty marker an untitled buffer shares in shared("vx.dirty").
export const untitledDirtyKey = (name) => `untitled:${name}`;

// The next free number: past the window's counter and every Untitled-N tab still open.
export function nextUntitledNumber(tabNames, counter = 0) {
  const open = tabNames.map((name) => Number(UNTITLED_NAME.exec(String(name ?? ""))?.[1] ?? 0));
  return Math.max(counter, ...open, 0) + 1;
}

function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

// The Save As answer as { path, dir, name }, or { error }. "~/x" is in home; a relative path is in
// `folder` (the active repo); "." and ".." are resolved.
export function resolveSaveAs(answer, folder, home) {
  const text = String(answer ?? "").trim();
  if (!text) {
    return { error: "Type a file name." };
  }
  if (text.endsWith("/") || FOLDER_ONLY.has(text)) {
    return { error: "That is a folder: add a file name." };
  }
  let absolute = text;
  if (text === "~" || text.startsWith("~/")) {
    absolute = `${home}${text.slice(1)}`;
  } else if (!text.startsWith("/")) {
    absolute = `${folder || home}/${text}`;
  }
  const path = normalize(absolute);
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  if (!name) {
    return { error: "That is a folder: add a file name." };
  }
  return { path, dir: path.slice(0, cut) || "/", name };
}
