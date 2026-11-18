import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, shared } from "herdr";
import { active, setActive, git } from "./ws.js";
import { TEXT, Icon, FileIcon, RootIcon, markColor } from "./ui.js";
import { showInViewer } from "./tabs.js";

const ROW = 22;
const INDENT = 12;
const MAX_ROWS = 2500;
const MAX_IGNORED = 5000;
const MAX_FILTER_HITS = 300;
const PER_FOLDER = 2000;
const DOUBLE_CLICK = 2;
const NAME_PREFIX_SCORE = 3;
const NAME_HIT_SCORE = 2;
const PATH_HIT_SCORE = 1;
const TRANSPARENT = "#00000000";
const DOTS_KEY = "dots";
const VIEWER_MOD = "herdr-vscode-files";
const HIDDEN = new Set([".git", ".DS_Store"]);
// "d|f", name pairs, null-separated; the folder is $1, never part of the script text.
const LIST = `cd -- "$1" || exit 2; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; if [ -d "$p" ]; then printf "d\\0%s\\0" "$p"; else printf "f\\0%s\\0" "$p"; fi; n=$((n+1)); [ $n -ge ${PER_FOLDER} ] && break; done; exit 0`;

const natural = (left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

const entryKey = (root, rel) => `${root}\0${rel}`;

const childPath = (rel, name) => (rel ? `${rel}/${name}` : name);

function parseListing(stdout) {
  const fields = stdout.split("\0");
  const list = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!HIDDEN.has(fields[i + 1])) {
      list.push({ name: fields[i + 1], dir: fields[i] === "d" });
    }
  }
  return list.sort((a, b) => Number(b.dir) - Number(a.dir) || natural(a.name, b.name));
}

function matchScore(rel, query) {
  const lower = rel.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.startsWith(query)) {
    return NAME_PREFIX_SCORE;
  }
  if (name.includes(query)) {
    return NAME_HIT_SCORE;
  }
  return lower.includes(query) ? PATH_HIT_SCORE : 0;
}

// One dot says the most important thing: failing CI, running CI, conflicts, changes.
function rootDotColor(t, status, ci) {
  if (ci?.kind === "failure" || status?.conflicts) {
    return t.ansi1;
  }
  if (ci?.kind === "running") {
    return t.ansi4;
  }
  return status?.changed ? t.ansi3 : null;
}

function branchLine(status) {
  if (status?.branch) {
    return `${status.branch}${status.upstream ? ` → ${status.upstream}` : ""}`;
  }
  return status?.error ?? "";
}

function changesLine(status) {
  if (status?.changed) {
    return `${status.changed} changed${status.conflicts ? `, ${status.conflicts} conflicts` : ""}`;
  }
  return status?.branch ? "clean" : "";
}

function rootTooltip(root, status, ci) {
  const detail = [
    branchLine(status),
    status?.ahead || status?.behind ? `↑${status.ahead} ↓${status.behind}` : "",
    changesLine(status),
    ci ? `CI ${ci.label}${ci.number ? ` #${ci.number}` : ""}` : "",
  ].filter(Boolean).join("\n");
  return `${root.path}\n${detail}`;
}

function entryColor(t, mark, below, ignored) {
  if (mark) {
    return markColor(mark, t);
  }
  if (below) {
    return t.ansi3;
  }
  return ignored ? t.dim : t.foreground;
}

function note(t, text) {
  return div().px(12).py(4).text_size(TEXT.caption).text_color(t.dim).child(text);
}

