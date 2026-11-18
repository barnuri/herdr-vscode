import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, readTextFile, exec, notify } from "herdr";
import { git, bump } from "./ws.js";
import { splitHunks, hunkPatch } from "./scm-core.js";
import { READ, diffRows, splitRows } from "./git-core.js";
import { lexLine, languageOf, syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, Badge, codeFont, codeSize, tint, SPIN_MS } from "./ui.js";
import { viewerValue, viewerTab, keptTabs } from "./tabs.js";

const MOD = "vx-changes";
const MAX_ROWS = 6000;
const POLL_MS = 2000;
const SPLIT_KEY = "split";
const SPLIT_ON = "1";
const SPLIT_OFF = "0";
const TAB_SPACES = "    ";
const SHORT_SHA = 8;
const ERROR_TAIL = 400;
const SUCCESS_TIMEOUT_MS = 2000;
const ERROR_TIMEOUT_MS = 6000;
const LINE_HEIGHT_FACTOR = 1.55;
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

const isMergeDiff = (head) => /^diff --(cc|combined)/.test(head[0] ?? "");

export const diffMethods = {
  initDiff(options, cx) {
    this.viewSpace = options.space;
    // A tab opened directly (herdr-app do tab.new --mod vx-changes --props {...}) names its diff.
    this.propsTarget = options.target?.root && options.target?.path ? options.target : null;
    this.fixed = Boolean(options.fixed && this.propsTarget);
    this.split = localStorage.getItem(SPLIT_KEY) === SPLIT_ON;
    this.scroller = VirtualListScrollHandle.new();
    cx.timer.every(POLL_MS, (cx) => this.syncDiff(cx, true));
    this.syncDiff(cx);
  },

  // A tab kept in place (vx-tabs) shows its own diff from then on.
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
      this.diffKey = key;
      this.target = target;
      this.rows = null;
      this.problem = null;
      this.hunk = 0;
      this.hunks = null;
    }
    this.loadDiff(cx);
  },

  async untrackedLines(target) {
    const text = await readTextFile(`${target.root}/${target.path}`, { on: target.on }).catch(() => null);
    if (text === null) {
      this.problem = "This file is gone, too large, or unreadable.";
      return null;
    }
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
    const lines = result.stdout.replace(/\n$/, "").split("\n");
    const first = lines.findIndex((line) => line.startsWith("@@"));
    if (first < 0) {
      this.problem = /^Binary files/m.test(result.stdout) ? "Binary file changed." : "No changes to show here any more.";
      return null;
    }
    const parts = splitHunks(lines);
    this.hunks = stageableScope(target) && !target.untracked && !isMergeDiff(parts.head) ? parts : null;
    return lines.slice(first);
  },

  applyLines(lines) {
    const text = JSON.stringify(lines);
    if (text === this.lastLines) {
      return;
    }
    this.lastLines = text;
    this.problem = null;
    this.truncated = lines.length > MAX_ROWS;
    this.rows = diffRows(lines.slice(0, MAX_ROWS).map((line) => line.replace(/\t/g, TAB_SPACES)));
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
    const runs = lexLine(row.text, lang).runs;
    return h_flex().flex_1().min_w(0).h_full().items_center().when(Boolean(background), (el) => el.bg(background))
      .children(this.lineNumbers(colors, row, side, size))
      .child(div().w(size * MARK_WIDTH_FACTOR).flex_none().text_center().text_color(kindColor(colors, row.kind)).child(row.kind === CONTEXT ? "" : row.kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(runs.map((run) => div().flex_none().whitespace_nowrap().text_color(run.kind ? syntax[run.kind] : colors.foreground).child(run.text || " "))));
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
    cx.notify();
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
        const result = await exec("sh", ["-c", APPLY, "vx-apply", patch, ...args], { cwd: target.root, on: target.on ?? null });
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout).trim());
        }
        notify({ title: unstage ? "Hunk unstaged" : "Hunk staged", body: target.path, level: "success", timeout: SUCCESS_TIMEOUT_MS });
        bump(target.root);
        this.lastLines = null;
        this.loadingDiff = false;
        this.loadDiff(cx);
      } catch (error) {
        notify({ title: `${unstage ? "Unstage" : "Stage"} hunk failed`, body: String(error?.message ?? error).slice(-ERROR_TAIL), level: "error", timeout: ERROR_TIMEOUT_MS });
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
    localStorage.setItem(SPLIT_KEY, split ? SPLIT_ON : SPLIT_OFF);
    cx.notify();
  },

  diffHeader(colors, target) {
    const name = target.path.split("/").pop();
    const dir = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
    return h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(colors.border).text_size(TEXT.small)
      .child(FileIcon(this.icons, target.path, { size: 14 }))
      .child(div().flex_none().max_w(300).truncate().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(colors.dim).child(dir))
      .child(Badge(scopeLabel(target), scopeColor(colors, target.scope)))
      .when(Boolean(target.subject), (el) => el.child(div().max_w(260).truncate().text_color(colors.muted).child(target.subject)))
      .when(Boolean(this.rows), (el) => el.child(div().text_color(colors.ansi2).child(`+${this.adds}`)).child(div().text_color(colors.ansi1).child(`−${this.dels}`)))
      .when(Boolean(this.rows && this.hunks?.hunks.length), (el) => el.child(this.hunkBar(colors)))
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

  diffBody(colors, target) {
    const syntax = syntaxColors(colors);
    const lang = languageOf(target.path);
    const size = codeSize();
    const height = Math.round(size * LINE_HEIGHT_FACTOR);
    const items = this.split ? this.pairs : this.rows;
    const listId = `diff-${this.diffKey}-${this.split ? "s" : "i"}`;
    const itemKey = (index) => (items[index]?.kind === HUNK_ROW ? `${HUNK_KEY_PREFIX}${items[index].hunk}` : `r${index}`);
    const drawRange = (range) => items.slice(range.start, range.end).map((row) => this.diffRow(colors, syntax, lang, height, row));
    return div().id("d-body").flex_1().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(v_virtual_list(listId, items.length, height, itemKey, drawRange)
        .track_scroll(this.scroller)
        .on_item_click((key, cx) => this.selectHunkByKey(key, cx))
        .size_full())
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  renderDiff() {
    const colors = theme();
    const target = this.target;
    const root = v_flex().id("vx-diff").size_full().min_w(0).min_h(0).overflow_hidden().bg(colors.background).text_color(colors.foreground).text_size(TEXT.body);
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
