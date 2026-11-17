// vx-search: VS Code's Search view (⌘⇧F) for every root of the workspace. `git grep
// --untracked` per repo (tracked and new files, .gitignore respected, binaries skipped), with
// Match Case, Whole Word and Regular Expression toggles and "files to include" globs.
// Results group by repo and file; a match opens the file preview at its line.
// Keys: vx-search.focus puts the cursor in the search box (vx-activity.search does it).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, nextCommand, checking } from "herdr";
import { workspace, git, ctx, baseName } from "./ws.js";
import { grepArgs, parseGrep, matchSnippet } from "./search-core.js";
import { showInViewer } from "./tabs.js";
import { TEXT, Icon, FileIcon, RootIcon, tint } from "./ui.js";
import { loadIcons } from "./icons.js";

const ROW = 22;
const MAX = 5000; // in all
const PER_REPO = 1000; // so one big repo can't fill the list
const DEBOUNCE_MS = 300;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class VxSearch extends View {
  init(_props, cx) {
    loadIcons(this, cx);
    this.opts = { caseSensitive: false, word: false, regex: false };
    try {
      Object.assign(this.opts, JSON.parse(localStorage.getItem("opts") ?? "{}"));
    } catch {}
    this.collapsed = new Set();
    this.showInclude = false;
    this.query = InputState.new({ placeholder: "Search" });
    this.include = InputState.new({ placeholder: "files to include, e.g. *.ts, src/" });
    this.query.on("change", (_e, cx) => this.schedule(cx));
    this.query.on("submit", (_e, cx) => this.runSearch(cx));
    this.include.on("change", (_e, cx) => this.schedule(cx));
    this.result = null;
    this.gen = 0;
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.query.focus();
        cx.notify();
      }
    });
  }

  toggle(key, cx) {
    this.opts[key] = !this.opts[key];
    try {
      localStorage.setItem("opts", JSON.stringify(this.opts));
    } catch {}
    this.runSearch(cx);
  }

  schedule(cx) {
    const gen = ++this.gen;
    cx.timer.after(DEBOUNCE_MS, (cx) => { if (gen === this.gen) this.runSearch(cx); });
  }

  roots() {
    const ws = workspace()?.roots ?? [];
    if (ws.length) return ws;
    const c = ctx();
    return c.cwd ? [{ name: baseName(c.cwd), path: c.cwd }] : [];
  }

  runSearch(cx) {
    const q = this.query.value();
    const gen = ++this.gen;
    if (!q.trim()) {
      this.result = null;
      this.rowsCache = [];
      this.searching = false;
      cx.notify();
      return;
    }
    if (this.opts.regex) {
      try {
        new RegExp(q);
        this.badRegex = null;
      } catch (e) {
        this.badRegex = String(e.message ?? e);
        this.result = null;
        this.rowsCache = [];
        cx.notify();
        return;
      }
    } else this.badRegex = null;
    this.searching = true;
    cx.notify();
    const args = grepArgs(q, { ...this.opts, include: this.include.value() });
    const roots = this.roots();
    cx.spawn(async (cx) => {
      const groups = await Promise.all(roots.map(async (root) => {
        let r = await git(args, { cwd: root.path, timeout: 20000 }).catch(() => null);
        // A git without PCRE: the same search with POSIX extended regexes.
        if (r?.code === 128 && /perl|pcre/i.test(r.stderr ?? "")) r = await git(grepArgs(q, { ...this.opts, include: this.include.value(), perl: false }), { cwd: root.path, timeout: 20000 }).catch(() => null);
        return { root, ...parseGrep(r?.code === 0 ? r.stdout : "", { maxMatches: PER_REPO }) };
      }));
      if (gen !== this.gen) return;
      let total = 0;
      let truncated = false;
      const out = [];
      for (const g of groups) {
        if (!g.files.length) continue;
        if (total >= MAX) {
          truncated = true;
          break;
        }
        total += g.total;
        truncated ||= g.truncated;
        out.push(g);
      }
      this.result = { groups: out, total, files: out.reduce((n, g) => n + g.files.length, 0), truncated, q, opts: { ...this.opts } };
      this.collapsed.clear();
      this.rowsCache = this.rows();
      this.resultGen = (this.resultGen ?? 0) + 1;
      this.searching = false;
      cx.notify();
    });
  }

  // The flat row list the virtual list draws: repo headers, files, matches.
  rows() {
    const r = this.result;
    if (!r) return [];
    const multi = r.groups.length > 1 || (workspace()?.roots ?? []).length > 1;
    const rows = [];
    for (const g of r.groups) {
      const gk = `g:${g.root.path}`;
      if (multi) rows.push({ kind: "root", key: gk, g });
      if (multi && this.collapsed.has(gk)) continue;
      for (const f of g.files) {
        const fk = `f:${g.root.path}:${f.rel}`;
        rows.push({ kind: "file", key: fk, g, f, indent: multi ? 1 : 0 });
        if (this.collapsed.has(fk)) continue;
        for (const m of f.matches) rows.push({ kind: "match", key: `${fk}:${m.line}:${m.col}`, g, f, m, indent: multi ? 2 : 1 });
      }
    }
    return rows;
  }

  matchLength(text, col) {
    const r = this.result;
    try {
      const re = new RegExp(r.opts.regex ? r.q : escapeRe(r.q), r.opts.caseSensitive ? "" : "i");
      const m = re.exec(text.slice(col - 1));
      return m && m.index === 0 ? Math.max(1, m[0].length) : r.q.length;
    } catch {
      return r.q.length;
    }
  }

  // A click on a row (the virtual list reports its key; rows can't carry handlers).
  clickRow(key, cx) {
    const row = this.rowsCache?.find((r) => r.key === key);
    if (!row) return;
    if (row.kind === "match") return showInViewer("vx-files", { root: row.g.root.path, on: null, rel: row.f.rel, line: row.m.line }, baseName(row.f.rel));
    this.collapsed.has(key) ? this.collapsed.delete(key) : this.collapsed.add(key);
    this.rowsCache = this.rows();
    cx.notify();
  }

  drawRow(t, row) {
    const pad = 8 + (row.indent ?? 0) * 14;
    if (row.kind === "root") {
      const n = row.g.files.reduce((a, f) => a + f.matches.length, 0);
      return h_flex().id(row.key).h(ROW).w_full().px(6).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .child(Icon(this.collapsed.has(row.key) ? "chevron-right" : "chevron-down", 13).text_color(t.muted))
        .child(RootIcon(!this.collapsed.has(row.key), 14))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(row.g.root.name))
        .child(div().px(5).rounded(8).bg(t.raised).text_size(TEXT.caption).text_color(t.muted).child(String(n)));
    }
    if (row.kind === "file") {
      const name = baseName(row.f.rel);
      const dir = row.f.rel.includes("/") ? row.f.rel.slice(0, row.f.rel.lastIndexOf("/")) : "";
      return h_flex().id(row.key).h(ROW).w_full().pl(pad).pr(6).gap(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .child(Icon(this.collapsed.has(row.key) ? "chevron-right" : "chevron-down", 13).text_color(t.muted))
        .child(FileIcon(this.icons, row.f.rel, { size: 14 }))
        .child(div().flex_none().max_w(170).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(dir))
        .child(div().px(5).rounded(8).bg(t.raised).text_size(TEXT.caption).text_color(t.muted).child(String(row.f.matches.length)));
    }
    const { m, f, g } = row;
    const sn = matchSnippet(m.text, m.col, this.matchLength(m.text, m.col), { before: 12 });
    return h_flex().id(row.key).h(ROW).w_full().pl(pad + 18).pr(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(TEXT.small)
        .child(div().flex_none().whitespace_nowrap().text_color(t.muted).child(sn.head))
        .child(div().flex_none().whitespace_nowrap().rounded(2).bg(tint(t.ansi3, "40")).text_color(t.foreground).child(sn.hit))
        .child(div().flex_none().whitespace_nowrap().text_color(t.muted).child(sn.tail)))
      .child(div().flex_none().pl(6).text_size(TEXT.caption).text_color(t.dim).child(String(m.line)));
  }

  render() {
    const t = theme();
    const r = this.result;
    const opt = (key, label, tip) => div().id(`opt-${key}`).h(20).min_w(22).px(3).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_size(11).font_medium().tooltip(tip)
      .when(this.opts[key], (el) => el.bg(tint(t.accent, "33")).border_1().border_color(t.accent).text_color(t.foreground))
      .when(!this.opts[key], (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.toggle(key, cx)).child(label);
    const rows = this.rowsCache ?? [];
    const listId = `search-${this.resultGen ?? 0}`;
    const note = this.badRegex ? `Invalid regular expression: ${this.badRegex}`
      : this.searching ? "Searching…"
      : r ? (r.total ? `${r.total}${r.truncated ? "+" : ""} result${r.total === 1 ? "" : "s"} in ${r.files} file${r.files === 1 ? "" : "s"}${r.truncated ? " (up to 1,000 per repo: narrow the search)" : ""}` : "No results found.")
      : "";
    return v_flex().id("vx-search").size_full().bg(t.chrome).text_color(t.foreground).text_size(TEXT.small)
      .child(v_flex().flex_none().px(8).pt(4).pb(6).gap(4)
        .child(h_flex().gap(4).items_center()
          .child(h_flex().flex_1().min_w(0).h(26).pl(6).pr(3).gap(2).items_center().rounded(5).border_1().border_color(t.border).bg(t.background)
            .child(Input.new(this.query).flex_1().h(24).text_size(TEXT.small))
            .child(opt("caseSensitive", "Aa", "Match Case"))
            .child(opt("word", "ab", "Match Whole Word"))
            .child(opt("regex", ".*", "Use Regular Expression")))
          .child(div().id("s-more").size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .text_color(this.showInclude ? t.foreground : t.dim).hover((s) => s.bg(t.hover)).tooltip("Toggle Search Details")
            .on_click((_e, cx) => { this.showInclude = !this.showInclude; cx.notify(); }).child(Icon("more", 14))))
        .when(this.showInclude, (el) => el.child(h_flex().h(24).pl(6).pr(3).items_center().rounded(5).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.include).flex_1().h(22).text_size(TEXT.caption))))
        .when(Boolean(note), (el) => el.child(div().pt(2).text_size(TEXT.caption).text_color(this.badRegex ? t.ansi1 : t.dim).child(note))))
      .child(div().id("s-results").flex_1().min_h(0).relative()
        .child(v_virtual_list(listId, rows.length, ROW, (i) => rows[i]?.key ?? `r${i}`, (range) => rows.slice(range.start, range.end).map((row) => this.drawRow(t, row)))
          .on_item_click((key, cx) => this.clickRow(key, cx)).size_full())
        .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()));
  }
}

export default VxSearch;