export const explorerMethods = {
  initExplorer() {
    this.entries = new Map();
    this.open = new Set();
    this.selected = null;
    this.drag = null;
    this.ignored = new Map();
    this.index = new Map();
    this.showDots = localStorage.getItem(DOTS_KEY) !== "0";
  },

  async loadIgnored(root) {
    const result = await git(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: root }).catch(() => null);
    const paths = result?.code === 0 ? result.stdout.split("\0") : [];
    this.ignored.set(root, new Set(paths.filter(Boolean).slice(0, MAX_IGNORED).map((path) => path.replace(/\/$/, ""))));
  },

  isIgnored(root, rel) {
    const set = this.ignored.get(root);
    if (!set?.size) {
      return false;
    }
    if (set.has(rel)) {
      return true;
    }
    for (let i = rel.indexOf("/"); i > 0; i = rel.indexOf("/", i + 1)) {
      if (set.has(rel.slice(0, i))) {
        return true;
      }
    }
    return false;
  },

  toggleDots(cx) {
    this.showDots = !this.showDots;
    localStorage.setItem(DOTS_KEY, this.showDots ? "1" : "0");
    cx.notify();
  },

  buildIndex(cx) {
    const roots = this.ws?.roots ?? [];
    const missing = roots.filter((root) => !this.index.has(root.path));
    if (!missing.length || this.indexing) {
      return;
    }
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        for (const root of missing) {
          const result = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root.path }).catch(() => null);
          this.index.set(root.path, result?.code === 0 ? result.stdout.split("\0").filter(Boolean) : []);
        }
      } finally {
        this.indexing = false;
        cx.notify();
      }
    });
  },

  filterHits(query) {
    const lowerQuery = query.toLowerCase();
    const hits = [];
    for (const root of this.ws?.roots ?? []) {
      for (const rel of this.index.get(root.path) ?? []) {
        const score = matchScore(rel, lowerQuery);
        if (score) {
          hits.push({ root, rel, score });
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  },

  filterHitRow(t, hit) {
    const slash = hit.rel.lastIndexOf("/");
    const name = hit.rel.slice(slash + 1);
    const dir = slash >= 0 ? hit.rel.slice(0, slash) : "";
    return h_flex().id(`fr-${hit.root.path}-${hit.rel}`).h(ROW).flex_none().pl(14).pr(8).gap(6).items_center().cursor_pointer().hover((style) => style.bg(t.hover)).text_size(TEXT.body)
      .on_click(() => {
        setActive(hit.root, "pick");
        showInViewer(VIEWER_MOD, { root: hit.root.path, on: null, rel: hit.rel }, name);
      })
      .child(FileIcon(this.icons, `${hit.root.path}/${hit.rel}`, { size: 14 }))
      .child(div().flex_none().max_w(200).truncate().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(dir));
  },

  filterRows(t, query) {
    const hits = this.filterHits(query);
    const rows = [];
    let lastRoot = null;
    for (const hit of hits.slice(0, MAX_FILTER_HITS)) {
      if (hit.root !== lastRoot) {
        lastRoot = hit.root;
        rows.push(div().id(`fh-${hit.root.path}`).h(ROW).px(10).flex().items_center().text_size(TEXT.caption).text_color(t.dim).child(hit.root.name.toUpperCase()));
      }
      rows.push(this.filterHitRow(t, hit));
    }
    if (!rows.length) {
      rows.push(div().px(12).py(6).text_size(TEXT.small).text_color(t.dim).child(this.indexing ? "Indexing…" : "No matching files."));
    } else if (hits.length > MAX_FILTER_HITS) {
      rows.push(note(t, `Showing ${MAX_FILTER_HITS} of ${hits.length}. Type more to narrow it.`));
    }
    return rows;
  },

  openStateKey() {
    return `open:${this.ws?.file ?? this.ws?.dir}`;
  },

  restoreOpen() {
    const saved = localStorage.getItem(this.openStateKey());
    try {
      this.open = new Set(JSON.parse(saved ?? "[]"));
    } catch {
      this.open = new Set();
    }
    const roots = this.ws?.roots ?? [];
    if ((saved === null || this.ws?.auto) && roots.length === 1) {
      this.open.add(entryKey(roots[0].path, ""));
    }
  },

  saveOpen() {
    localStorage.setItem(this.openStateKey(), JSON.stringify([...this.open]));
  },

  async loadDir(root, rel) {
    const dir = rel ? `${root}/${rel}` : root;
    const result = await exec("sh", ["-c", LIST, "herdr-vscode-ws", dir]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Can't list ${dir}`);
    }
    this.entries.set(entryKey(root, rel), parseListing(result.stdout));
    if (!rel) {
      await this.loadIgnored(root);
    }
  },

  reloadOpen(cx) {
    const keys = [...this.open];
    cx.spawn(async (cx) => {
      for (const key of keys) {
        const [root, rel] = key.split("\0");
        await this.loadDir(root, rel).catch(() => this.open.delete(key));
      }
      cx.notify();
    });
  },

  toggle(root, rel, cx) {
    const key = entryKey(root, rel);
    if (this.open.has(key)) {
      this.open.delete(key);
    } else {
      this.open.add(key);
      this.loadMissingDir(root, rel, cx);
    }
    this.saveOpen();
    cx.notify();
  },

  loadMissingDir(root, rel, cx) {
    if (this.entries.has(entryKey(root, rel))) {
      return;
    }
    cx.spawn(async (cx) => {
      await this.loadDir(root, rel).catch(() => {});
      cx.notify();
    });
  },

  collapseAll(cx) {
    this.open = new Set();
    this.saveOpen();
    cx.notify();
  },

  // git marks of a root's files (from the status the panel already reads), by relative path.
  marksOf(root) {
    const status = this.status.get(root.path);
    if (!status?.files) {
      return null;
    }
    const marks = {};
    for (const file of status.files) {
      marks[file.path.replace(/\/$/, "")] = file.mark;
    }
    return marks;
  },

  rootMouseDown(event, cx, root, index) {
    cx.stop_propagation();
    this.drag = { from: index, at: Date.now() };
    if (event.click_count === DOUBLE_CLICK) {
      this.drag = null;
      this.command({ cmd: "terminal", path: root.path });
    }
  },

  rootMouseUp(cx, root, index) {
    const drag = this.drag;
    this.drag = null;
    if (drag && drag.from !== index) {
      return this.command({ cmd: "move", path: this.ws.roots[drag.from].path, to: index });
    }
    setActive(root, "pick");
    this.toggle(root.path, "", cx);
  },

  rootRow(t, root, index) {
    const status = this.status.get(root.path);
    const ci = (shared("herdr-vscode.ci.summary") ?? {})[root.path];
    const isActive = active()?.root === root.path;
    const open = this.open.has(entryKey(root.path, ""));
    const dot = rootDotColor(t, status, ci);
    const dragging = this.drag && this.drag.from !== index;
    return h_flex()
      .id(`root-${root.path}`).h(ROW + 2).flex_none().pl(4).pr(8).gap(4).items_center()
      .bg(isActive ? t.selected : TRANSPARENT).when(!isActive, (el) => el.hover((style) => style.bg(t.hover)))
      .when(Boolean(dragging), (el) => el.border_t(1).border_color(t.accent))
      .cursor_pointer().text_size(TEXT.body)
      .tooltip(rootTooltip(root, status, ci))
      .on_mouse_down("left", (event, cx) => this.rootMouseDown(event, cx, root, index))
      .on_mouse_up("left", (_event, cx) => this.rootMouseUp(cx, root, index))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        this.openMenu({ kind: "root", root, index, count: this.ws.roots.length });
      })
      .child(Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim))
      .child(RootIcon(open, 15))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(isActive ? t.foreground : t.muted).child(root.name))
      .when(Boolean(status?.branch), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(TEXT.caption).text_color(t.dim).child(status.branch)))
      .child(div().w(7).flex_none().h(7).rounded(4).when(Boolean(dot), (el) => el.bg(dot)));
  },

  clickEntry(cx, root, path, entry, key) {
    this.selected = key;
    if (entry.dir) {
      this.toggle(root.path, path, cx);
      return;
    }
    setActive(root, "pick");
    showInViewer(VIEWER_MOD, { root: root.path, on: null, rel: path }, entry.name);
    cx.notify();
  },

  entryRow(t, root, rel, entry, depth, marks) {
    const path = childPath(rel, entry.name);
    const key = entryKey(root.path, path);
    const open = entry.dir && this.open.has(key);
    const mark = marks?.[path];
    const below = entry.dir && !mark && marks && Object.keys(marks).some((changed) => changed.startsWith(`${path}/`));
    const ignored = !mark && this.isIgnored(root.path, path);
    const color = entryColor(t, mark, below, ignored);
    const selected = this.selected === key;
    return h_flex()
      .id(`e-${key}`).h(ROW).flex_none().pl(4 + depth * INDENT).pr(8).gap(4).items_center()
      .bg(selected ? t.selected : TRANSPARENT).when(!selected, (el) => el.hover((style) => style.bg(t.hover)))
      .cursor_pointer().text_size(TEXT.body)
      .on_click((_event, cx) => this.clickEntry(cx, root, path, entry, key))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        this.selected = key;
        this.openMenu({ kind: "entry", root, rel: path, dir: entry.dir });
        cx.notify();
      })
      .child(entry.dir ? Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim) : div().w(12).flex_none())
      .child(FileIcon(this.icons, `${root.path}/${path}`, { dir: entry.dir, open, size: 14 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(entry.name))
      .when(Boolean(mark), (el) => el.child(div().w(10).flex_none().text_size(TEXT.caption).text_color(color).child(mark)))
      .when(Boolean(below), (el) => el.child(div().size(5).flex_none().rounded(3).bg(t.ansi3)));
  },

  pushRootTree(t, rows, root) {
    const marks = this.marksOf(root);
    const walk = (rel, depth) => {
      const list = this.entries.get(entryKey(root.path, rel));
      if (!list) {
        rows.push(div().h(ROW).pl(4 + depth * INDENT + 16).text_size(TEXT.caption).text_color(t.dim).child("Loading…"));
        return;
      }
      for (const entry of list) {
        if (rows.length >= MAX_ROWS) {
          return;
        }
        if (!this.showDots && entry.name.startsWith(".")) {
          continue;
        }
        rows.push(this.entryRow(t, root, rel, entry, depth, marks));
        const path = childPath(rel, entry.name);
        if (entry.dir && this.open.has(entryKey(root.path, path))) {
          walk(path, depth + 1);
        }
      }
    };
    walk("", 1);
  },

  explorerRows(t) {
    const rows = [];
    (this.ws?.roots ?? []).forEach((root, index) => {
      rows.push(this.rootRow(t, root, index));
      if (this.open.has(entryKey(root.path, ""))) {
        this.pushRootTree(t, rows, root);
      }
    });
    if (rows.length >= MAX_ROWS) {
      rows.push(note(t, "Collapse some folders to see more."));
    }
    return rows;
  },
};
