// Clickable file paths in our text views: find them (links-core.js), keep the ones that exist
// (one batched `test -e` per pump, cached), and open one in the file editor at its line while the
// Explorer reveals it.

import { div } from "gpui-kit";
import { exec, appHome, shared, setShared } from "herdr";
import { ctx, workspace, repoTop, setActive, baseName } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { findPathLinks, parseLinkTarget, pathCandidates, splitRoot, splitRunsAtLinks } from "./links-core.js";
import { parentOf } from "./ws-core.js";

export const REVEAL_KEY = "herdr-vscode.reveal";
const FILES_MOD = "herdr-vscode-files";
const CACHE_MS = 30000;
const MAX_BATCH = 200;
// Prints the arguments that exist; paths travel as arguments, never as script.
const EXISTS = 'for p; do [ -e "$p" ] && printf "%s\\n" "$p"; done; exit 0';

const known = new Map();
const queue = new Set();
const tops = new Map();
let pumping = false;

// ~/.config/herdr-app -> ~
const home = () => parentOf(parentOf(appHome()));

function existsNow(abs) {
  const entry = known.get(abs);
  if (entry && Date.now() - entry.at < CACHE_MS) {
    return entry.exists;
  }
  queue.add(abs);
  return entry?.exists;
}

// The first candidate known to exist, or null (unknown ones are queued for the next pump).
function resolveExisting(path, where) {
  for (const abs of pathCandidates(path, { ...where, home: home() })) {
    if (existsNow(abs)) {
      return abs;
    }
  }
  return null;
}

// Links in one line of text that point at existing files: [{ start, end, abs, line, col }].
// `where`: { fileDir, root } to resolve relative paths.
export function linksIn(text, where) {
  return findPathLinks(text)
    .map((link) => ({ ...link, abs: resolveExisting(link.path, where) }))
    .filter((link) => link.abs);
}

// Checks the queued paths; true when something new is known (re-render then).
export async function pumpLinks() {
  if (pumping || !queue.size) {
    return false;
  }
  pumping = true;
  const batch = [...queue].slice(0, MAX_BATCH);
  batch.forEach((abs) => queue.delete(abs));
  try {
    const result = await exec("sh", ["-c", EXISTS, "herdr-vscode-links", ...batch]);
    const found = new Set(result.stdout.split("\n").filter(Boolean));
    const at = Date.now();
    batch.forEach((abs) => known.set(abs, { exists: found.has(abs), at }));
    return found.size > 0;
  } catch {
    return false;
  } finally {
    pumping = false;
  }
}

// A timer that re-renders the view when newly checked paths turn into links.
export function watchLinks(cx, everyMs = 300) {
  cx.timer.every(everyMs, (cx) => {
    if (queue.size) {
      cx.spawn(async (cx) => {
        if (await pumpLinks()) {
          cx.notify();
        }
      });
    }
  });
}

// Opens `abs` in the file editor at `line` and asks the Explorer to reveal it.
export async function openPath(abs, line = null) {
  const top = (await repoTop(tops, parentOf(abs), null).catch(() => null)) ?? null;
  const roots = [top, ...(workspace()?.roots ?? []).map((root) => root.path ?? root)].filter(Boolean);
  const { root, rel } = splitRoot(abs, roots);
  if (top && ctx().cwd !== root && !String(ctx().cwd ?? "").startsWith(`${root}/`)) {
    setActive({ path: root, name: baseName(root) }, "pick");
  }
  showInViewer(FILES_MOD, { root, on: null, rel, ...(line ? { line } : {}) }, baseName(rel));
  setShared(REVEAL_KEY, { abs, root, at: Date.now() });
}

// A rendered-markdown link: local files open here, everything else goes to the browser.
export function openMarkdownLink(url, where) {
  const target = parseLinkTarget(url);
  if (!target) {
    exec("open", [url]).catch(() => {});
    return;
  }
  const candidates = pathCandidates(target.path, { ...where, home: home() });
  (async () => {
    queue.clear();
    candidates.forEach((abs) => queue.add(abs));
    await pumpLinks();
    const abs = candidates.find((candidate) => known.get(candidate)?.exists);
    if (abs) {
      openPath(abs, target.line);
    }
  })();
}

export const lastReveal = () => shared(REVEAL_KEY) ?? null;

// Code runs as row children; link parts show in the link colour. A handler inside a virtual list's
// item renderer throws, so the rows cannot open a path on click.
export function linkedRunChildren(runs, links, { colorOf, linkColor }) {
  return splitRunsAtLinks(runs, links).map((run) => {
    const color = run.link ? linkColor : colorOf(run);
    return div().flex_none().whitespace_nowrap().text_color(color).child(run.text || " ");
  });
}
