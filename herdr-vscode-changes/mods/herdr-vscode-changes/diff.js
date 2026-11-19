import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, EditorState, Editor } from "gpui-base";
import { theme, readTextFile, writeTextFile, exec } from "herdr";
import { git, bump } from "./ws.js";
import { splitHunks, hunkPatch } from "./scm-core.js";
import { READ, diffRows, splitRows, lineStartOffset } from "./git-core.js";
import { lexCached, languageOf, syntaxColors, editorSyntax, editorLanguageOf } from "./syntax-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, Badge, codeFont, codeSize, codeLineHeight, tabSpaces, codeWrap, tint, SPIN_MS } from "./ui.js";
import { AUTOSAVE_DEFAULT, autoSaveDue } from "./fileops-core.js";
import { linksIn, watchLinks, linkedRunChildren } from "./links.js";
import { viewerValue, viewerTab, keptTabs } from "./tabs.js";
import { toast } from "./log.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";

const MOD = "herdr-vscode-changes";
const MAX_ROWS = 6000;
const DIFF_MIN_WIDTH = 400;
const DIFF_CHAR_RATIO = 0.62;
const DIFF_GUTTER = 12;
const POLL_MS = 2000;
const FOLLOW_MS = 100;
// Before settings.json the split diff toggle lived in localStorage: still the default.
const OLD_SPLIT_KEY = "split";
const OLD_SPLIT_ON = "1";
const DIFF_SPLIT = "split";
const DIFF_INLINE = "inline";
const SHORT_SHA = 8;
const ERROR_TAIL = 400;
const SUCCESS_TIMEOUT_MS = 2000;
const AUTOSAVE_TICK_MS = 250;
const STALE_WRITE = /stale|changed|expected/i;
const ERROR_TIMEOUT_MS = 6000;
const NUMBER_WIDTH_FACTOR = 3;
const MARK_WIDTH_FACTOR = 1.6;
const HUNK_ROW = "@";
const ADDED = "+";
const REMOVED = "-";
const CONTEXT = " ";
const HUNK_KEY_PREFIX = "h";
const PLAIN_DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];
// Applies a patch to the index from a temp file; the patch travels as an argument, never as script.
const APPLY = 'f=$(mktemp) || exit 1; printf "%s" "$1" > "$f"; shift; git "$@" "$f"; c=$?; rm -f "$f"; exit $c';

function diffArgs(target) {
  if (target.scope === "commit") {
    return ["--literal-pathspecs", "show", "--format=", "-m", "--first-parent", ...PLAIN_DIFF, target.sha, "--", target.path];
  }
  if (target.scope === "stash") {
    return ["--literal-pathspecs", "diff", ...PLAIN_DIFF, `${target.ref}^1`, target.ref, "--", target.path];
  }
  if (target.scope === "compare") {
    return ["--literal-pathspecs", "diff", ...PLAIN_DIFF, `${target.base}...${target.head ?? "HEAD"}`, "--", target.path];
  }
  return ["--literal-pathspecs", "diff", ...(target.scope === "staged" ? ["--cached"] : []), ...PLAIN_DIFF, "--", target.path];
}

function scopeLabel(target) {
  if (target.untracked) {
    return "new";
  }
  if (target.scope === "commit") {
    return `commit ${String(target.sha).slice(0, SHORT_SHA)}`;
  }
  if (target.scope === "stash") {
    return target.ref;
  }
  if (target.scope === "compare") {
    return `${target.base}…${target.head ?? "HEAD"}`;
  }
  return target.scope;
}

function scopeColor(colors, scope) {
  if (scope === "staged") {
    return colors.ansi2;
  }
  return scope === "commit" || scope === "compare" ? colors.accent : colors.ansi3;
}

function kindColor(colors, kind) {
  if (kind === ADDED) {
    return colors.ansi2;
  }
  return kind === REMOVED ? colors.ansi1 : colors.dim;
}

const lineNumber = (value) => (value !== undefined ? String(value) : "");

const stageableScope = (target) => target.scope === "unstaged" || target.scope === "staged";

// The working tree side is editable in the split layout (a local repo; writeTextFile has no `on`).
const editableTarget = (target) => Boolean(target && !target.on && (target.untracked || target.scope === "unstaged"));
// scm.editButton (default on): the split diff header gets an Edit button that swaps the right side
// for the whole working file in an editor. That editor does not line up with the left rows (no scroll
// sync or line decorations in EditorState yet, see docs/split-diff-editing.md), so it is opt-in per
// view. Delete the button, this flag and the editor path once herdr-app#1239 ships.
const editButtonOn = () => getSetting("scm", "editButton", true) !== false;

