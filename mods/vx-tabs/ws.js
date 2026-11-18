// The workspace context every vx mod shares (the Herdr side; the rules are in ws-core.js).
//   shared("vx.workspace") = { file, name, roots: [{ name, path }] }   written by vx-workspace only
//   shared("vx.active")    = { root, on, name, by, at }                 the repo picked in Workspace
//   shared("vx.changed")   = { root, at }                                someone changed a repo: reread
import { spaces, panes, focused, shared, setShared, exec, readTextFile } from "herdr";
import {
  chooseContext, contextKey, rootsFromWorkspace, workspaceName, rootFor, baseName, editFolders, stringifyWorkspace, parentOf,
} from "./ws-core.js";
import { parseJsonc, stripJsonc } from "./jsonc.js";
import { READ } from "./git-core.js";

export { contextKey, rootFor, baseName };

const WORKSPACE_KEY = "vx.workspace";
const ACTIVE_KEY = "vx.active";
const CHANGED_KEY = "vx.changed";
const SCRIPT_NAME = "vx-ws";
const FIND_WORKSPACE_SCRIPT = 'd="$1"; while :; do for f in "$d"/*.code-workspace; do [ -f "$f" ] && { printf "%s" "$f"; exit 0; }; done; [ "$d" = "$HOME" ] || [ "$d" = "/" ] || [ -z "$d" ] && exit 1; d=$(dirname "$d"); done';
const GIT_CHILDREN_SCRIPT = 'for d in "$1"/*/; do [ -e "${d}.git" ] && printf "%s\\n" "${d%/}"; done; exit 0';
// The text goes as an argument, never into the script; temp file then rename keeps the write atomic.
const WRITE_SCRIPT = 'tmp="$1.vx-tmp" && printf "%s" "$2" > "$tmp" && mv -f -- "$tmp" "$1"';

const machineOfTerminal = (terminal) => (terminal.includes("/") ? terminal.split("/")[0] : null);

// What has focus: a terminal (pane or layout block) with its folder and branch, or a mod pane.
export function focusInfo() {
  const focus = focused();
  const space = spaces().find((candidate) => candidate.id === focus?.space) ?? spaces().find((candidate) => candidate.active) ?? null;
  const machine = space?.machine ?? null;
  if (focus && focus.pane === null && focus.terminal) {
    return { cwd: focus.cwd ?? null, branch: null, on: machineOfTerminal(focus.terminal), terminal: focus.terminal, pane: null, space };
  }
  const pane = focus?.pane ? panes().find((candidate) => candidate.pane === focus.pane) ?? null : null;
  if (!pane || pane.mod || !pane.terminal) {
    return { cwd: null, branch: null, on: machine, terminal: null, pane, space };
  }
  return { cwd: pane.cwd ?? null, branch: pane.branch ?? null, on: machine, terminal: pane.terminal, pane, space };
}

export const workspace = () => shared(WORKSPACE_KEY) ?? null;
export const active = () => shared(ACTIVE_KEY) ?? null;

// The folder this mod shows, why ("root" | "repo" | "active" | "focus" | "space"), and the focus.
export function ctx() {
  const focus = focusInfo();
  return {
    ...chooseContext({ focus, roots: workspace()?.roots ?? [], active: active(), spaceFolder: focus.space?.folder ?? null }),
    focus,
  };
}

// by "pick": you chose it (wins over the focused terminal until focus moves); "focus": followed.
export function setActive(root, by = "pick") {
  const current = active();
  if (current?.root === root.path && current?.by === by) {
    return;
  }
  setShared(ACTIVE_KEY, { root: root.path, on: root.on ?? null, name: root.name, by, at: Date.now() });
}

// Tell every vx mod that a repo changed (after stage, commit, pull...).
export const bump = (root) => setShared(CHANGED_KEY, { root: root ?? null, at: Date.now() });
export const changedAt = () => shared(CHANGED_KEY)?.at ?? 0;

export const git = (args, { cwd, on = null, timeout } = {}) =>
  exec("git", [...READ, ...args], { cwd, on, ...(timeout ? { timeout } : {}) });

// The repository top for a folder, or null. Cached per copy (pass the copy's own Map).
export async function repoTop(cache, cwd, on) {
  const key = `${on ?? ""}|${cwd}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const result = await git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const top = result?.code === 0 ? result.stdout.trim() : null;
  cache.set(key, top);
  return top;
}

// The nearest *.code-workspace at or above `dir` (stopping at home), or null.
export async function findWorkspaceFile(dir) {
  if (!dir) {
    return null;
  }
  const result = await exec("sh", ["-c", FIND_WORKSPACE_SCRIPT, SCRIPT_NAME, dir]).catch(() => null);
  return result?.code === 0 && result.stdout ? result.stdout : null;
}

// A folder with no workspace file: its immediate subfolders that are git repos.
export async function folderRoots(dir) {
  const result = await exec("sh", ["-c", GIT_CHILDREN_SCRIPT, SCRIPT_NAME, dir]).catch(() => null);
  return (result?.stdout ?? "").split("\n").filter(Boolean).map((path) => ({ name: baseName(path), path }));
}

async function readWorkspaceText(file) {
  const text = await readTextFile(file);
  if (text === null) {
    throw new Error(`${file} is gone`);
  }
  return text;
}

export async function loadWorkspace(file) {
  const text = await readWorkspaceText(file);
  return { file, name: workspaceName(file), roots: rootsFromWorkspace(file, parseJsonc(text)) };
}

export async function writeText(path, text, on = null) {
  const result = await exec("sh", ["-c", WRITE_SCRIPT, "vx-write", path, text], { on });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Couldn't write ${path}`);
  }
}

// Reads the file again right before writing, so whatever VS Code saved meanwhile is kept and
// only this one edit (see ws-core editFolders) is applied on top.
export async function editWorkspaceFile(file, op) {
  const text = await readWorkspaceText(file);
  const next = editFolders(parseJsonc(text), parentOf(file), op);
  const lostComments = stripJsonc(text).replace(/\s/g, "") !== text.replace(/\s/g, "");
  await writeText(file, stringifyWorkspace(next));
  return { ws: { file, name: workspaceName(file), roots: rootsFromWorkspace(file, next) }, lostComments };
}
