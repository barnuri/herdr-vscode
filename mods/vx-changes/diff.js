// The diff tab: one per space, showing the file last picked in Changes, inline or side by side,
// syntax-coloured. A new file is all additions; a conflicted file shows its working copy.
// Working and staged diffs stage or unstage one hunk at a time (`git apply --cached`): click a
// hunk's @@ line or step with ‹ ›, then Stage Hunk / Unstage Hunk.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, readTextFile, exec, notify } from "herdr";
import { git, bump } from "./ws.js";
import { splitHunks, hunkPatch } from "./scm-core.js";
import { READ } from "./git-core.js";
import { diffRows, splitRows } from "./git-core.js";
import { lexLine, languageOf, syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, Badge, codeFont, codeSize, tint, SPIN_MS } from "./ui.js";
import { viewerValue, viewerTab, keptTabs } from "./tabs.js";

const MOD = "vx-changes";
const MAX_ROWS = 6000;
// Applies a patch to the index from a temp file; the patch travels as an argument, never as script.
const APPLY = 'f=$(mktemp) || exit 1; printf "%s" "$1" > "$f"; shift; git "$@" "$f"; c=$?; rm -f "$f"; exit $c';

export const diffMethods = {
  initDiff(p, cx) {
    this.viewSpace = p.space;
    // A tab opened directly (herdr-app do tab.new --mod vx-changes --props {...}) names its diff.
    this.propsTarget = p.target?.root && p.target?.path ? p.target : null;
    this.fixed = Boolean(p.fixed && this.propsTarget);
    this.split = localStorage.getItem("split") === "1";
    this.scroller = VirtualListScrollHandle.new();
    cx.timer.every(2000, (cx) => this.syncDiff(cx, true));
    this.syncDiff(cx);
  },

  syncDiff(cx, poll = false) {
    // Kept in place (vx-tabs): from then on this tab shows its own diff.
    if (!this.fixed) {
      this.myTab ??= viewerTab(MOD, this.viewSpace);
      const kept = this.myTab ? keptTabs()[this.myTab] : null;
      if (kept?.value?.path) {
        this.fixed = true;
        this.propsTarget = kept.value;
      }
    }
    const v = this.fixed ? this.propsTarget : viewerValue(MOD, this.viewSpace) ?? this.propsTarget;
    if (!v?.path) return;
    const key = `${v.on ?? ""}|${v.root}|${v.scope}|${v.sha ?? v.ref ?? v.base ?? ""}|${v.path}`;
    if (key !== this.diffKey) {
      this.diffKey = key;
      this.target = v;
      this.rows = null;
      this.problem = null;
      this.hunk = 0;
      this.hunks = null;
    } else if (!poll) return;
    this.loadDiff(cx);
  },

  loadDiff(cx) {
    const v = this.target;
    if (!v || this.loadingDiff) return;
    this.loadingDiff = true;
    cx.spawn(async (cx) => {
      try {
        let lines;
        if (v.untracked) {
          const text = await readTextFile(`${v.root}/${v.path}`, { on: v.on }).catch(() => null);
          if (text === null) return void (this.problem = "This file is gone, too large, or unreadable.");
          if (text.includes("\0")) return void (this.problem = "Binary file.");
          const all = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
          lines = [`@@ -0,0 +1,${all.length} @@ new file`, ...all.map((l) => `+${l}`)];
        } else {
          const plain = ["--no-ext-diff", "--no-textconv", "--no-color"];
          const args =
            v.scope === "commit" ? ["--literal-pathspecs", "show", "--format=", "-m", "--first-parent", ...plain, v.sha, "--", v.path]
            : v.scope === "stash" ? ["--literal-pathspecs", "diff", ...plain, `${v.ref}^1`, v.ref, "--", v.path]
            : v.scope === "compare" ? ["--literal-pathspecs", "diff", ...plain, `${v.base}...${v.head ?? "HEAD"}`, "--", v.path]
            : ["--literal-pathspecs", "diff", ...(v.scope === "staged" ? ["--cached"] : []), ...plain, "--", v.path];
          const r = await git(args, { cwd: v.root, on: v.on });
          if (r.code !== 0) return void (this.problem = r.stderr.trim() || "git diff failed");
          lines = r.stdout.replace(/\n$/, "").split("\n");
          const first = lines.findIndex((l) => l.startsWith("@@"));
          if (first < 0) return void (this.problem = /^Binary files/m.test(r.stdout) ? "Binary file changed." : "No changes to show here any more.");
          // Hunks can be staged on their own in working and staged diffs (not merge diffs).
          const parts = splitHunks(lines);
          this.hunks = (v.scope === "unstaged" || v.scope === "staged") && !v.untracked && !/^diff --(cc|combined)/.test(parts.head[0] ?? "") ? parts : null;
          lines = lines.slice(first);
        }
        const text = JSON.stringify(lines);
        if (text === this.lastLines) return;
        this.lastLines = text;
        this.problem = null;
        this.truncated = lines.length > MAX_ROWS;
        this.rows = diffRows(lines.slice(0, MAX_ROWS).map((l) => l.replace(/\t/g, "    ")));
        let k = 0;
        for (const r of this.rows) if (r.kind === "@") r.hunk = k++;
        if (this.truncated && this.hunks) this.hunks = null; // the rows wouldn't match the patch
        this.hunk = Math.min(this.hunk ?? 0, Math.max(0, k - 1));
        this.pairs = splitRows(this.rows);
        this.adds = this.rows.filter((r) => r.kind === "+").length;
        this.dels = this.rows.filter((r) => r.kind === "-").length;
      } finally {
        this.loadingDiff = false;
        cx.notify();
      }
    });
  },

  cell(t, C, r, lang, side) {
    const size = codeSize();
    if (!r) return div().flex_1().h_full().bg(tint(t.raised, "80"));
    const bg = r.kind === "+" ? tint(t.ansi2, "1f") : r.kind === "-" ? tint(t.ansi1, "1f") : null;
    const runs = lexLine(r.text, lang).runs;
    const num = side === "left" ? r.old : side === "right" ? r.next : null;
    return h_flex().flex_1().min_w(0).h_full().items_center().when(Boolean(bg), (el) => el.bg(bg))
      .when(side === "inline", (el) => el
        .child(div().w(size * 3).flex_none().text_right().text_color(t.dim).child(r.old !== undefined ? String(r.old) : ""))
        .child(div().w(size * 3).flex_none().text_right().text_color(t.dim).child(r.next !== undefined ? String(r.next) : "")))
      .when(side !== "inline", (el) => el.child(div().w(size * 3).flex_none().text_right().text_color(t.dim).child(num !== undefined ? String(num) : "")))
      .child(div().w(size * 1.6).flex_none().text_center().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(runs.map((x) => div().flex_none().whitespace_nowrap().text_color(x.kind ? C[x.kind] : t.foreground).child(x.text || " "))));
  },

  // ── hunks ──────────────────────────────────────────────────────────────────────────────
  goHunk(step, cx) {
    const n = this.hunks?.hunks.length ?? 0;
    if (!n) return;
    this.hunk = (this.hunk + step + n) % n;
    const items = this.split ? this.pairs : this.rows;
    const at = items.findIndex((r) => r.kind === "@" && r.hunk === this.hunk);
    if (at >= 0) this.scroller.scroll_to_item(at, "top");
    cx.notify();
  },

  applyHunk(cx) {
    const v = this.target;
    const h = this.hunks?.hunks[this.hunk];
    if (!v || !h || this.applying) return;
    const unstage = v.scope === "staged";
    this.applying = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const patch = hunkPatch(this.hunks.head, h);
        const args = [...READ, "apply", "--cached", "--whitespace=nowarn", ...(unstage ? ["--reverse"] : [])];
        const r = await exec("sh", ["-c", APPLY, "vx-apply", patch, ...args], { cwd: v.root, on: v.on ?? null });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: unstage ? "Hunk unstaged" : "Hunk staged", body: v.path, level: "success", timeout: 2000 });
        bump(v.root);
        this.lastLines = null;
        this.loadingDiff = false;
        this.loadDiff(cx);
      } catch (e) {
        notify({ title: `${unstage ? "Unstage" : "Stage"} hunk failed`, body: String(e?.message ?? e).slice(-400), level: "error", timeout: 6000 });
      } finally {
        this.applying = false;
        cx.notify();
      }
    });
  },

  hunkBar(t) {
    const n = this.hunks.hunks.length;
    const unstage = this.target.scope === "staged";
    const color = unstage ? t.ansi3 : t.ansi2;
    return h_flex().flex_none().gap(2).items_center()
      .child(IconButton({ id: "h-prev", icon: "up", label: "Previous hunk", size: 20, onClick: (cx) => this.goHunk(-1, cx) }))
      .child(div().text_size(TEXT.caption).text_color(t.muted).child(`${this.hunk + 1}/${n}`))
      .child(IconButton({ id: "h-next", icon: "chevron-down", label: "Next hunk", size: 20, onClick: (cx) => this.goHunk(1, cx) }))
      .child(h_flex().id("h-apply").h(22).ml(2).px(8).gap(5).items_center().rounded(6).cursor_pointer()
        .bg(tint(color, "26")).text_color(color).text_size(TEXT.caption).font_medium().hover((s) => s.bg(tint(color, "40")))
        .tooltip(unstage ? "Move this hunk back to the working changes (git apply --cached --reverse)" : "Stage only this hunk (git apply --cached)")
        .on_click((_e, cx) => this.applyHunk(cx))
        .child(this.applying ? Icon("spinner", 11).spin(SPIN_MS) : Icon(unstage ? "minus" : "plus", 11))
        .child(unstage ? "Unstage Hunk" : "Stage Hunk"));
  },

  renderDiff() {
    const t = theme();
    const v = this.target;
    const root = v_flex().id("vx-diff").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body);
    if (!v) return root.child(Message("Pick a file in Changes to see its diff here."));
    const name = v.path.split("/").pop();
    const dir = v.path.includes("/") ? v.path.slice(0, v.path.lastIndexOf("/")) : "";
    root.child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(FileIcon(this.icons, v.path, { size: 14 }))
      .child(div().flex_none().max_w(300).truncate().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(dir))
      .child(Badge(
        v.untracked ? "new"
          : v.scope === "commit" ? `commit ${String(v.sha).slice(0, 8)}`
          : v.scope === "stash" ? v.ref
          : v.scope === "compare" ? `${v.base}…${v.head ?? "HEAD"}`
          : v.scope,
        v.scope === "staged" ? t.ansi2 : v.scope === "commit" || v.scope === "compare" ? t.accent : t.ansi3))
      .when(Boolean(v.subject), (el) => el.child(div().max_w(260).truncate().text_color(t.muted).child(v.subject)))
      .when(Boolean(this.rows), (el) => el.child(div().text_color(t.ansi2).child(`+${this.adds}`)).child(div().text_color(t.ansi1).child(`−${this.dels}`)))
      .when(Boolean(this.rows && this.hunks?.hunks.length), (el) => el.child(this.hunkBar(t)))
      .child(IconButton({ id: "d-inline", icon: "inline", label: "Inline", active: !this.split, size: 22, onClick: (cx) => { this.split = false; localStorage.setItem("split", "0"); cx.notify(); } }))
      .child(IconButton({ id: "d-split", icon: "split", label: "Side by side", active: this.split, size: 22, onClick: (cx) => { this.split = true; localStorage.setItem("split", "1"); cx.notify(); } })));
    if (this.problem) return root.child(Message(this.problem));
    if (!this.rows) return root.child(Message("Loading…"));
    const C = syntaxColors(t);
    const lang = languageOf(v.path);
    const size = codeSize();
    const height = Math.round(size * 1.55);
    const items = this.split ? this.pairs : this.rows;
    const listId = `diff-${this.diffKey}-${this.split ? "s" : "i"}`;
    const draw = (r) => {
      if (r.kind === "@") {
        const sel = this.hunks && r.hunk === this.hunk;
        return h_flex().h(height).w_full().px(10).gap(8).items_center().bg(sel ? tint(t.accent, "2a") : t.raised).text_color(t.accent)
          .when(Boolean(sel), (el) => el.border_l_2().border_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().child(r.text))
          .when(Boolean(this.hunks), (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(sel ? t.accent : t.dim)
            .child(sel ? "● selected hunk" : "click to select")));
      }
      if (r.kind === "") return h_flex().h(height).w_full().px(10).items_center().text_color(t.dim).child(r.text);
      if (this.split) return h_flex().h(height).w_full().child(this.cell(t, C, r.left, lang, "left")).child(div().w(1).h_full().bg(t.border)).child(this.cell(t, C, r.right, lang, "right"));
      return h_flex().h(height).w_full().child(this.cell(t, C, r, lang, "inline"));
    };
    root.child(div().id("d-body").flex_1().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(v_virtual_list(listId, items.length, height, (i) => (items[i]?.kind === "@" ? `h${items[i].hunk}` : `r${i}`), (range) => items.slice(range.start, range.end).map(draw))
        .track_scroll(this.scroller)
        .on_item_click((key, cx) => {
          if (!key.startsWith("h") || !this.hunks) return;
          this.hunk = Number(key.slice(1));
          cx.notify();
        }).size_full())
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()));
    if (this.truncated) root.child(Message(`Showing the first ${MAX_ROWS} lines of the diff.`));
    return root;
  },
};
