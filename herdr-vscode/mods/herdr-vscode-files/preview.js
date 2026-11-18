import { div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, TextView, VirtualListScrollHandle, EditorState, Editor } from "gpui-base";
import { theme, readTextFile, writeTextFile, exec, appHome, shared, setShared } from "herdr";
import { git, bump } from "./ws.js";
import { parseBlame, heat, shortAge, NOT_COMMITTED } from "./blame-core.js";
import { parseLog, LOG_FORMAT, parseHunks } from "./git-core.js";
import { LexCache, languageOf, syntaxColors, editorSyntax } from "./syntax-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, codeFont, codeSize, codeLineHeight, tabSpaces, codeWrap, tint } from "./ui.js";
import { viewerValue, viewerTab, keptTabs, showInViewer } from "./tabs.js";
import { AUTOSAVE_DEFAULT, autoSaveDue } from "./fileops-core.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";
import { logInfo, logError, toast } from "./log.js";
import { linksIn, watchLinks, openMarkdownLink, linkedRunChildren, REVEAL_KEY } from "./links.js";

const MOD = "herdr-vscode-files";
const BLAME_W = 230;
const POLL_MS = 2000;
const FOLLOW_MS = 100;
const AUTOSAVE_TICK_MS = 250;
const MAX_LINES = 20000;
const MAX_CACHE_NAME = 150;
const FILE_HISTORY_COUNT = 100;
const LINE_HISTORY_COUNT = 50;
const MS_PER_SECOND = 1000;
const ISO_DATE_LENGTH = 10;
const SHORT_SHA = 8;
const GUTTER_RATIO = 3.6;
const GUTTER_PAD_RATIO = 0.9;
const CHAR_WIDTH_RATIO = 0.62;
const MIN_CODE_WIDTH = 300;
const MIN_BLAME_TEXT = 10;
const ADDED_LINE_ALPHA = "1c";
const SAVED_TOAST_MS = 1500;
const UNSAVED_TOAST_MS = 3000;
const SAVE_ERROR_TOAST_MS = 8000;
const HEAT_STEPS = [[0.9, "ansi1"], [0.7, "ansi3"], [0.45, "ansi2"], [0.2, "ansi4"]];
const DIRTY_KEY = "herdr-vscode.dirty";
const KEPT_KEY = "herdr-vscode.tabs.kept";
const VIEW_KEY = `${MOD}.view`;
// Before settings.json the blame toggle lived in this mod's localStorage: still the default.
const OLD_BLAME_KEY = "blame";
const HISTORY_FILE = "file";
const HISTORY_LINE = "line";
const UNTRACKED_HUNK = { newStart: 1, fresh: Infinity, kind: "added" };
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const NO_BLAME = /no such path|not in the working tree|fatal: no such ref/i;
const STALE_WRITE = /stale|changed|expected/i;
// $1 source, $2 copy: copy only when different, so an unchanged image never reloads.
const COPY = 'mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" || cp -- "$1" "$2"; }';

const fileName = (rel) => rel.split("/").pop();

const parentFolder = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

const commitDiffValue = (file, sha, subject) => ({ root: file.root, on: file.on ?? null, path: file.rel, scope: "commit", sha, subject });

function cachePathFor(abs) {
  return `mods/${MOD}/cache/${encodeURIComponent(abs).replace(/%/g, "_").slice(-MAX_CACHE_NAME)}`;
}

function markBarColor(t, mark) {
  const colors = { added: t.ansi2, changed: t.ansi3, removed: t.ansi1 };
  return colors[mark] ?? null;
}

function blameText(blame) {
  if (NOT_COMMITTED.test(blame.sha)) {
    return "You · Not committed yet";
  }
  return `${blame.author} · ${shortAge(blame.time)} · ${blame.summary}`;
}

function blameErrorText(stderr) {
  if (NO_BLAME.test(stderr)) {
    return "Not committed yet: no blame.";
  }
  return stderr.trim() || "No blame here.";
}

