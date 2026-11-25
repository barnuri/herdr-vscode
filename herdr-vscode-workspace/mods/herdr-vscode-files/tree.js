import { div } from "gpui-kit";
import { v_flex, h_flex, Input, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, exec, watchFolder, openOverlay, closeOverlay, props, hc, panes, focused, run, shared } from "herdr";
import { REVEAL_KEY } from "./links.js";
import { parentDirs } from "./links-core.js";
import { ctx, contextKey, git, repoTop, changedAt, baseName } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { TEXT, Icon, IconButton, Badge, FileIcon, Message, markColor } from "./ui.js";
import { showInViewer } from "./tabs.js";
import { toast, logError } from "./log.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";
import { withTreeIndent, twistieSlot } from "./tree-ui.js";
import { activeGuideLevel } from "./tree-core.js";

const MOD = "herdr-vscode-files";
const ROW = 24;
const PER_FOLDER = 2000;
const MAX_ROWS = 8000;
const MATCHES = 300;
const MAX_IGNORED = 5000;
const MENU_WIDTH = 250;
const MENU_ITEM_HEIGHT = 28;
const MENU_PADDING = 14;
const MENU_FIXED_ITEMS = 5;
const NAME_HIT_SCORE = 1000;
const NAME_PREFIX_BONUS = 200;
const PATH_HIT_SCORE = 500;
const CONSECUTIVE_SCORE = 5;
const TRANSPARENT = "#00000000";
// Before settings.json "show hidden files" lived in localStorage: still the default.
const OLD_DOTS_KEY = "dots";
const NOISY_PATH = /\/(\.git|node_modules|\.next|dist)(\/|$)/;
const ERROR_LEVEL = "error";

// Null-separated "d|f", name pairs; the folder is $1, never part of the script text.
const LIST = `cd -- "$1" || exit 2; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; [ "$p" = .git ] && continue; if [ -d "$p" ]; then printf 'd\\0%s\\0' "$p"; else printf 'f\\0%s\\0' "$p"; fi; n=$((n+1)); [ $n -ge ${PER_FOLDER} ] && break; done; exit 0`;
// Without git: every file below, skipping the usual heavy folders.
const FIND = `cd -- "$1" && if command -v rg >/dev/null 2>&1; then rg --files --hidden -g '!.git' --max-depth 8 2>/dev/null | sed 's|^|./|' | head -n 40000; exit 0; fi; find . -maxdepth 8 \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name build -o -name target -o -name .venv \\) -prune -o -type f -print 2>/dev/null | head -n 40000`;