const isMergeDiff = (head) => /^diff --(cc|combined)/.test(head[0] ?? "");

export const diffMethods = {
  initDiff(options, cx) {
    this.viewSpace = options.space;
    // A tab opened directly (herdr-app do tab.new --mod herdr-vscode-changes --props {...}) names its diff.
    this.propsTarget = options.target?.root && options.target?.path ? options.target : null;
    this.fixed = Boolean(options.fixed && this.propsTarget);
    const splitOf = (fallback) => getSetting("scm", "diffLayout", fallback) === DIFF_SPLIT;
    this.split = splitOf(localStorage.getItem(OLD_SPLIT_KEY) === OLD_SPLIT_ON ? DIFF_SPLIT : DIFF_INLINE);
    whenSettings(cx, () => {
      this.split = splitOf(this.split ? DIFF_SPLIT : DIFF_INLINE);
    });
    this.scroller = VirtualListScrollHandle.new();
    // The target is cheap to check: follow a click at once, reload git every POLL_MS.
    cx.timer.every(FOLLOW_MS, (cx) => this.syncDiff(cx));
    cx.timer.every(POLL_MS, (cx) => this.syncDiff(cx, true));
    cx.timer.every(AUTOSAVE_TICK_MS, (cx) => this.autoSaveWorking(cx));
    watchLinks(cx);
    this.syncDiff(cx);
  },

  // A tab kept in place (herdr-vscode-tabs) shows its own diff from then on.
  adoptKeptTab() {
    if (this.fixed) {
      return;
    }
    this.myTab ??= viewerTab(MOD, this.viewSpace);
    const kept = this.myTab ? keptTabs()[this.myTab] : null;
    if (!kept?.value?.path) {
      return;
    }
    this.fixed = true;
    this.propsTarget = kept.value;
  },

  syncDiff(cx, poll = false) {
    this.adoptKeptTab();
    const target = this.fixed ? this.propsTarget : viewerValue(MOD, this.viewSpace) ?? this.propsTarget;
    if (!target?.path) {
      return;
    }
    const key = `${target.on ?? ""}|${target.root}|${target.scope}|${target.sha ?? target.ref ?? target.base ?? ""}|${target.path}`;
    if (key === this.diffKey && !poll) {
      return;
    }
    if (key !== this.diffKey) {
      this.releaseWorkingEditor(cx);
      this.editing = false;
      this.diffKey = key;
      const abs = `${target.root}/${target.path}`;
      this.linkBase = target.on ? null : { fileDir: abs.slice(0, abs.lastIndexOf("/")), root: target.root };
      this.target = target;
      this.rows = null;
      this.problem = null;
      this.hunk = 0;
      this.hunks = null;
      this.lastRaw = null;
    }
    this.loadDiff(cx);
  },

  async untrackedLines(target) {
    const text = await readTextFile(`${target.root}/${target.path}`, { on: target.on }).catch(() => null);
    if (text === null) {
      this.problem = "This file is gone, too large, or unreadable.";
      return null;
    }
    // Unchanged since the last poll: nothing to parse.
    if (text === this.lastRaw && this.rows) {
      return null;
    }
    this.lastRaw = text;
    if (text.includes("\0")) {
      this.problem = "Binary file.";
      return null;
    }
    const all = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
    return [`@@ -0,0 +1,${all.length} @@ new file`, ...all.map((line) => `+${line}`)];
  },

  async trackedLines(target) {
    const result = await git(diffArgs(target), { cwd: target.root, on: target.on });
    if (result.code !== 0) {
      this.problem = result.stderr.trim() || "git diff failed";
      return null;
    }
    // Unchanged since the last poll: skip splitting and parsing.
    if (result.stdout === this.lastRaw && this.rows) {
      return null;
    }
    this.lastRaw = result.stdout;
    const lines = result.stdout.replace(/\n$/, "").split("\n");
    const first = lines.findIndex((line) => line.startsWith("@@"));
    if (first < 0) {
      this.problem = /^Binary files/m.test(result.stdout) ? "Binary file changed." : "No changes to show here any more.";
      this.rows = null;
      this.hunks = null;
      this.adds = 0;
      this.dels = 0;
      return null;
    }
    const parts = splitHunks(lines);
    this.hunks = stageableScope(target) && !target.untracked && !isMergeDiff(parts.head) ? parts : null;
    return lines.slice(first);
  },

  applyLines(lines) {
    this.problem = null;
    this.truncated = lines.length > MAX_ROWS;
    this.rows = diffRows(lines.slice(0, MAX_ROWS).map((line) => line.replace(/\t/g, tabSpaces())));
    let hunkCount = 0;
    for (const row of this.rows) {
      if (row.kind === HUNK_ROW) {
        row.hunk = hunkCount++;
      }
    }
    // A truncated diff no longer matches the patch.
    if (this.truncated && this.hunks) {
      this.hunks = null;
    }
    this.hunk = Math.min(this.hunk ?? 0, Math.max(0, hunkCount - 1));
    this.pairs = splitRows(this.rows);
    this.adds = this.rows.filter((row) => row.kind === ADDED).length;
    this.dels = this.rows.filter((row) => row.kind === REMOVED).length;
  },

  loadDiff(cx) {
    const target = this.target;
    if (!target || this.loadingDiff) {
      return;
    }
    this.loadingDiff = true;
    cx.spawn(async (cx) => {
      try {
        const lines = target.untracked ? await this.untrackedLines(target) : await this.trackedLines(target);
        if (lines) {
          this.applyLines(lines);
        }
        await this.loadWorkingText(target, cx);
      } finally {
        this.loadingDiff = false;
        cx.notify();
      }
    });
  },

  lineNumbers(colors, row, side, size) {
    const number = (value) => div().w(size * NUMBER_WIDTH_FACTOR).flex_none().text_right().text_color(colors.dim).child(lineNumber(value));
    if (side === "inline") {
      return [number(row.old), number(row.next)];
    }
    return [number(side === "left" ? row.old : row.next)];
  },

  cell(colors, syntax, row, lang, side) {
    const size = codeSize();
    if (!row) {
      return div().flex_1().h_full().bg(tint(colors.raised, "80"));
    }
    const background = row.kind === ADDED ? tint(colors.ansi2, "1f") : row.kind === REMOVED ? tint(colors.ansi1, "1f") : null;
    const runs = lexCached(row.text, lang);
    return h_flex().flex_1().min_w(0).h_full().items_center().when(Boolean(background), (el) => el.bg(background))
      .children(this.lineNumbers(colors, row, side, size))
      .child(div().w(size * MARK_WIDTH_FACTOR).flex_none().text_center().text_color(kindColor(colors, row.kind)).child(row.kind === CONTEXT ? "" : row.kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(linkedRunChildren(runs, this.linkBase ? linksIn(row.text, this.linkBase) : [], {
          idPrefix: `${side}${row.old ?? ""}-${row.next ?? ""}`, colorOf: (run) => (run.kind ? syntax[run.kind] : colors.foreground), linkColor: colors.accent,
        })));
  },

  goHunk(step, cx) {
    const count = this.hunks?.hunks.length ?? 0;
    if (!count) {
      return;
    }
    this.hunk = (this.hunk + step + count) % count;
    const items = this.split ? this.pairs : this.rows;
    const index = items.findIndex((row) => row.kind === HUNK_ROW && row.hunk === this.hunk);
    if (index >= 0) {
      this.scroller.scroll_to_item(index, "top");
    }
    this.revealWorkingLine(this.hunks.hunks[this.hunk]);
    cx.notify();
  },

  // Line mapping: the editor scrolls to its cursor, so put it on the hunk's first new line.
  revealWorkingLine(hunk) {
    const line = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk?.[0] ?? "")?.[1]);
    if (!this.editor || !line) {
      return;
    }
    const offset = lineStartOffset(this.editor.value(), line);
    this.editor.set_selected_range({ start: offset, end: offset });
    this.editor.focus();
  },

  async loadWorkingText(target, cx) {
    if (!this.split || !this.editing || !editableTarget(target) || target !== this.target) {
      return;
    }
    const text = await readTextFile(`${target.root}/${target.path}`).catch(() => null);
    if (text === null || text.includes("\0") || target !== this.target) {
      return;
    }
    if (!this.editor) {
      this.openWorkingEditor(target, text, cx);
      return;
    }
    // Changed on disk while the buffer is clean: follow the file.
    if (this.editor.value() === this.saved && text !== this.saved) {
      this.saved = text;
      this.editor.set_value(text);
    }
  },

  openWorkingEditor(target, text, cx) {
    const colors = syntaxColors(theme());
    this.editor = EditorState.new({
      language: editorLanguageOf(target.path) ?? undefined, value: text, font_family: codeFont(), font_size: codeSize(), soft_wrap: codeWrap(),
      syntax: editorSyntax(colors),
    });
    this.saved = text;
    this.editorTarget = target;
    this.editor.on("change", (_event, cx) => {
      this.editedAt = Date.now();
      cx.notify();
    });
    this.editor.on("blur", (_event, cx) => this.autoSaveWorking(cx, true));
    cx.notify();
  },

  workingDirty() {
    return Boolean(this.editor) && this.editor.value() !== this.saved;
  },

  autoSaveWorking(cx, leaving = false) {
    if (!this.editor) {
      return;
    }
    const mode = getSetting("files", "autoSave", AUTOSAVE_DEFAULT);
    if (autoSaveDue({ mode, dirty: this.workingDirty(), writable: true, editedAt: this.editedAt ?? 0, now: Date.now(), blurred: leaving })) {
      this.saveWorking(cx, { quiet: true });
    }
  },

  // Leaving the file (another diff, inline layout) saves a dirty buffer, then drops the editor.
  releaseWorkingEditor(cx) {
    if (!this.editor) {
      return;
    }
    if (this.workingDirty()) {
      this.saveWorking(cx, { quiet: true });
    }
    this.editor.release();
    this.editor = null;
    this.editorTarget = null;
  },

  saveWorking(cx, { quiet = false } = {}) {
    const target = this.editorTarget;
    if (!this.editor || !target || !this.workingDirty() || this.savingWorking) {
      return;
    }
    const text = this.editor.value();
    const expected = this.saved;
    const name = target.path.split("/").pop();
    this.savingWorking = true;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${target.root}/${target.path}`, text, expected);
        if (this.editorTarget === target) {
          this.saved = text;
        }
        bump(target.root);
        if (!quiet) {
          toast(MOD, { title: `Saved ${name}`, level: "success", timeout: SUCCESS_TIMEOUT_MS });
        }
        // Realign: the left side and the hunks come from a fresh git diff.
        this.lastRaw = null;
        this.loadDiff(cx);
      } catch (error) {
        const body = STALE_WRITE.test(String(error)) ? "The file changed on disk since it was loaded. Undo your edit to follow the file." : String(error?.message ?? error);
        toast(MOD, { title: `Not saved: ${name}`, body, level: "error", timeout: ERROR_TIMEOUT_MS });
      } finally {
        this.savingWorking = false;
        cx.notify();
      }
    });
  },

  applyHunk(cx) {
    const target = this.target;
    const hunk = this.hunks?.hunks[this.hunk];
    if (!target || !hunk || this.applying) {
      return;
    }
    const unstage = target.scope === "staged";
    this.applying = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const patch = hunkPatch(this.hunks.head, hunk);
        const args = [...READ, "apply", "--cached", "--whitespace=nowarn", ...(unstage ? ["--reverse"] : [])];
        const result = await exec("sh", ["-c", APPLY, "herdr-vscode-apply", patch, ...args], { cwd: target.root, on: target.on ?? null });
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout).trim());
        }
        toast("herdr-vscode-changes", { title: unstage ? "Hunk unstaged" : "Hunk staged", body: target.path, level: "success", timeout: SUCCESS_TIMEOUT_MS });
        bump(target.root);
        this.lastLines = null;
        this.loadingDiff = false;
        this.loadDiff(cx);
      } catch (error) {
        toast("herdr-vscode-changes", { title: `${unstage ? "Unstage" : "Stage"} hunk failed`, body: String(error?.message ?? error).slice(-ERROR_TAIL), level: "error", timeout: ERROR_TIMEOUT_MS });
      } finally {
        this.applying = false;
        cx.notify();
      }
    });
  },

  hunkBar(colors) {
    const count = this.hunks.hunks.length;
    const unstage = this.target.scope === "staged";
    const color = unstage ? colors.ansi3 : colors.ansi2;
    return h_flex().flex_none().gap(2).items_center()
      .child(IconButton({ id: "h-prev", icon: "up", label: "Previous hunk", size: 20, onClick: (cx) => this.goHunk(-1, cx) }))
      .child(div().text_size(TEXT.caption).text_color(colors.muted).child(`${this.hunk + 1}/${count}`))
      .child(IconButton({ id: "h-next", icon: "chevron-down", label: "Next hunk", size: 20, onClick: (cx) => this.goHunk(1, cx) }))
      .child(h_flex().id("h-apply").h(22).ml(2).px(8).gap(5).items_center().rounded(6).cursor_pointer()
        .bg(tint(color, "26")).text_color(color).text_size(TEXT.caption).font_medium().hover((style) => style.bg(tint(color, "40")))
        .tooltip(unstage ? "Move this hunk back to the working changes (git apply --cached --reverse)" : "Stage only this hunk (git apply --cached)")
        .on_click((_e, cx) => this.applyHunk(cx))
        .child(this.applying ? Icon("spinner", 11).spin(SPIN_MS) : Icon(unstage ? "minus" : "plus", 11))
        .child(unstage ? "Unstage Hunk" : "Stage Hunk"));
  },

  setSplit(split, cx) {
    this.split = split;
    if (!split) {
      this.releaseWorkingEditor(cx);
    } else {
      this.loadWorkingText(this.target, cx).then(() => cx.notify());
    }
    setSetting("scm", "diffLayout", split ? DIFF_SPLIT : DIFF_INLINE);
    cx.notify();
  },

  // The Edit button: the right side becomes the working file's editor (saved on ⌘S / auto save), or back to the aligned rows.
  setEditing(editing, cx) {
    this.editing = editing;
    if (editing) {
      this.loadWorkingText(this.target, cx).then(() => cx.notify());
    } else {
      this.releaseWorkingEditor(cx);
    }
    cx.notify();
  },

  canEdit(target) {
    return editButtonOn() && this.split && editableTarget(target);
  },

  diffHeader(colors, target) {
    const name = target.path.split("/").pop();
    const dir = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(colors.border).text_size(TEXT.small)
      .child(FileIcon(this.icons, target.path, { size: 14 }))
      .child(div().flex_none().max_w(300).truncate().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(colors.dim).child(dir))
      .child(Badge(scopeLabel(target), scopeColor(colors, target.scope)))
      .when(Boolean(this.editor), (el) => el.child(div().text_size(TEXT.caption).text_color(this.workingDirty() ? colors.ansi3 : colors.dim)
        .child(this.workingDirty() ? "● edited (⌘S)" : "editable")))
      .when(Boolean(target.subject), (el) => el.child(div().max_w(260).truncate().text_color(colors.muted).child(target.subject)))
      .when(Boolean(this.rows), (el) => el.child(div().text_color(colors.ansi2).child(`+${this.adds}`)).child(div().text_color(colors.ansi1).child(`−${this.dels}`)))
      .when(Boolean(this.rows && this.hunks?.hunks.length), (el) => el.child(this.hunkBar(colors)))
      .when(this.canEdit(target), (el) => el.child(IconButton({ id: "d-edit", icon: "pencil", label: this.editing ? "Back to the aligned diff (read-only)" : "Edit the working file (not aligned with the left side)", active: this.editing, size: 22, onClick: (cx) => this.setEditing(!this.editing, cx) })))
      .child(IconButton({ id: "d-inline", icon: "inline", label: "Inline", active: !this.split, size: 22, onClick: (cx) => this.setSplit(false, cx) }))
      .child(IconButton({ id: "d-split", icon: "split", label: "Side by side", active: this.split, size: 22, onClick: (cx) => this.setSplit(true, cx) }));
  },

  hunkHeaderRow(colors, row, height) {
    const selected = this.hunks && row.hunk === this.hunk;
    return h_flex().h(height).w_full().px(10).gap(8).items_center().bg(selected ? tint(colors.accent, "2a") : colors.raised).text_color(colors.accent)
      .when(Boolean(selected), (el) => el.border_l_2().border_color(colors.accent))
      .child(div().flex_1().min_w(0).truncate().child(row.text))
      .when(Boolean(this.hunks), (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(selected ? colors.accent : colors.dim)
        .child(selected ? "● selected hunk" : "click to select")));
  },

  diffRow(colors, syntax, lang, height, row) {
    if (row.kind === HUNK_ROW) {
      return this.hunkHeaderRow(colors, row, height);
    }
    if (row.kind === "") {
      return h_flex().h(height).w_full().px(10).items_center().text_color(colors.dim).child(row.text);
    }
    if (this.split) {
      return h_flex().h(height).w_full().child(this.cell(colors, syntax, row.left, lang, "left")).child(div().w(1).h_full().bg(colors.border)).child(this.cell(colors, syntax, row.right, lang, "right"));
    }
    return h_flex().h(height).w_full().child(this.cell(colors, syntax, row, lang, "inline"));
  },

  selectHunkByKey(key, cx) {
    if (!key.startsWith(HUNK_KEY_PREFIX) || !this.hunks) {
      return;
    }
    this.hunk = Number(key.slice(HUNK_KEY_PREFIX.length));
    cx.notify();
  },

  // Split layout with an editable working tree: the HEAD/index side of each row on the left
  // (blank where the right only adds), the whole working file in the editor on the right.
  editableBody(colors, syntax, lang, size, height) {
    const items = this.pairs;
    const listId = `diff-${this.diffKey}-e`;
    const itemKey = (index) => (items[index]?.kind === HUNK_ROW ? `${HUNK_KEY_PREFIX}${items[index].hunk}` : `r${index}`);
    const leftRow = (row) => {
      if (row.kind === HUNK_ROW) {
        return this.hunkHeaderRow(colors, row, height);
      }
      if (row.kind === "") {
        return h_flex().h(height).w_full().px(10).items_center().text_color(colors.dim).child(row.text);
      }
      return h_flex().h(height).w_full().child(this.cell(colors, syntax, row.left, lang, "left"));
    };
    const drawRange = (range) => items.slice(range.start, range.end).map(leftRow);
    return h_flex().id("d-body").flex_1().min_h(0).font_family(codeFont()).text_size(size)
      .child(div().flex_1().min_w(0).h_full().relative()
        .child(v_virtual_list(listId, items.length, height, itemKey, drawRange)
          .track_scroll(this.scroller)
          .on_item_click((key, cx) => this.selectHunkByKey(key, cx))
          .size_full())
        .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()))
      .child(div().w(1).h_full().bg(colors.border))
      .child(div().id("d-editor").flex_1().min_w(0).h_full()
        .on_key_down((event, cx) => {
          if (event.key === "s" && event.modifiers?.platform) {
            cx.stop_propagation();
            this.saveWorking(cx);
          }
        })
        .child(Editor.new(this.editor).size_full()));
  },

  diffBody(colors, target) {
    const syntax = syntaxColors(colors);
    const lang = languageOf(target.path);
    const size = codeSize();
    const height = Math.round(size * codeLineHeight());
    if (this.split && this.editor) {
      return this.editableBody(colors, syntax, lang, size, height);
    }
    const items = this.split ? this.pairs : this.rows;
    const listId = `diff-${this.diffKey}-${this.split ? "s" : "i"}`;
    const itemKey = (index) => (items[index]?.kind === HUNK_ROW ? `${HUNK_KEY_PREFIX}${items[index].hunk}` : `r${index}`);
    const drawRange = (range) => items.slice(range.start, range.end).map((row) => this.diffRow(colors, syntax, lang, height, row));
    // Widest line sets the content width, so long lines scroll sideways instead of clipping.
    let widest = 0;
    for (const row of items) {
      const width = this.split ? (row.left?.text?.length ?? 0) + (row.right?.text?.length ?? 0) : (row.text?.length ?? 0);
      widest = Math.max(widest, width);
    }
    const minWidth = Math.max(DIFF_MIN_WIDTH, (widest * DIFF_CHAR_RATIO + DIFF_GUTTER) * size);
    return div().id("d-body").flex_1().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(div().id("d-x").size_full().overflow_x_scrollbar()
        .child(div().h_full().min_w(minWidth)
          .child(v_virtual_list(listId, items.length, height, itemKey, drawRange)
            .track_scroll(this.scroller)
            .on_item_click((key, cx) => this.selectHunkByKey(key, cx))
            .size_full())))
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  renderDiff() {
    const colors = theme();
    const target = this.target;
    const root = v_flex().id("herdr-vscode-diff").size_full().min_w(0).min_h(0).overflow_hidden().bg(colors.background).text_color(colors.foreground).text_size(TEXT.body);
    if (!target) {
      return root.child(Message("Pick a file in Changes to see its diff here."));
    }
    root.child(this.diffHeader(colors, target));
    if (this.problem) {
      return root.child(Message(this.problem));
    }
    if (!this.rows) {
      return root.child(Message("Loading…"));
    }
    root.child(this.diffBody(colors, target));
    if (this.truncated) {
      root.child(Message(`Showing the first ${MAX_ROWS} lines of the diff.`));
    }
    return root;
  },
};
