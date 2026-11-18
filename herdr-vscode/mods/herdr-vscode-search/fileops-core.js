// Pure rules for Explorer file operations, remote links and auto save (no Herdr imports, so tests run them).
export const CLIPBOARD_KEY = "herdr-vscode.files.clipboard";
export const AUTOSAVE_OFF = "off";
export const AUTOSAVE_AFTER_DELAY = "afterDelay";
export const AUTOSAVE_DEFAULT = AUTOSAVE_AFTER_DELAY;
export const AUTOSAVE_DELAY_MS = 1000;

const COPY_SUFFIX = " copy";

const nameOf = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop();

function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

// "a.txt" → "a copy.txt", then "a copy 2.txt", … : the first name not in `taken`.
export function copyName(name, taken) {
  const [stem, extension] = splitExtension(name);
  let candidate = `${stem}${COPY_SUFFIX}${extension}`;
  for (let index = 2; taken.has(candidate); index++) {
    candidate = `${stem}${COPY_SUFFIX} ${index}${extension}`;
  }
  return candidate;
}

// Where a pasted entry lands in `folder` (names = what is there now).
// { skip } when nothing would change; { conflict } when it would replace a file and needs asking.
export function pastePlan(clip, folder, names) {
  const source = String(clip?.path ?? "");
  const name = nameOf(source);
  const target = `${folder}/${name}`;
  if (!source || !name) {
    return { skip: true, reason: "nothing to paste" };
  }
  if (folder === source || folder.startsWith(`${source}/`)) {
    return { skip: true, reason: "a folder can't go inside itself" };
  }
  const taken = new Set(names);
  if (target === source) {
    return clip.cut ? { skip: true, reason: "already there" } : { source, target: `${folder}/${copyName(name, taken)}`, move: false, conflict: false };
  }
  return { source, target, move: Boolean(clip.cut), conflict: taken.has(name) };
}

const encodePath = (rel) => String(rel).split("/").map(encodeURIComponent).join("/");

// "#L5" or a range: GitHub writes "#L5-L9", GitLab "#L5-9".
export function lineAnchor(provider, lines) {
  const start = lines?.start;
  if (!start) {
    return "";
  }
  const end = lines.end && lines.end > start ? lines.end : null;
  if (!end) {
    return `#L${start}`;
  }
  return provider === "gitlab" ? `#L${start}-${end}` : `#L${start}-L${end}`;
}

// The web page of `rel` at `ref` for a GitHub / GitLab remote ({ host, path }), else null.
export function fileWebUrl(remote, ref, rel, lines = null) {
  if (!remote?.host || !remote.path || !ref || !rel) {
    return null;
  }
  const provider = /github/i.test(remote.host) ? "github" : /gitlab/i.test(remote.host) ? "gitlab" : null;
  if (!provider) {
    return null;
  }
  const blob = provider === "gitlab" ? "-/blob" : "blob";
  return `https://${remote.host}/${remote.path}/${blob}/${encodePath(ref)}/${encodePath(rel)}${lineAnchor(provider, lines)}`;
}

export const autoSaveMode = (value) => (value === AUTOSAVE_OFF ? AUTOSAVE_OFF : AUTOSAVE_DEFAULT);

// Save now? Only a dirty, writable buffer in afterDelay mode, once the typing paused for `delay`
// (or at once when focus left / the tab changed).
export function autoSaveDue({ mode, dirty, writable, editedAt, now, blurred = false, delay = AUTOSAVE_DELAY_MS }) {
  if (autoSaveMode(mode) === AUTOSAVE_OFF || !dirty || !writable) {
    return false;
  }
  return blurred || now - editedAt >= delay;
}