// a1 < a2 < a10, case-insensitively.
function natural(left, right) {
  const chunk = /(\d+)|(\D+)/g;
  const leftParts = left.toLowerCase().match(chunk) ?? [];
  const rightParts = right.toLowerCase().match(chunk) ?? [];
  for (let i = 0; i < Math.min(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === rightParts[i]) {
      continue;
    }
    if (/^\d/.test(leftParts[i]) && /^\d/.test(rightParts[i])) {
      return Number(leftParts[i]) - Number(rightParts[i]);
    }
    return leftParts[i] < rightParts[i] ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

// Subsequence match with a score: consecutive letters and name hits weigh more.
function score(path, query) {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.includes(query)) {
    return NAME_HIT_SCORE - name.length + (name.startsWith(query) ? NAME_PREFIX_BONUS : 0);
  }
  if (lower.includes(query)) {
    return PATH_HIT_SCORE - lower.length;
  }
  let at = -1;
  let total = 0;
  for (const ch of query) {
    const next = lower.indexOf(ch, at + 1);
    if (next < 0) {
      return -1;
    }
    total += next === at + 1 ? CONSECUTIVE_SCORE : 1;
    at = next;
  }
  return total;
}

const shellQuote = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`);

const errorText = (error) => String(error?.message ?? error);

const openKey = (root) => `open:${root}`;

function loadOpenDirs(root) {
  try {
    return new Set(JSON.parse(localStorage.getItem(openKey(root)) ?? "[]"));
  } catch {
    return new Set();
  }
}

function parseListing(stdout) {
  const fields = stdout.split("\0");
  const list = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    list.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  return list.sort((a, b) => Number(b.dir) - Number(a.dir) || natural(a.name, b.name));
}

function parentFolder(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function reportAgentError(body) {
  toast("herdr-vscode-files", { title: "Couldn't reach the agent", body, level: ERROR_LEVEL });
}

export const treeMethods = {
  initTree(cx) {
    this.treeScroller = VirtualListScrollHandle.new();
    this.revealSeen = shared(REVEAL_KEY)?.at ?? 0;
    this.tops = new Map();
    this.entries = new Map();
    this.openDirs = new Set();
    this.marks = {};
    this.ignored = new Set();
    this.filter = "";
    this.index = null;
    this.showDots = getSetting("explorer", "showHidden", localStorage.getItem(OLD_DOTS_KEY) !== "0") !== false;
    whenSettings(cx, () => {
      this.showDots = getSetting("explorer", "showHidden", this.showDots) !== false;
    });
    this.filterState.on("change", (_event, cx) => {
      this.filter = this.filterState.value().trim().toLowerCase();
      if (this.filter && !this.index && !this.indexing) {
        this.buildIndex(cx);
      }
      cx.notify();
    });
  },

  // A path link was opened (links.js): expand its folders, select it and scroll it into view.
  followReveal(cx) {
    const reveal = shared(REVEAL_KEY);
    const root = this.root?.replace(/\/$/, "");
    if (!reveal || reveal.at === this.revealSeen || !root || this.on || !reveal.abs.startsWith(`${root}/`)) {
      return;
    }
    this.revealSeen = reveal.at;
    const rel = reveal.abs.slice(root.length + 1);
    const dirs = parentDirs(rel);
    dirs.forEach((dir) => this.openDirs.add(dir));
    this.saveOpenDirs();
    this.selected = rel;
    this.revealRel = rel;
    cx.spawn(async (cx) => {
      for (const dir of ["", ...dirs]) {
        if (!this.entries.has(dir)) {
          await this.loadDir(dir).catch(() => {});
        }
      }
      cx.notify();
    });
  },

  followTree(cx) {
    this.followReveal(cx);
    const context = ctx();
    const key = contextKey(context);
    if (key !== this.key) {
      this.key = key;
      this.switchTo(context, cx);
      return;
    }
    if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.reload(cx);
    }
  },

  switchTo(context, cx) {
    const key = this.key;
    cx.spawn(async (cx) => {
      const top = context.cwd ? await repoTop(this.tops, context.cwd, context.on) : null;
      if (this.key !== key) {
        return;
      }
      if (this.root) {
        this.saveOpenDirs();
      }
      this.root = top ?? context.cwd;
      this.isRepo = Boolean(top);
      this.on = context.on;
      this.source = context.source;
      this.entries = new Map();
      this.marks = {};
      this.ignored = new Set();
      this.index = null;
      this.error = null;
      this.openDirs = loadOpenDirs(this.root);
      this.reload(cx);
      this.watchRoot(cx);
    });
  },

  saveOpenDirs() {
    localStorage.setItem(openKey(this.root), JSON.stringify([...this.openDirs]));
  },

  // `polled` is the timer's: any other caller (a click, a watched change, a context switch) resets the poll to its base rate.
  reload(cx, polled = false) {
    if (!polled) {
      this.reloadPacer?.reset();
    }
    if (!this.root || this.reloading) {
      return;
    }
    this.reloading = true;
    const root = this.root;
    const startedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.loadOpenFolders(root);
        if (this.root !== root) {
          return;
        }
        if (this.isRepo) {
          await this.loadGit();
        }
        this.error = null;
      } catch (error) {
        logError("herdr-vscode-files", "tree load failed", String(error?.message ?? error));
        if (this.root === root) {
          this.error = errorText(error);
        }
      } finally {
        this.reloading = false;
        const signature = JSON.stringify([this.marks, this.ignored.size, [...this.entries].map(([rel, list]) => [rel, list.length])]);
        this.reloadPacer?.note({ changed: signature !== this.reloadSignature, tookMs: Date.now() - startedAt });
        this.reloadSignature = signature;
        cx.notify();
      }
    });
  },

  async loadOpenFolders(root) {
    for (const rel of ["", ...this.openDirs]) {
      if (this.root !== root) {
        return;
      }
      await this.loadDir(rel).catch((error) => {
        if (!rel) {
          throw error;
        }
        this.openDirs.delete(rel);
      });
    }
  },

  async loadDir(rel) {
    const dir = rel ? `${this.root}/${rel}` : this.root;
    const result = await exec("sh", ["-c", LIST, MOD, dir], { on: this.on });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Cannot list ${dir}`);
    }
    this.entries.set(rel, parseListing(result.stdout));
  },

  async loadGit() {
    const root = this.root;
    const [status, ignoredResult] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on: this.on }),
      git(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: root, on: this.on }).catch(() => null),
    ]);
    if (this.root !== root) {
      return;
    }
    const marks = {};
    if (status.code === 0) {
      for (const file of parseStatus(status.stdout).files) {
        marks[file.path] = file.mark;
      }
    }
    this.marks = marks;
    const ignoredPaths = ignoredResult?.code === 0 ? ignoredResult.stdout.split("\0") : [];
    this.ignored = new Set(ignoredPaths.filter(Boolean).slice(0, MAX_IGNORED).map((path) => path.replace(/\/$/, "")));
  },

  // Local folders tell us when they change; another machine's are read on the timer.
  watchRoot(cx) {
    this.watcher?.cancel?.();
    const root = this.root;
    if (this.on || !root) {
      return;
    }
    cx.spawn(async (cx) => {
      while (this.root === root) {
        let paths;
        try {
          this.watcher = watchFolder(root);
          paths = await this.watcher;
        } catch {
          return;
        }
        if (this.root !== root) {
          return;
        }
        if (paths.length && paths.every((path) => NOISY_PATH.test(path))) {
          continue;
        }
        this.index = null;
        this.reload(cx);
      }
    });
  },

  toggleDir(rel, cx) {
    if (this.openDirs.has(rel)) {
      this.openDirs.delete(rel);
    } else {
      this.openDirs.add(rel);
      this.loadDirIfMissing(rel, cx);
    }
    this.saveOpenDirs();
    cx.notify();
  },

  loadDirIfMissing(rel, cx) {
    if (this.entries.has(rel)) {
      return;
    }
    cx.spawn(async (cx) => {
      await this.loadDir(rel).catch((error) => {
        this.error = errorText(error);
      });
      cx.notify();
    });
  },

  collapseAll(cx) {
    this.openDirs = new Set();
    localStorage.setItem(openKey(this.root), "[]");
    cx.notify();
  },

  // Every file in the repo (tracked and new, not ignored), for the filter.
  buildIndex(cx) {
    const root = this.root;
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        const paths = await this.listAllFiles(root);
        if (this.root !== root) {
          return;
        }
        this.index = paths.filter(Boolean);
      } catch {
        this.index = [];
      } finally {
        this.indexing = false;
        cx.notify();
      }
    });
  },

  async listAllFiles(root) {
    if (this.isRepo) {
      const result = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, on: this.on });
      return result.stdout.split("\0");
    }
    const result = await exec("sh", ["-c", FIND, MOD, root], { on: this.on });
    return result.stdout.split("\n").map((path) => path.replace(/^\.\//, ""));
  },

  hasChangeBelow(rel) {
    const prefix = `${rel}/`;
    return Object.keys(this.marks).some((path) => path.startsWith(prefix));
  },

  treeRows() {
    const out = [];
    const walk = (rel, depth) => {
      for (const entry of this.entries.get(rel) ?? []) {
        if (out.length >= MAX_ROWS) {
          return;
        }
        if (!this.showDots && entry.name.startsWith(".")) {
          continue;
        }
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        const open = entry.dir && this.openDirs.has(path);
        out.push({ key: path, rel: path, name: entry.name, dir: entry.dir, depth, open });
        if (open) {
          walk(path, depth + 1);
        }
      }
    };
    walk("", 0);
    return out;
  },

  filterRows() {
    if (!this.index) {
      return [];
    }
    const query = this.filter;
    return this.index
      .map((path) => ({ path, score: score(path, query) }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, MATCHES)
      .map(({ path }) => ({ key: `f:${path}`, rel: path, name: baseName(path), dir: false, depth: 0, folder: parentFolder(path) }));
  },

  isIgnoredPath(rel) {
    return this.ignored.has(rel) || [...this.ignored].some((ignoredPath) => rel.startsWith(`${ignoredPath}/`));
  },

  rowColor(t, mark, below, ignored) {
    if (mark) {
      return markColor(mark, t);
    }
    if (below) {
      return t.ansi3;
    }
    return ignored ? t.dim : t.foreground;
  },

  row(t, row) {
    const mark = row.dir ? null : this.marks[row.rel];
    const below = row.dir && this.hasChangeBelow(row.rel);
    const ignored = this.isIgnoredPath(row.rel);
    const color = this.rowColor(t, mark, below, ignored);
    const selected = this.selected === row.rel;
    const chevron = row.dir ? Icon(row.open ? "chevron-down" : "chevron-right", 14).text_color(t.dim) : null;
    const el = h_flex()
      .id(`row-${row.key}`).h(ROW).w_full().pr(8).gap(4).items_center().rounded(5)
      .bg(selected ? t.selected : TRANSPARENT).text_size(TEXT.body).cursor_pointer()
      .child(twistieSlot(chevron))
      .child(FileIcon(this.icons, `${this.root}/${row.rel}`, { dir: row.dir, open: row.open, size: 16 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).when(ignored && !mark, (el) => el.opacity(0.6)).child(row.name))
      .when(Boolean(row.folder), (el) => el.child(div().max_w(140).truncate().text_size(TEXT.caption).text_color(t.dim).child(row.folder)))
      .when(Boolean(mark), (el) => el.child(div().w(12).flex_none().text_size(TEXT.caption).text_color(color).child(mark)))
      .when(below && !mark, (el) => el.child(div().size(5).flex_none().rounded(3).bg(t.ansi3)));
    const selectedDir = this.selectedDir;
    const activeLevel = selectedDir ? activeGuideLevel(row.rel, selectedDir, selectedDir.split("/").length - 1) : null;
    return withTreeIndent(el, t, { depth: row.depth, height: ROW, hovered: this.treeHovered, activeLevel });
  },

  findRow(key) {
    return (this.lastRows ?? []).find((row) => row.key === key);
  },

  press(key, cx) {
    const row = this.findRow(key);
    if (!row) {
      return;
    }
    this.selected = row.rel;
    if (row.dir) {
      this.toggleDir(row.rel, cx);
    } else {
      this.preview(row.rel);
    }
    cx.notify();
  },

  preview(rel) {
    showInViewer(MOD, { root: this.root, on: this.on ?? null, rel }, baseName(rel));
  },

  // The agents in the focused tab, for "Insert @path".
  tabAgents() {
    const tab = focused()?.tab;
    return panes().filter((pane) => pane.tab === tab && pane.terminal && (pane.app || pane.status));
  },

  openMenu(key) {
    const row = this.findRow(key);
    if (!row) {
      return;
    }
    this.selected = row.rel;
    const agents = this.tabAgents().map((pane) => ({ terminal: pane.terminal, name: pane.title || pane.app || pane.terminal }));
    const itemCount = MENU_FIXED_ITEMS + agents.length;
    openOverlay({
      mod: MOD, kind: "popup", width: MENU_WIDTH, height: itemCount * MENU_ITEM_HEIGHT + MENU_PADDING,
      props: { menu: { root: this.root, on: this.on ?? null, rel: row.rel, dir: row.dir, agents } },
    });
  },

  menuItems(menu) {
    const abs = `${menu.root}/${menu.rel}`;
    const items = [];
    if (!menu.dir) {
      items.push({ id: "preview", icon: "eye", label: "Preview", run: () => showInViewer(MOD, { root: menu.root, on: menu.on, rel: menu.rel }, baseName(menu.rel)) });
    }
    if (!menu.on) {
      items.push({ id: "open", icon: "external", label: menu.dir ? "Open in Finder" : "Open in default app", run: () => exec("open", ["--", abs]).catch(() => {}) });
      items.push({ id: "reveal", icon: "folder", label: "Reveal in Finder", run: () => exec("open", ["-R", "--", abs]).catch(() => {}) });
    }
    items.push({ id: "rel", icon: "copy", label: "Copy relative path", run: (cx) => cx.write_to_clipboard(menu.rel) });
    items.push({ id: "abs", icon: "copy", label: "Copy full path", run: (cx) => cx.write_to_clipboard(abs) });
    for (const agent of menu.agents ?? []) {
      items.push({ id: `agent-${agent.terminal}`, icon: "terminal", label: `Insert @${baseName(menu.rel)} into ${agent.name}`, run: () => this.sendToAgent(agent.terminal, abs) });
    }
    return items;
  },

  // Types "@path " into the agent's prompt (no Enter): the agent decides what to do with it.
  sendToAgent(terminal, abs) {
    hc(["send", terminal, `@${shellQuote(abs)} `])
      .then((result) => {
        if (result.code !== 0) {
          reportAgentError(result.stderr.trim());
        } else {
          run("pane.focus", { terminal });
        }
      })
      .catch((error) => reportAgentError(errorText(error)));
  },

  renderMenu() {
    const t = theme();
    return v_flex().id("herdr-vscode-files-menu").size_full().p(6).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(this.menu).map((item) =>
        h_flex().id(`m-${item.id}`).h(MENU_ITEM_HEIGHT).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
          .on_click((_event, cx) => {
            item.run(cx);
            closeOverlay(props()?.overlay);
          })
          .child(Icon(item.icon, 13).text_color(t.dim)).child(div().truncate().child(item.label))));
  },

  toggleDots(cx) {
    this.showDots = !this.showDots;
    setSetting("explorer", "showHidden", this.showDots);
    cx.notify();
  },

  treeHeader(t) {
    const name = this.root ? baseName(this.root) : "Files";
    const changed = Object.keys(this.marks).length;
    return h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(FileIcon(this.icons, this.root ?? "folder", { dir: true, open: true, size: 15 }))
      .child(div().flex_1().min_w(0).truncate().font_medium().child(name))
      .when(this.source === "active", (el) => el.child(Badge("workspace", t.accent)))
      .when(changed > 0, (el) => el.child(Badge(`${changed}`, t.ansi3)))
      .child(IconButton({ id: "f-dots", icon: "dot-files", label: this.showDots ? "Hide dotfiles" : "Show dotfiles", active: !this.showDots, onClick: (cx) => this.toggleDots(cx), size: 22 }))
      .child(IconButton({ id: "f-collapse", icon: "collapse", label: "Collapse all", onClick: (cx) => this.collapseAll(cx), size: 22 }))
      .child(IconButton({
        id: "f-refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.reloading), size: 22,
        onClick: (cx) => {
          this.index = null;
          this.reload(cx);
        },
      }));
  },

  treeSearch(t) {
    return h_flex().h(34).flex_none().px(8).items_center()
      .child(h_flex().flex_1().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.filterState).flex_1().h(24).text_size(TEXT.small)));
  },

  emptyMessage() {
    if (this.filter) {
      return "No matches.";
    }
    return this.reloading ? "Loading…" : "Empty folder.";
  },

  treeBody(t) {
    const body = v_flex().id("f-body").flex_1().min_h(0).relative();
    if (!this.root) {
      return body.child(Message("Pick a repo in Workspace, or focus a terminal in a folder."));
    }
    if (this.error) {
      return body.child(Message(this.error, true));
    }
    const rows = this.filter ? this.filterRows() : this.treeRows();
    this.lastRows = rows;
    this.selectedDir = rows.find((row) => row.dir && row.rel === this.selected)?.rel ?? null;
    if (this.filter && !this.index) {
      return body.child(Message("Indexing…"));
    }
    if (!rows.length) {
      return body.child(Message(this.emptyMessage()));
    }
    const listId = `f-list-${this.root}-${this.filter ? "q" : "t"}`;
    const revealAt = this.revealRel ? rows.findIndex((row) => row.rel === this.revealRel) : -1;
    if (revealAt >= 0) {
      this.revealRel = null;
      this.treeScroller.scroll_to_item(revealAt, "center");
    }
    return body
      .child(v_virtual_list(listId, rows.length, ROW, (i) => rows[i].key, (range) => rows.slice(range.start, range.end).map((row) => this.row(t, row)))
        .track_scroll(this.treeScroller)
        .on_item_click((key, cx) => this.press(key, cx))
        .on_item_secondary_click((key, _event, cx) => {
          this.openMenu(key);
          cx.notify();
        })
        .on_hover((hovered, cx) => {
          this.treeHovered = hovered;
          cx.notify();
        })
        .size_full().px(4))
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  footerText() {
    if (this.selected != null) {
      return this.selected;
    }
    if (this.isRepo) {
      return "git repo";
    }
    return this.root ? "not a git repo" : "";
  },

  renderTree() {
    const t = theme();
    return v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(this.treeHeader(t)).child(this.treeSearch(t)).child(this.treeBody(t))
      .child(h_flex().h(22).flex_none().px(10).items_center().border_t(1).border_color(t.border).text_size(TEXT.caption).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.footerText())));
  },
};