function toolbarLink(t, id, label, onClick, primary) {
  return div().id(id).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption)
    .when(primary, (el) => el.bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground))
    .when(!primary, (el) => el.text_color(t.muted).hover((style) => style.bg(t.hover)))
    .on_click((_event, cx) => onClick(cx)).child(label);
}

export const previewMethods = {
  initPreview(initProps, cx) {
    this.viewSpace = initProps.space;
    this.scroller = VirtualListScrollHandle.new();
    if (initProps.untitled?.name) {
      this.initUntitled(initProps.untitled, cx);
      return;
    }
    // A tab opened directly (herdr-app do tab.new --mod herdr-vscode-files --props {...}) names its file.
    this.propsFile = initProps.file?.root && initProps.file?.rel ? initProps.file : null;
    // A kept tab (props.fixed) shows its own file and never follows the space's preview.
    this.fixed = Boolean(initProps.fixed && this.propsFile);
    this.mdCode = false;
    this.blameOn = initProps.blame === true || getSetting("files", "blame", localStorage.getItem(OLD_BLAME_KEY) === "1") === true;
    whenSettings(cx, (cx) => {
      if (!this.blameOn && getSetting("files", "blame", localStorage.getItem(OLD_BLAME_KEY) === "1") === true) {
        this.blameOn = true;
        if (this.file) {
          this.loadBlame(cx);
        }
      }
    });
    if (Number.isInteger(initProps.line)) {
      this.selLine = initProps.line;
      this.jumpLine = initProps.line;
    }
    // Opened from a path link or `hv` (tools/hv): the Explorer reveals the file too.
    if (initProps.reveal && this.propsFile) {
      setShared(REVEAL_KEY, { abs: `${this.propsFile.root}/${this.propsFile.rel}`, root: this.propsFile.root, at: Date.now() });
    }
    watchLinks(cx);
    if (initProps.history === HISTORY_FILE || initProps.history === HISTORY_LINE) {
      this.wantHistory = initProps.history;
    }
    // The previewed file is cheap to check: follow a click at once, re-read the file every POLL_MS.
    cx.timer.every(FOLLOW_MS, (cx) => this.syncPreview(cx));
    cx.timer.every(POLL_MS, (cx) => this.syncPreview(cx, true));
    cx.timer.every(AUTOSAVE_TICK_MS, (cx) => {
      this.autoSaveTick(cx);
      this.takeFileMenuCommand(cx);
    });
    this.syncPreview(cx);
  },

  // Once the space's reused preview tab is kept, it shows its own file and the next preview opens a new tab.
  followKept() {
    if (this.fixed) {
      return;
    }
    this.myTab ??= viewerTab(MOD, this.viewSpace);
    const kept = this.myTab ? keptTabs()[this.myTab] : null;
    if (kept?.value?.rel) {
      this.fixed = true;
      this.propsFile = kept.value;
    }
  },

  keepTab() {
    if (this.fixed || !this.file) {
      return;
    }
    this.myTab ??= viewerTab(MOD, this.viewSpace);
    if (!this.myTab) {
      return;
    }
    const value = { root: this.file.root, on: this.file.on ?? null, rel: this.file.rel };
    setShared(KEPT_KEY, { ...keptTabs(), [this.myTab]: { mod: MOD, value } });
    this.fixed = true;
    this.propsFile = value;
  },

  // A tab opened onto a file shares it as the space's preview, so the tab bar, breadcrumbs and Timeline see it.
  sharePropsFile() {
    if (this.fixed || !this.propsFile || viewerValue(MOD, this.viewSpace) || !this.viewSpace) {
      return;
    }
    setShared(VIEW_KEY, { ...(shared(VIEW_KEY) ?? {}), [this.viewSpace]: { ...this.propsFile, at: Date.now() } });
  },

  resetFile(value, key, cx) {
    this.autoSaveTick(cx, true);
    this.editor?.release();
    this.writable = false;
    this.editChecked = false;
    this.fileKey = key;
    this.file = value;
    this.text = undefined;
    this.problem = null;
    this.lines = null;
    this.hunks = [];
    this.mdCode = false;
    this.selLine = this.firstFileSeen ? null : this.selLine ?? null;
    this.editor = null;
    this.firstFileSeen = true;
    this.blame = null;
    this.heat = null;
    this.blameError = null;
    if (this.history) {
      this.history = this.history.kind === HISTORY_FILE ? { kind: HISTORY_FILE, items: null } : null;
    }
  },

  syncPreview(cx, poll = false) {
    this.followKept();
    this.sharePropsFile();
    const value = this.fixed ? this.propsFile : viewerValue(MOD, this.viewSpace) ?? this.propsFile;
    if (!value?.rel) {
      return;
    }
    if (Number.isInteger(value.line) && value.at && value.at !== this.jumpAt && !this.fixed) {
      this.jumpAt = value.at;
      this.jumpLine = value.line;
    }
    if (value.edit && value.at && value.at !== this.editAt && !this.fixed) {
      this.editAt = value.at;
      this.editWanted = true;
    }
    const key = `${value.on ?? ""}|${value.root}/${value.rel}`;
    if (key !== this.fileKey) {
      this.resetFile(value, key, cx);
    } else if (!poll) {
      return;
    }
    this.readPreview(cx);
  },

  readPreview(cx) {
    const file = this.file;
    if (!file || this.readingPreview) {
      return;
    }
    this.readingPreview = true;
    cx.spawn(async (cx) => {
      try {
        if (IMAGE.test(file.rel)) {
          await this.readImage(file);
          return;
        }
        if (await this.readText(file, cx)) {
          await this.loadHunks(file);
          await this.applyEditWanted(cx);
        }
      } finally {
        this.readingPreview = false;
        cx.notify();
      }
    });
  },

  async readImage(file) {
    if (file.on) {
      this.problem = "Images on another machine can't be shown here.";
      return;
    }
    const abs = `${file.root}/${file.rel}`;
    const copy = cachePathFor(abs);
    const result = await exec("sh", ["-c", COPY, "herdr-vscode-copy", abs, `${appHome()}/${copy}`]);
    this.problem = result.code === 0 ? null : "This file is no longer there.";
    this.imageCopy = result.code === 0 ? copy : null;
  },

  // showInViewer(..., { edit: true }) opens the file straight in Edit mode.
  // Files open editable like VS Code's: writable, local, not an image, not truncated, not rendered Markdown.
  async applyEditWanted(cx) {
    const wanted = this.editWanted;
    this.editWanted = false;
    if (this.editor || (this.editChecked && !wanted)) {
      return;
    }
    this.editChecked = true;
    if (!(await this.canEdit())) {
      return;
    }
    this.startEdit(cx, { auto: !wanted });
  },

  async canEdit() {
    const file = this.file;
    if (!file || file.on || file.untitled || IMAGE.test(file.rel) || this.truncated || this.text === undefined || this.text === null) {
      return false;
    }
    if (MARKDOWN.test(file.rel) && !this.mdCode) {
      return false;
    }
    const check = await exec("test", ["-w", `${file.root}/${file.rel}`]).catch(() => null);
    this.writable = check?.code === 0;
    return this.writable;
  },

  // Auto save (shared "herdr-vscode.files.autoSave": afterDelay by default, or off) writes after a pause
  // in typing, or at once when the shown file changes (leaving = true).
  autoSaveTick(cx, leaving = false) {
    if (!this.editor || this.untitled) {
      return;
    }
    const dirty = this.editor.value() !== this.saved;
    if (autoSaveDue({ mode: getSetting("files", "autoSave", AUTOSAVE_DEFAULT), dirty, writable: this.writable, editedAt: this.editedAt ?? 0, now: Date.now(), blurred: leaving })) {
      this.save(cx, { quiet: true });
    }
  },

  applyJump() {
    if (!this.jumpLine) {
      return;
    }
    this.selLine = Math.min(this.jumpLine, this.lines.length);
    this.scroller.scroll_to_item(this.selLine - 1, "center");
    this.jumpLine = null;
  },

  // Returns false when the file could not be read at all.
  async readText(file, cx) {
    let text = null;
    try {
      text = await readTextFile(`${file.root}/${file.rel}`, { on: file.on });
    } catch {
      this.problem = "Too large or unreadable to preview.";
      return false;
    }
    if (text === this.text && this.lines) {
      this.applyJump();
    }
    if (text === null) {
      this.problem = "This file is no longer there.";
    } else if (text.includes("\0")) {
      this.problem = "Binary file.";
    } else if (text !== this.text) {
      this.applyText(file, text, cx);
    }
    return true;
  },

  applyText(file, text, cx) {
    this.problem = null;
    if (this.editor && this.editor.value() === this.saved && text !== this.saved) {
      this.editor.set_value(text);
      this.saved = text;
    }
    this.text = text;
    const all = text.replace(/\r/g, "").replace(/\t/g, tabSpaces()).split("\n");
    this.lines = all.slice(0, MAX_LINES);
    this.truncated = all.length > MAX_LINES;
    this.lexed = new LexCache(this.lines, languageOf(file.rel));
    if (this.blameOn) {
      this.loadBlame(cx);
    }
    if (this.history?.kind === HISTORY_FILE && !this.history.items) {
      this.openHistory(HISTORY_FILE, cx);
    }
    this.applyJump();
    if (this.wantHistory) {
      this.openHistory(this.wantHistory, cx);
      this.wantHistory = null;
    }
  },

  // Changed lines since HEAD; an untracked file is all new.
  async loadHunks(file) {
    const options = { cwd: file.root, on: file.on };
    const status = await git(["status", "--porcelain", "--", file.rel], options).catch(() => null);
    if (status?.code !== 0 || !status.stdout.trim()) {
      this.hunks = [];
      return;
    }
    if (status.stdout.startsWith("??")) {
      this.hunks = [UNTRACKED_HUNK];
      return;
    }
    const diff = await git(["diff", "-U0", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", file.rel], options).catch(() => null);
    this.hunks = diff?.code === 0 ? parseHunks(diff.stdout) : [];
  },

  toggleBlame(cx) {
    this.blameOn = !this.blameOn;
    setSetting("files", "blame", this.blameOn);
    if (this.blameOn) {
      this.loadBlame(cx);
    }
    cx.notify();
  },

  loadBlame(cx) {
    const file = this.file;
    if (!file) {
      return;
    }
    cx.spawn(async (cx) => {
      const result = await git(["blame", "--porcelain", "--", file.rel], { cwd: file.root, on: file.on }).catch(() => null);
      if (this.file !== file) {
        return;
      }
      if (result?.code === 0) {
        this.blame = parseBlame(result.stdout);
        this.heat = heat(this.blame);
        this.blameError = null;
      } else {
        this.blame = null;
        this.blameError = blameErrorText(result?.stderr ?? "");
      }
      cx.notify();
    });
  },

  // kind "file": commits that touched this file (following renames); "line": the selected line.
  openHistory(kind, cx) {
    const file = this.file;
    if (!file || (kind === HISTORY_LINE && !this.selLine)) {
      return;
    }
    const line = this.selLine;
    this.history = { kind, line, items: null };
    cx.notify();
    const args = kind === HISTORY_LINE
      ? ["log", "-n", String(LINE_HISTORY_COUNT), LOG_FORMAT, "--no-patch", `-L${line},${line}:${file.rel}`]
      : ["log", "-n", String(FILE_HISTORY_COUNT), "--follow", LOG_FORMAT, "--", file.rel];
    cx.spawn(async (cx) => {
      const result = await git(args, { cwd: file.root, on: file.on }).catch(() => null);
      if (!this.history || this.history.kind !== kind || this.history.line !== line) {
        return;
      }
      const ok = result?.code === 0;
      this.history.items = ok ? parseLog(result.stdout) : [];
      this.history.error = ok ? null : (result?.stderr ?? "").trim() || "git log failed";
      cx.notify();
    });
  },

  toggleFileHistory(cx) {
    if (this.history?.kind !== HISTORY_FILE) {
      this.openHistory(HISTORY_FILE, cx);
      return;
    }
    this.history = null;
    cx.notify();
  },

  heatColor(t, level) {
    if (level === undefined) {
      return null;
    }
    const step = HEAT_STEPS.find(([threshold]) => level >= threshold);
    return step ? t[step[1]] : t.border;
  },

  historyEntry(t, file, commit) {
    return v_flex().id(`h-${commit.hash}`).flex_none().mx(4).px(8).py(4).gap(1).rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click(() => showInViewer("herdr-vscode-changes", commitDiffValue(file, commit.hash, commit.subject), fileName(file.rel)))
      .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(commit.subject))
      .child(h_flex().gap(6).text_size(TEXT.caption).text_color(t.dim)
        .child(div().font_family(codeFont()).child(commit.short)).child(div().flex_1().truncate().child(commit.author)).child(div().child(shortAge(commit.at))));
  },

  historyList(t) {
    const history = this.history;
    const list = v_flex().id("pv-hist-list").flex_1().min_h(0).overflow_y_scrollbar().py(4);
    if (history.error) {
      return list.child(Message(history.error, true));
    }
    if (!history.items) {
      return list.child(Message("Loading…"));
    }
    if (!history.items.length) {
      return list.child(Message("No commits."));
    }
    return list.children(history.items.map((commit) => this.historyEntry(t, this.file, commit)));
  },

  historyDrawer(t) {
    const history = this.history;
    const title = history.kind === HISTORY_LINE ? `Line ${history.line} history` : "File history";
    return v_flex().id("pv-history").w(320).flex_none().h_full().border_l(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
        .child(Icon("history", 13).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(title))
        .child(IconButton({
          id: "pv-hist-close", icon: "x", label: "Close", size: 20,
          onClick: (cx) => {
            this.history = null;
            cx.notify();
          },
        })))
      .child(this.historyList(t));
  },

  lineMark(lineNumber) {
    for (const hunk of this.hunks ?? []) {
      if (hunk.kind === "removed") {
        if (lineNumber === hunk.newStart + 1) {
          return "removed";
        }
        continue;
      }
      if (lineNumber >= hunk.newStart && lineNumber < hunk.newStart + hunk.fresh) {
        return hunk.kind;
      }
    }
    return null;
  },

  blameCells(t, i, size, selected) {
    const blame = this.blame?.[i];
    const first = blame && (i === 0 || this.blame[i - 1]?.sha !== blame.sha);
    return [
      div().w(4).h_full().flex_none().bg(this.heatColor(t, this.heat?.[i]) ?? t.background),
      div().w(BLAME_W).flex_none().px(8).truncate().text_size(Math.max(MIN_BLAME_TEXT, size - 3)).text_color(selected ? t.muted : t.dim)
        .when(i > 0 && Boolean(first), (el) => el.border_t(1).border_color(t.border))
        .child(first ? blameText(blame) : ""),
    ];
  },

  codeRow(t, i, layout) {
    const lineNumber = i + 1;
    const mark = this.lineMark(lineNumber);
    const bar = markBarColor(t, mark);
    const runs = this.lexed.runsAt(i);
    const selected = this.selLine === lineNumber;
    return h_flex().id(`l${i}`).h(layout.height).w_full().items_center()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected && (mark === "added" || mark === "changed"), (el) => el.bg(tint(bar, ADDED_LINE_ALPHA)))
      .when(layout.blameOn, (el) => el.children(this.blameCells(t, i, layout.size, selected)))
      .child(div().w(3).h_full().flex_none().when(Boolean(bar), (el) => el.bg(bar)))
      .child(div().w(layout.size * GUTTER_RATIO).pr(layout.size * GUTTER_PAD_RATIO).flex_none().text_right().text_color(t.dim).child(String(lineNumber)))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap()
        .children(linkedRunChildren(runs, layout.where ? linksIn(layout.lines[i], layout.where) : [], {
          idPrefix: `l${i}`, colorOf: (run) => (run.kind ? layout.colors[run.kind] : t.foreground), linkColor: t.accent,
        })));
  },

  // Relative paths in this file resolve against its folder, then its repo root.
  linkBase() {
    if (!this.file || this.file.on) {
      return null;
    }
    const abs = `${this.file.root}/${this.file.rel}`;
    return { fileDir: abs.slice(0, abs.lastIndexOf("/")), root: this.file.root };
  },

  clickLine(key, cx) {
    const lineNumber = Number(key.slice(1)) + 1;
    this.selLine = this.selLine === lineNumber ? null : lineNumber;
    if (this.history?.kind === HISTORY_LINE && this.selLine) {
      this.openHistory(HISTORY_LINE, cx);
    }
    cx.notify();
  },

  codeRows(t) {
    const size = codeSize();
    const lines = this.lines ?? [];
    const blameOn = Boolean(this.blameOn && this.blame);
    const layout = {
      colors: syntaxColors(t), size, height: Math.round(size * codeLineHeight()), lines, lang: languageOf(this.file.rel), blameOn,
      where: this.linkBase(),
    };
    // Lexed lazily: only up to the last row shown, each line once.
    if (this.lexed?.lines !== lines || this.lexed.lang !== layout.lang) {
      this.lexed = new LexCache(lines, layout.lang);
    }
    const listId = `pv-${this.fileKey}`;
    const widest = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
    const minWidth = Math.max(MIN_CODE_WIDTH, (widest * CHAR_WIDTH_RATIO + 6) * size + (blameOn ? BLAME_W + 4 : 0));
    const renderRange = (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) {
        out.push(this.codeRow(t, i, layout));
      }
      return out;
    };
    return div().id("pv-code").flex_1().min_w(0).h_full().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(div().id("pv-x").size_full().overflow_x_scrollbar()
        .child(div().h_full().min_w(minWidth)
          .child(v_virtual_list(listId, lines.length, layout.height, (i) => `l${i}`, renderRange)
            .track_scroll(this.scroller).on_item_click((key, cx) => this.clickLine(key, cx)).size_full())))
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  dirtyKey() {
    if (this.untitled) {
      return this.untitledDirtyKey();
    }
    return this.file ? `${this.file.root}/${this.file.rel}` : null;
  },

  setDirty(on) {
    const key = this.dirtyKey();
    if (!key) {
      return;
    }
    const all = shared(DIRTY_KEY) ?? {};
    if (Boolean(all[key]) === on) {
      return;
    }
    const next = { ...all };
    if (on) {
      next[key] = true;
    } else {
      delete next[key];
    }
    setShared(DIRTY_KEY, next);
  },

  startEdit(cx, { auto = false } = {}) {
    if (!this.file || this.file.on || this.text === undefined || this.text === null) {
      return;
    }
    if (!auto) {
      this.keepTab();
    }
    const colors = syntaxColors(theme());
    this.editor = EditorState.new({
      language: languageOf(this.file.rel) ?? undefined, value: this.text, font_family: codeFont(), font_size: codeSize(), soft_wrap: codeWrap(),
      syntax: editorSyntax(colors),
    });
    this.saved = this.text;
    this.editor.on("change", (_event, cx) => {
      const dirty = this.editor.value() !== this.saved;
      this.editedAt = Date.now();
      if (dirty) {
        this.keepTab();
      }
      this.setDirty(dirty);
      cx.notify();
    });
    this.editor.on("blur", (_event, cx) => this.autoSaveTick(cx, true));
    if (!auto) {
      this.editor.focus();
    }
    cx.notify();
  },

  stopEdit(cx) {
    if (this.editor && this.editor.value() !== this.saved) {
      toast("herdr-vscode-files", { title: "Unsaved changes", body: "Save (⌘S) or Revert first.", timeout: UNSAVED_TOAST_MS });
      return;
    }
    this.editor?.release();
    this.editor = null;
    this.setDirty(false);
    cx.notify();
  },

  toggleEdit(cx) {
    if (this.editor) {
      this.stopEdit(cx);
    } else {
      this.startEdit(cx);
    }
  },

  revert(cx) {
    if (!this.editor) {
      return;
    }
    this.editor.set_value(this.saved);
    this.setDirty(false);
    cx.notify();
  },

  save(cx, { quiet = false } = {}) {
    const file = this.file;
    if (!this.editor || !file) {
      return;
    }
    if (this.untitled) {
      this.openSaveAs();
      return;
    }
    const text = this.editor.value();
    if (text === this.saved) {
      return;
    }
    if (this.saving) {
      return;
    }
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${file.root}/${file.rel}`, text, this.saved);
        logInfo(MOD, quiet ? "auto saved" : "saved", `${file.root}/${file.rel}`);
        this.saved = text;
        this.text = text;
        this.setDirty(false);
        bump(file.root);
        if (!quiet) {
          toast("herdr-vscode-files", { title: `Saved ${fileName(file.rel)}`, level: "success", timeout: SAVED_TOAST_MS });
        }
      } catch (error) {
        logError(MOD, "save failed", `${file.root}/${file.rel}: ${error}`);
        const body = STALE_WRITE.test(String(error))
          ? "The file changed on disk since you opened it. Revert to load it, then edit again."
          : String(error?.message ?? error);
        toast("herdr-vscode-files", { title: "Not saved", body, level: "error", timeout: SAVE_ERROR_TOAST_MS });
      } finally {
        this.saving = false;
      }
      cx.notify();
    });
  },

  setMdCode(on, cx) {
    this.mdCode = on;
    if (!on && this.editor && this.editor.value() === this.saved) {
      this.editor.release();
      this.editor = null;
    }
    if (on) {
      this.editChecked = false;
      cx.spawn(async (cx) => {
        await this.applyEditWanted(cx);
        cx.notify();
      });
    }
    cx.notify();
  },

  codeTools(t, el) {
    const lineLabel = this.selLine ? `History of line ${this.selLine}` : "Click a line, then show its history";
    return el
      .when(Boolean(this.selLine), (row) => row.child(div().text_size(TEXT.caption).text_color(t.dim).child(`line ${this.selLine}`)))
      .child(IconButton({ id: "pv-blame", icon: "blame", label: this.blameOn ? "Hide blame" : "Blame (author · age per line, heatmap)", active: Boolean(this.blameOn), onClick: (cx) => this.toggleBlame(cx), size: 22 }))
      .child(IconButton({ id: "pv-hist", icon: "history", label: "File history", active: this.history?.kind === HISTORY_FILE, onClick: (cx) => this.toggleFileHistory(cx), size: 22 }))
      .child(IconButton({ id: "pv-lhist", icon: "line-history", label: lineLabel, disabled: !this.selLine, active: this.history?.kind === HISTORY_LINE, onClick: (cx) => this.openHistory(HISTORY_LINE, cx), size: 22 }));
  },

  editTools(t, el) {
    const unsaved = Boolean(this.editor) && this.editor?.value() !== this.saved;
    return el
      .when(unsaved, (row) => row
        .child(toolbarLink(t, "pv-revert", "Revert", (cx) => this.revert(cx), false))
        .child(toolbarLink(t, "pv-save", this.untitled ? "Save As ⌘S" : "Save ⌘S", (cx) => this.save(cx), true)));
  },

  previewToolbar(t, file, isMarkdown) {
    const abs = `${file.root}/${file.rel}`;
    const showsCode = !isMarkdown || this.mdCode;
    const editable = !file.on && !IMAGE.test(file.rel) && showsCode && this.text !== undefined;
    const real = !file.untitled;
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(FileIcon(this.icons, abs, { size: 14 }))
      .child(div().flex_none().max_w(320).truncate().font_medium().child(fileName(file.rel)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(parentFolder(file.rel)))
      .when(isMarkdown, (el) => el
        .child(IconButton({ id: "pv-md", icon: "eye", label: "Rendered", active: !this.mdCode, onClick: (cx) => this.setMdCode(false, cx), size: 22 }))
        .child(IconButton({ id: "pv-code", icon: "file", label: "Code", active: this.mdCode, onClick: (cx) => this.setMdCode(true, cx), size: 22 })))
      .when(showsCode && real, (el) => this.codeTools(t, el))
      .when(editable, (el) => this.editTools(t, el))
      .when(!file.on && real, (el) => el.child(IconButton({ id: "pv-open", icon: "external", label: "Open in default app", onClick: () => exec("open", ["--", abs]).catch(() => {}), size: 22 })));
  },

  // The selected line's full blame, like GitLens' current-line annotation.
  selectedBlameBar(t, file, blame) {
    const uncommitted = NOT_COMMITTED.test(blame.sha);
    const date = blame.time ? new Date(blame.time * MS_PER_SECOND).toISOString().slice(0, ISO_DATE_LENGTH) : "";
    return h_flex().h(24).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(TEXT.caption).text_color(t.muted)
      .child(Icon("git-commit", 11).text_color(t.accent))
      .child(div().font_family(codeFont()).child(uncommitted ? "uncommitted" : blame.sha.slice(0, SHORT_SHA)))
      .child(div().child(uncommitted ? "You" : blame.author))
      .child(div().child(date))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(uncommitted ? "Not committed yet" : blame.summary))
      .when(!uncommitted, (el) => el.child(h_flex().id("pv-sb-open").px(6).h(18).items_center().rounded(4).cursor_pointer().text_color(t.accent).hover((style) => style.bg(t.hover))
        .on_click(() => showInViewer("herdr-vscode-changes", commitDiffValue(file, blame.sha, blame.summary), fileName(file.rel)))
        .child("open commit diff")));
  },

  previewBody(t, file, isMarkdown) {
    if (this.problem) {
      return Message(this.problem);
    }
    if (IMAGE.test(file.rel)) {
      return this.imageCopy ? h_flex().flex_1().min_h(0).p(16).justify_center().items_center().child(image(this.imageCopy).max_w_full().max_h_full()) : Message("Loading…");
    }
    if (this.text === undefined) {
      return Message("Loading…");
    }
    if (isMarkdown && !this.mdCode) {
      return div().id("pv-md-body").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(18)
        .child(TextView.markdown(`md-${this.fileKey}`, this.text).w_full().text_size(TEXT.title).selectable(true).scrollable(false)
          .on_link_click((url) => openMarkdownLink(url, this.linkBase() ?? {})));
    }
    if (this.editor && !this.blameOn) {
      return div().id("pv-editor").flex_1().min_h(0).font_family(codeFont())
        .on_mouse_down("right", (event) => this.openFileMenu(event.position))
        .on_key_down((event, cx) => {
          if (event.key === "s" && event.modifiers?.platform) {
            cx.stop_propagation();
            this.save(cx);
          }
        })
        .child(Editor.new(this.editor).size_full());
    }
    return null;
  },

  renderPreview() {
    const t = theme();
    const file = this.file;
    const root = v_flex().id("herdr-vscode-preview").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body);
    if (!file) {
      return root.child(Message("Pick a file in Files to preview it here."));
    }
    const isMarkdown = MARKDOWN.test(file.rel);
    root.child(this.previewToolbar(t, file, isMarkdown));
    if (this.blameOn && this.blameError && !isMarkdown) {
      root.child(div().px(10).py(4).text_size(TEXT.caption).text_color(t.dim).child(this.blameError));
    }
    const selectedBlame = this.blameOn && this.selLine ? this.blame?.[this.selLine - 1] : null;
    if (selectedBlame) {
      root.child(this.selectedBlameBar(t, file, selectedBlame));
    }
    const body = this.previewBody(t, file, isMarkdown);
    if (body) {
      return root.child(body);
    }
    root.child(h_flex().id("pv-code-area").flex_1().min_h(0).on_mouse_down("right", (event) => this.openFileMenu(event.position)).child(this.codeRows(t)).when(Boolean(this.history), (el) => el.child(this.historyDrawer(t))));
    if (this.truncated) {
      root.child(Message(`Showing the first ${MAX_LINES.toLocaleString()} lines.`));
    }
    return root;
  },
};
