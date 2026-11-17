// The diff tab: one per space, showing the file last picked in Changes, inline or side by side,
// syntax-coloured. A new file is all additions; a conflicted file shows its working copy.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, readTextFile } from "herdr";
import { git } from "./ws.js";
import { diffRows, splitRows } from "./git-core.js";
import { lexLine, languageOf, syntaxColors } from "./syntax-core.js";
import { TEXT, IconButton, FileIcon, Message, Badge, codeFont, codeSize, tint } from "./ui.js";
import { viewerValue, viewerTab, keptTabs } from "./tabs.js";

const MOD = "vx-changes";
const MAX_ROWS = 6000;

export const diffMethods = {
  initDiff(p, cx) {
    this.viewSpace = p.space;
    // A tab opened directly (herdr-app do tab.new --mod vx-changes --props {...}) names its diff.
    this.propsTarget = p.target?.root && p.target?.path ? p.target : null;
    this.fixed = Boolean(p.fixed && this.propsTarget);
    this.split = localStorage.getItem("split") === "1";
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
          lines = lines.slice(first);
        }
        const text = JSON.stringify(lines);
        if (text === this.lastLines) return;
        this.lastLines = text;
        this.problem = null;
        this.truncated = lines.length > MAX_ROWS;
        this.rows = diffRows(lines.slice(0, MAX_ROWS).map((l) => l.replace(/\t/g, "    ")));
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
      if (r.kind === "@") return h_flex().h(height).w_full().px(10).items_center().bg(t.raised).text_color(t.accent).child(div().truncate().child(r.text));
      if (r.kind === "") return h_flex().h(height).w_full().px(10).items_center().text_color(t.dim).child(r.text);
      if (this.split) return h_flex().h(height).w_full().child(this.cell(t, C, r.left, lang, "left")).child(div().w(1).h_full().bg(t.border)).child(this.cell(t, C, r.right, lang, "right"));
      return h_flex().h(height).w_full().child(this.cell(t, C, r, lang, "inline"));
    };
    root.child(div().id("d-body").flex_1().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(v_virtual_list(listId, items.length, height, (i) => `r${i}`, (range) => items.slice(range.start, range.end).map(draw)).size_full())
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()));
    if (this.truncated) root.child(Message(`Showing the first ${MAX_ROWS} lines of the diff.`));
    return root;
  },
};
