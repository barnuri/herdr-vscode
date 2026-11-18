import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, nextCommand, checking } from "herdr";
import { workspace, git, ctx, baseName } from "./ws.js";
import { grepArgs, parseGrep, matchSnippet } from "./search-core.js";
import { showInViewer } from "./tabs.js";
import { TEXT, Icon, FileIcon, RootIcon, tint } from "./ui.js";
import { loadIcons } from "./icons.js";

export default class HerdrVscodeSearch extends View {
  static ROW_HEIGHT = 22;
  static MAX_MATCHES = 5000;
  // Caps each repo so one big repo can't fill the list.
  static MAX_MATCHES_PER_REPO = 1000;
  static DEBOUNCE_MS = 300;
  static GREP_TIMEOUT_MS = 20000;
  static GIT_USAGE_ERROR = 128;
  static INDENT_PX = 14;
  static ROW_PAD_PX = 8;
  static MATCH_EXTRA_PAD_PX = 18;
  static SNIPPET_CONTEXT = 12;
  static HIT_ALPHA = "40";
  static OPTION_ALPHA = "33";
  static OPTS_KEY = "opts";

  static escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static plural(count, word) {
    return `${word}${count === 1 ? "" : "s"}`;
  }

  static summary(result) {
    if (!result.total) {
      return "No results found.";
    }
    const more = result.truncated ? "+" : "";
    const cap = result.truncated ? " (up to 1,000 per repo: narrow the search)" : "";
    return `${result.total}${more} ${HerdrVscodeSearch.plural(result.total, "result")} in ${result.files} ${HerdrVscodeSearch.plural(result.files, "file")}${cap}`;
  }

  static dirOf(rel) {
    return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  }

  init(_props, cx) {
    loadIcons(this, cx);
    this.opts = { caseSensitive: false, word: false, regex: false };
    try {
      Object.assign(this.opts, JSON.parse(localStorage.getItem(HerdrVscodeSearch.OPTS_KEY) ?? "{}"));
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
    if (checking()) {
      return;
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.query.focus();
        }
        cx.notify();
      }
    });
  }

  toggle(key, cx) {
    this.opts[key] = !this.opts[key];
    try {
      localStorage.setItem(HerdrVscodeSearch.OPTS_KEY, JSON.stringify(this.opts));
    } catch {}
    this.runSearch(cx);
  }

  schedule(cx) {
    const gen = ++this.gen;
    cx.timer.after(HerdrVscodeSearch.DEBOUNCE_MS, (cx) => {
      if (gen === this.gen) {
        this.runSearch(cx);
      }
    });
  }

  roots() {
    const roots = workspace()?.roots ?? [];
    if (roots.length) {
      return roots;
    }
    const context = ctx();
    return context.cwd ? [{ name: baseName(context.cwd), path: context.cwd }] : [];
  }

  clearResult() {
    this.result = null;
    this.rowsCache = [];
  }

  // Returns false (and records the error) when the query is an invalid regex.
  validateRegex(query) {
    this.badRegex = null;
    if (!this.opts.regex) {
      return true;
    }
    try {
      new RegExp(query);
      return true;
    } catch (error) {
      this.badRegex = String(error.message ?? error);
      return false;
    }
  }

  runSearch(cx) {
    const query = this.query.value();
    const gen = ++this.gen;
    if (!query.trim()) {
      this.clearResult();
      this.searching = false;
      cx.notify();
      return;
    }
    if (!this.validateRegex(query)) {
      this.clearResult();
      cx.notify();
      return;
    }
    this.searching = true;
    cx.notify();
    const roots = this.roots();
    const include = this.include.value();
    cx.spawn(async (cx) => {
      const groups = await Promise.all(roots.map((root) => this.searchRoot(root, query, include)));
      if (gen !== this.gen) {
        return;
      }
      this.showGroups(groups, query);
      cx.notify();
    });
  }

  async searchRoot(root, query, include) {
    const grep = (args) => git(args, { cwd: root.path, timeout: HerdrVscodeSearch.GREP_TIMEOUT_MS }).catch(() => null);
    let result = await grep(grepArgs(query, { ...this.opts, include }));
    // A git without PCRE gets the same search with POSIX extended regexes.
    if (result?.code === HerdrVscodeSearch.GIT_USAGE_ERROR && /perl|pcre/i.test(result.stderr ?? "")) {
      result = await grep(grepArgs(query, { ...this.opts, include, perl: false }));
    }
    return { root, ...parseGrep(result?.code === 0 ? result.stdout : "", { maxMatches: HerdrVscodeSearch.MAX_MATCHES_PER_REPO }) };
  }

  showGroups(groups, query) {
    let total = 0;
    let truncated = false;
    const shown = [];
    for (const group of groups.filter((candidate) => candidate.files.length)) {
      if (total >= HerdrVscodeSearch.MAX_MATCHES) {
        truncated = true;
        break;
      }
      total += group.total;
      truncated ||= group.truncated;
      shown.push(group);
    }
    const files = shown.reduce((count, group) => count + group.files.length, 0);
    this.result = { groups: shown, total, files, truncated, q: query, opts: { ...this.opts } };
    this.collapsed.clear();
    this.rowsCache = this.rows();
    this.resultGen = (this.resultGen ?? 0) + 1;
    this.searching = false;
  }

  // The flat row list the virtual list draws: repo headers, files and matches.
  rows() {
    const result = this.result;
    if (!result) {
      return [];
    }
    const multi = result.groups.length > 1 || (workspace()?.roots ?? []).length > 1;
    const rows = [];
    for (const group of result.groups) {
      const groupKey = `g:${group.root.path}`;
      if (multi) {
        rows.push({ kind: "root", key: groupKey, g: group });
      }
      if (multi && this.collapsed.has(groupKey)) {
        continue;
      }
      rows.push(...this.fileRows(group, multi ? 1 : 0));
    }
    return rows;
  }

  fileRows(group, indent) {
    const rows = [];
    for (const file of group.files) {
      const fileKey = `f:${group.root.path}:${file.rel}`;
      rows.push({ kind: "file", key: fileKey, g: group, f: file, indent });
      if (this.collapsed.has(fileKey)) {
        continue;
      }
      rows.push(...file.matches.map((match) => ({ kind: "match", key: `${fileKey}:${match.line}:${match.col}`, g: group, f: file, m: match, indent: indent + 1 })));
    }
    return rows;
  }

  matchLength(text, col) {
    const result = this.result;
    try {
      const pattern = new RegExp(result.opts.regex ? result.q : HerdrVscodeSearch.escapeRegex(result.q), result.opts.caseSensitive ? "" : "i");
      const match = pattern.exec(text.slice(col - 1));
      return match && match.index === 0 ? Math.max(1, match[0].length) : result.q.length;
    } catch {
      return result.q.length;
    }
  }

  // The virtual list reports the clicked row's key, because rows can't carry handlers.
  clickRow(key, cx) {
    const row = this.rowsCache?.find((candidate) => candidate.key === key);
    if (!row) {
      return;
    }
    if (row.kind === "match") {
      showInViewer("herdr-vscode-files", { root: row.g.root.path, on: null, rel: row.f.rel, line: row.m.line }, baseName(row.f.rel));
      return;
    }
    if (this.collapsed.has(key)) {
      this.collapsed.delete(key);
    } else {
      this.collapsed.add(key);
    }
    this.rowsCache = this.rows();
    cx.notify();
  }

  countBadge(t, count) {
    return div().px(5).rounded(8).bg(t.raised).text_size(TEXT.caption).text_color(t.muted).child(String(count));
  }

  chevron(t, key) {
    return Icon(this.collapsed.has(key) ? "chevron-right" : "chevron-down", 13).text_color(t.muted);
  }

  drawRootRow(t, row) {
    const count = row.g.files.reduce((sum, file) => sum + file.matches.length, 0);
    return h_flex().id(row.key).h(HerdrVscodeSearch.ROW_HEIGHT).w_full().px(6).gap(5).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
      .child(this.chevron(t, row.key))
      .child(RootIcon(!this.collapsed.has(row.key), 14))
      .child(div().flex_1().min_w(0).truncate().font_medium().child(row.g.root.name))
      .child(this.countBadge(t, count));
  }

  drawFileRow(t, row, pad) {
    return h_flex().id(row.key).h(HerdrVscodeSearch.ROW_HEIGHT).w_full().pl(pad).pr(6).gap(5).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
      .child(this.chevron(t, row.key))
      .child(FileIcon(this.icons, row.f.rel, { size: 14 }))
      .child(div().flex_none().max_w(170).truncate().child(baseName(row.f.rel)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(HerdrVscodeSearch.dirOf(row.f.rel)))
      .child(this.countBadge(t, row.f.matches.length));
  }

  drawMatchRow(t, row, pad) {
    const match = row.m;
    const snippet = matchSnippet(match.text, match.col, this.matchLength(match.text, match.col), { before: HerdrVscodeSearch.SNIPPET_CONTEXT });
    const part = () => div().flex_none().whitespace_nowrap();
    return h_flex().id(row.key).h(HerdrVscodeSearch.ROW_HEIGHT).w_full().pl(pad + HerdrVscodeSearch.MATCH_EXTRA_PAD_PX).pr(6).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(TEXT.small)
        .child(part().text_color(t.muted).child(snippet.head))
        .child(part().rounded(2).bg(tint(t.ansi3, HerdrVscodeSearch.HIT_ALPHA)).text_color(t.foreground).child(snippet.hit))
        .child(part().text_color(t.muted).child(snippet.tail)))
      .child(div().flex_none().pl(6).text_size(TEXT.caption).text_color(t.dim).child(String(match.line)));
  }

  drawRow(t, row) {
    const pad = HerdrVscodeSearch.ROW_PAD_PX + (row.indent ?? 0) * HerdrVscodeSearch.INDENT_PX;
    if (row.kind === "root") {
      return this.drawRootRow(t, row);
    }
    if (row.kind === "file") {
      return this.drawFileRow(t, row, pad);
    }
    return this.drawMatchRow(t, row, pad);
  }

  note() {
    if (this.badRegex) {
      return `Invalid regular expression: ${this.badRegex}`;
    }
    if (this.searching) {
      return "Searching…";
    }
    return this.result ? HerdrVscodeSearch.summary(this.result) : "";
  }

  optionToggle(t, key, label, tip) {
    return div().id(`opt-${key}`).h(20).min_w(22).px(3).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_size(TEXT.caption).font_medium().tooltip(tip)
      .when(this.opts[key], (el) => el.bg(tint(t.accent, HerdrVscodeSearch.OPTION_ALPHA)).border_1().border_color(t.accent).text_color(t.foreground))
      .when(!this.opts[key], (el) => el.text_color(t.muted).hover((style) => style.bg(t.hover)))
      .on_click((_e, cx) => this.toggle(key, cx)).child(label);
  }

  searchBox(t) {
    const note = this.note();
    return v_flex().flex_none().px(8).pt(4).pb(6).gap(4)
      .child(h_flex().gap(4).items_center()
        .child(h_flex().flex_1().min_w(0).h(26).pl(6).pr(3).gap(2).items_center().rounded(5).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.query).flex_1().h(24).text_size(TEXT.small))
          .child(this.optionToggle(t, "caseSensitive", "Aa", "Match Case"))
          .child(this.optionToggle(t, "word", "ab", "Match Whole Word"))
          .child(this.optionToggle(t, "regex", ".*", "Use Regular Expression")))
        .child(div().id("s-more").size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_color(this.showInclude ? t.foreground : t.dim).hover((style) => style.bg(t.hover)).tooltip("Toggle Search Details")
          .on_click((_e, cx) => {
            this.showInclude = !this.showInclude;
            cx.notify();
          })
          .child(Icon("more", 14))))
      .when(this.showInclude, (el) => el.child(h_flex().h(24).pl(6).pr(3).items_center().rounded(5).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(this.include).flex_1().h(22).text_size(TEXT.caption))))
      .when(Boolean(note), (el) => el.child(div().pt(2).text_size(TEXT.caption).text_color(this.badRegex ? t.ansi1 : t.dim).child(note)));
  }

  render() {
    const t = theme();
    const rows = this.rowsCache ?? [];
    const listId = `search-${this.resultGen ?? 0}`;
    const rowKey = (index) => rows[index]?.key ?? `r${index}`;
    const drawRange = (range) => rows.slice(range.start, range.end).map((row) => this.drawRow(t, row));
    return v_flex().id("herdr-vscode-search").size_full().bg(t.chrome).text_color(t.foreground).text_size(TEXT.small)
      .child(this.searchBox(t))
      .child(div().id("s-results").flex_1().min_h(0).relative()
        .child(v_virtual_list(listId, rows.length, HerdrVscodeSearch.ROW_HEIGHT, rowKey, drawRange)
          .on_item_click((key, cx) => this.clickRow(key, cx)).size_full())
        .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()));
  }
}
