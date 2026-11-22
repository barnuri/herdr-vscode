import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, run, closeOverlay, props, shared, setShared, spaces, readTextFile, commands, keys, window, exec } from "herdr";
import { workspace, git, baseName, ctx, rootFor } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { describeTab } from "./kinds.js";
import { rankFiles, matchPath, runsOf, parseQuery, symbolsOf, commandLabel, keyLabel, actionToRun, prepareFiles, scoreSlice, topFiles, queryWords } from "./quickopen-core.js";
import { grepArgs, parseGrep, matchSnippet } from "./search-core.js";
import { Icon, FileIcon, tint } from "./ui.js";

// A typed path: absolute (/x), home (~/x), dot-relative (./x, ../x) or any path with a slash.
const isPathQuery = (text) => /^(~\/?|\/|\.{1,2}\/)/.test(text) || text.includes("/");

export const QO_ROW = 24;
export const QO_ROWS = 18;
export const QO_HEAD = 38;
const RECENT_KEY = "herdr-vscode.goto.recent";
const CMD_RECENT_KEY = "herdr-vscode.cmd.recent";
const PLACEHOLDER = "Search files by name, or type a path (/abs, ~/x, ../x) (append : to go to line or @ to go to symbol)";
const PATH_SCRIPT = 'p="$1"; case "$p" in "~"|"~/"*) p="$HOME${p#\\~}";; /*) ;; *) p="$2/$p";; esac; d=$(dirname -- "$p") && [ -f "$p" ] && cd -- "$d" && printf "%s/%s" "$(pwd -P)" "$(basename -- "$p")"';
const SLICE = 2500;
const MAX_FILE_HITS = 200;
const MAX_TEXT_HITS = 200;
const MAX_COMMANDS = 300;
const MAX_RECENT_FILES = 50;
const MAX_RECENT_HITS = 20;
const MAX_RECENT_COMMANDS = 12;
const TEXT_SEARCH_DELAY_MS = 250;
const TEXT_SEARCH_TIMEOUT_MS = 15000;
const SNIPPET = { before: 20, width: 90 };
const KEY_SECTIONS = ["layout:herdr-vscode", "global"];
const MIN_THUMB_HEIGHT = 18;

// herdr-vscode's own commands: mods' commands aren't in commands().
const VX_COMMANDS = [
  ["herdr-vscode-titlebar.goto", "Go to File…"],
  ["herdr-vscode-activity.explorer", "View: Show Explorer"],
  ["herdr-vscode-activity.search", "View: Show Search"],
  ["herdr-vscode-activity.scm", "View: Show Source Control"],
  ["herdr-vscode-activity.ci", "View: Show CI / CD"],
  ["herdr-vscode-activity.spaces", "View: Show Spaces"],
  ["herdr-vscode-activity.agents", "View: Show Agents"],
  ["herdr-vscode-activity.panel", "View: Toggle Panel"],
  ["herdr-vscode-activity.problems", "View: Show Problems"],
  ["herdr-vscode-activity.terminal", "View: Show Terminal"],
  ["herdr-vscode-activity.ports", "View: Show Ports"],
  ["herdr-vscode-activity.newterm", "Terminal: Create New Terminal in the Panel"],
  ["herdr-vscode-activity.checks", "Problems: Run Checks (typecheck + lint)"],
  ["herdr-vscode-tabs.switch", "View: Quick Open Previous Tab"],
  ["herdr-vscode-tabs.list", "View: Show All Tabs"],
  ["herdr-vscode-files.edit", "File: Edit / Stop Editing"],
  ["herdr-vscode-files.save", "File: Save"],
  ["herdr-vscode-titlebar.symbols", "Go to Symbol in Editor…"],
  ["herdr-vscode-titlebar.line", "Go to Line…"],
  ["herdr-vscode-titlebar.back", "Go Back"],
  ["herdr-vscode-titlebar.forward", "Go Forward"],
];
const HELP = [
  ["", "Go to File"],
  [":", "Go to Line"],
  ["@", "Go to Symbol in Editor"],
  [">", "Show and Run Commands"],
  ["%", "Search for Text"],
];
const SYMBOL_LOOK = {
  class: ["◆", "ansi3"], interface: ["◇", "ansi4"], enum: ["E", "ansi3"], type: ["T", "ansi4"],
  function: ["ƒ", "ansi5"], method: ["ƒ", "ansi5"], variable: ["x", "ansi6"], heading: ["#", "muted"],
};
const DEFAULT_SYMBOL_LOOK = ["•", "muted"];

const sameFile = (a, b) => a.root.path === b.root.path && a.rel === b.rel;
const plain = (text) => [{ text, hit: false }];
const note = (text, desc = []) => [{ kind: "note", key: "n", label: plain(text), desc }];
const isFileMode = (kind) => kind === "preview" || kind === "diff";
const withoutFile = (list, file) => list.filter((entry) => !(entry?.root?.path === file.root.path && entry.rel === file.rel));

export const quickMethods = {
  initQuick(options, cx) {
    this.quick = true;
    this.files = null;
    this.cursor = 0;
    this.hovered = null;
    this.focusHandle = cx.focus_handle();
    this.top = 0;
    this.wheel = 0;
    this.textGen = 0;
    this.rankGen = 0;
    this.pathGen = 0;
    this.pathHit = null;
    this.prepared = null;
    this.fileHits = null;
    this.rowsCache = [];
    this.query = InputState.new({ placeholder: PLACEHOLDER });
    const start = options.goto?.query ?? "";
    if (start) {
      this.query.set_value(start);
      this.query.set_selected_range({ start: start.length, end: start.length });
    }
    this.query.on("change", (_e, cx) => this.changed(cx));
    this.query.on("submit", (e, cx) => this.choose(this.cursor, cx, Boolean(e?.secondary)));
    this.query.focus();
    this.current = this.currentFile();
    this.loadFiles(cx);
    this.changed(cx);
  },

  roots() {
    const roots = workspace()?.roots ?? [];
    if (roots.length) {
      return roots;
    }
    const context = ctx();
    return context.cwd ? [{ name: baseName(context.cwd), path: context.cwd }] : [];
  },

  loadFiles(cx) {
    const roots = this.roots();
    cx.spawn(async (cx) => {
      const lists = await Promise.all(roots.map(async (root) => {
        const out = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root.path }).catch(() => null);
        return out?.code === 0 ? out.stdout.split("\0").filter(Boolean).map((rel) => ({ root, rel })) : [];
      }));
      this.files = lists.flat();
      this.prepared = prepareFiles(this.files);
      this.changed(cx, true);
    });
  },

  // The file in the active tab (a preview or a diff), for : and @.
  currentFile() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active);
    if (!tab) {
      return null;
    }
    const described = describeTab(tab, space.id);
    const value = described.value;
    const rel = value?.rel ?? value?.path;
    if (!isFileMode(described.kind) || !value?.root || !rel) {
      return null;
    }
    const root = rootFor(value.root, workspace()?.roots) ?? { name: baseName(value.root), path: value.root };
    return { root, rel, on: value.on ?? null };
  },

  changed(cx, keepCursor = false) {
    if (!keepCursor) {
      this.cursor = 0;
    }
    const query = parseQuery(this.query.value());
    const needsText = query.mode === "symbols" || query.mode === "line";
    if (needsText && this.current && this.currentText === undefined) {
      this.loadCurrentText(cx);
    }
    if (query.mode === "text") {
      this.searchText(query.text, cx);
    }
    if (query.mode === "files" && query.text && this.prepared) {
      this.rankAsync(query.text, cx);
    }
    if (query.mode === "files" && isPathQuery(query.text)) {
      this.resolvePath(query.text, cx);
    }
    this.refresh(cx);
  },

  // A typed path is relative to the current folder (`..` and `~` work), or absolute. It opens
  // even outside the workspace; the row exists only when the file exists.
  resolvePath(text, cx) {
    const gen = ++this.pathGen;
    cx.spawn(async (cx) => {
      const file = await this.resolvePathQuery(text);
      if (gen !== this.pathGen) {
        return;
      }
      this.pathHit = { text, file };
      this.refresh(cx);
    });
  },

  async resolvePathQuery(text) {
    const context = ctx();
    const on = context.on ?? null;
    const result = await exec("sh", ["-c", PATH_SCRIPT, "herdr-vscode-path", text, context.cwd ?? ""], { on }).catch(() => null);
    const abs = result?.code === 0 ? result.stdout.trim() : "";
    if (!abs) {
      return null;
    }
    const slash = abs.lastIndexOf("/");
    const dir = abs.slice(0, slash) || "/";
    return { root: { name: baseName(dir) || "/", path: dir }, rel: abs.slice(slash + 1), on };
  },

  loadCurrentText(cx) {
    this.currentText = null;
    const file = this.current;
    cx.spawn(async (cx) => {
      this.currentText = (await readTextFile(`${file.root.path}/${file.rel}`, { on: file.on }).catch(() => null)) ?? "";
      this.refresh(cx);
    });
  },

  refresh(cx) {
    this.rowsCache = this.rows();
    this.cursor = Math.min(this.cursor, Math.max(0, this.rowsCache.length - 1));
    this.reveal();
    cx.notify();
  },

  // Keep the selected row inside the drawn window.
  reveal() {
    const count = this.rowsCache.length;
    if (this.cursor < this.top) {
      this.top = this.cursor;
    }
    if (this.cursor >= this.top + QO_ROWS) {
      this.top = this.cursor - QO_ROWS + 1;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, count - QO_ROWS)));
  },

  scrollBy(event, cx) {
    const count = this.rowsCache.length;
    if (count <= QO_ROWS) {
      return;
    }
    this.wheel += event.delta_lines ? event.delta_lines.y * QO_ROW : event.delta?.y ?? 0;
    let moved = false;
    while (Math.abs(this.wheel) >= QO_ROW) {
      this.top -= Math.sign(this.wheel);
      this.wheel -= Math.sign(this.wheel) * QO_ROW;
      moved = true;
    }
    this.top = Math.max(0, Math.min(this.top, count - QO_ROWS));
    if (moved) {
      cx.notify();
    }
  },

  // Ranks in slices between frames so typing stays responsive on large repos.
  rankAsync(text, cx) {
    const gen = ++this.rankGen;
    const prepared = this.prepared;
    const words = queryWords(text);
    const scored = [];
    const step = (from, cx) => {
      if (gen !== this.rankGen) {
        return;
      }
      const to = Math.min(from + SLICE, prepared.length);
      scoreSlice(prepared, words, from, to, scored);
      if (to < prepared.length) {
        return void cx.timer.after(0, (cx) => step(to, cx));
      }
      this.fileHits = { text, list: topFiles(prepared, scored, text, MAX_FILE_HITS) };
      this.refresh(cx);
    };
    step(0, cx);
  },

  searchText(text, cx) {
    const gen = ++this.textGen;
    if (!text) {
      this.textHits = [];
      return;
    }
    this.textHits = null;
    cx.timer.after(TEXT_SEARCH_DELAY_MS, (cx) => {
      if (gen !== this.textGen) {
        return;
      }
      cx.spawn(async (cx) => {
        const hits = await this.grepRoots(text);
        if (gen !== this.textGen) {
          return;
        }
        this.textHits = hits;
        this.refresh(cx);
      });
    });
  },

  async grepRoots(text) {
    const args = grepArgs(text, {});
    const groups = await Promise.all(this.roots().map(async (root) => {
      const result = await git(args, { cwd: root.path, timeout: TEXT_SEARCH_TIMEOUT_MS }).catch(() => null);
      return { root, ...parseGrep(result?.code === 0 ? result.stdout : "", { maxMatches: MAX_TEXT_HITS }) };
    }));
    return groups
      .flatMap((group) => group.files.flatMap((file) => file.matches.map((match) => ({ root: group.root, rel: file.rel, ...match }))))
      .slice(0, MAX_TEXT_HITS);
  },

  recentFiles() {
    const live = new Set(this.roots().map((root) => root.path));
    return (shared(RECENT_KEY) ?? []).filter((entry) => entry?.root?.path && entry.rel && (live.size === 0 || live.has(entry.root.path)))
      .map((entry) => ({ root: rootFor(entry.root.path, workspace()?.roots) ?? entry.root, rel: entry.rel }));
  },

  // The rows for the current query: { kind, group?, label runs, description runs, icon, … }.
  rows() {
    const query = parseQuery(this.query.value());
    const builders = {
      help: () => this.helpRows(),
      commands: () => this.commandRows(query),
      line: () => this.lineRows(query),
      symbols: () => this.symbolRows(query),
      text: () => this.textRows(query),
    };
    return (builders[query.mode] ?? (() => this.fileRows(query)))();
  },

  fileRow(item, group, at, line) {
    const multi = this.roots().length > 1;
    const name = baseName(item.rel);
    const cut = item.rel.length - name.length;
    const dir = cut > 0 ? item.rel.slice(0, cut - 1) : "";
    return {
      kind: "file", key: `f:${item.root.path}:${item.rel}`, file: item, group, line: line ?? null,
      icon: { file: item.rel }, label: runsOf(name, at, cut),
      desc: [...(multi ? [{ text: item.root.name, hit: false }] : []), ...(multi && dir ? [{ text: " • ", hit: false }] : []), ...runsOf(dir, at, 0)],
    };
  },

  helpRows() {
    return HELP.map(([prefix, what]) => ({ kind: "help", key: `h:${prefix}`, prefix, icon: { glyph: prefix || "…", color: "accent" }, label: plain(what), desc: [] }));
  },

  commandItems(list, bound) {
    const items = new Map();
    for (const [action, label] of VX_COMMANDS) {
      items.set(action, { action, label });
    }
    for (const command of list) {
      if (!command.args.some((arg) => arg.required)) {
        items.set(command.name, { action: command.name, label: commandLabel(command.name), about: command.about });
      }
    }
    for (const binding of bound) {
      if (binding.action.includes(":") && !items.has(binding.action) && actionToRun(binding.action, list)) {
        items.set(binding.action, { action: binding.action, label: commandLabel(binding.action) });
      }
    }
    return items;
  },

  commandRows(query) {
    const list = commands() ?? [];
    const bound = keys() ?? [];
    const keyFor = (action) => bound.find((binding) => binding.action === action && KEY_SECTIONS.includes(binding.section))?.keys ?? null;
    const items = this.commandItems(list, bound);
    const recent = (shared(CMD_RECENT_KEY) ?? []).filter((action) => items.has(action));
    const all = [...items.values()];
    const scored = query.text
      ? all.map((command) => ({ command, match: matchPath(command.label, query.text) })).filter((entry) => entry.match).sort((a, b) => b.match.score - a.match.score)
      : [
        ...recent.map((action) => items.get(action)).filter(Boolean).map((command) => ({ command, match: null })),
        ...all.filter((command) => !recent.includes(command.action)).sort((a, b) => a.label.localeCompare(b.label)).map((command) => ({ command, match: null })),
      ];
    const groupAt = (index) => {
      if (query.text || !recent.length) {
        return null;
      }
      if (index === 0) {
        return "recently used";
      }
      return index === recent.length ? "other commands" : null;
    };
    return scored.slice(0, MAX_COMMANDS).map(({ command, match }, index) => ({
      kind: "command", key: `c:${command.action}`, action: command.action, group: groupAt(index),
      label: runsOf(command.label, match?.at ?? []), desc: [], tip: command.about, keys: keyFor(command.action),
    }));
  },

  lineRows(query) {
    const file = this.current;
    if (!file) {
      return note("Open a file in the editor first, then go to a line.");
    }
    const lineCount = this.currentText ? this.currentText.split("\n").length : null;
    if (!query.line) {
      return note(`Type a line number${lineCount ? ` between 1 and ${lineCount}` : ""} to navigate to.`, plain(file.rel));
    }
    const line = lineCount ? Math.min(query.line, lineCount) : query.line;
    const label = `Go to line ${line}${query.col ? `, character ${query.col}` : ""}.`;
    return [{ kind: "line", key: "l", file, line, icon: { ui: "arrow-down" }, label: plain(label), desc: plain(baseName(file.rel)) }];
  },

  symbolRows(query) {
    const file = this.current;
    if (!file) {
      return note("Open a file in the editor first, then go to a symbol.");
    }
    if (this.currentText === null || this.currentText === undefined) {
      return note("Reading symbols…");
    }
    const symbols = symbolsOf(this.currentText);
    const hits = query.text
      ? symbols.map((symbol) => ({ symbol, match: matchPath(symbol.name, query.text) })).filter((entry) => entry.match).sort((a, b) => b.match.score - a.match.score)
      : symbols.map((symbol) => ({ symbol, match: null }));
    if (!hits.length) {
      return note(symbols.length ? "No matching symbols." : "No symbols found in this file.");
    }
    return hits.map(({ symbol, match }, index) => {
      const [glyph, color] = SYMBOL_LOOK[symbol.kind] ?? DEFAULT_SYMBOL_LOOK;
      return {
        kind: "line", key: `s:${symbol.line}:${symbol.name}`, file, line: symbol.line, group: index === 0 ? `symbols (${hits.length})` : null,
        icon: { glyph, color }, label: runsOf(symbol.name, match?.at ?? []), desc: plain(symbol.kind), right: `Ln ${symbol.line}`,
      };
    });
  },

  textRows(query) {
    if (!query.text) {
      return note("Type to search for text in every repo of the workspace.");
    }
    if (!this.textHits) {
      return note("Searching…");
    }
    if (!this.textHits.length) {
      return note("No results found.");
    }
    const multi = this.roots().length > 1;
    return this.textHits.map((hit, index) => {
      const snippet = matchSnippet(hit.text, hit.col, query.text.length, SNIPPET);
      return {
        kind: "file", key: `t:${hit.root.path}:${hit.rel}:${hit.line}:${hit.col}`, file: { root: hit.root, rel: hit.rel }, line: hit.line,
        group: index === 0 ? "text results" : null, icon: { file: hit.rel },
        label: [{ text: snippet.head, hit: false }, { text: snippet.hit, hit: true }, { text: snippet.tail, hit: false }],
        desc: plain(`${multi ? `${hit.root.name} • ` : ""}${hit.rel}:${hit.line}`),
      };
    });
  },

  fileRows(query) {
    const recent = this.recentFiles();
    if (!query.text) {
      if (!recent.length) {
        return note("No recently opened files. Type to search every repo, or ? for help.");
      }
      return recent.slice(0, MAX_RECENT_FILES)
        .map((item, index) => ({ ...this.fileRow(item, index === 0 ? "recently opened" : null, [], query.line), recent: true }));
    }
    // A typed path that exists comes first, even outside the workspace.
    const pathFile = this.pathHit?.text === query.text ? this.pathHit.file : null;
    const pathRows = pathFile ? [this.fileRow(pathFile, "path", [], query.line)] : [];
    const recentHits = rankFiles(recent, query.text, MAX_RECENT_HITS);
    // The last finished ranking stays up until the one for the new query lands.
    const others = (this.fileHits?.list ?? []).filter((item) => !recentHits.some((hit) => sameFile(hit, item)) && !(pathFile && sameFile(pathFile, item)));
    const out = [
      ...pathRows,
      ...recentHits.map((item, index) => ({ ...this.fileRow(item, index === 0 && !pathRows.length ? "recently opened" : null, item.at, query.line), recent: true })),
      ...others.map((item, index) => this.fileRow(item, index === 0 && !pathRows.length && !recentHits.length ? "file results" : null, item.at, query.line)),
    ];
    const ranking = !this.prepared || this.fileHits?.text !== query.text;
    if (!out.length) {
      return note(ranking ? "Searching…" : "No matching results");
    }
    return out;
  },

  close() {
    closeOverlay(props()?.overlay);
  },

  remember(file) {
    const rest = withoutFile(shared(RECENT_KEY) ?? [], file);
    setShared(RECENT_KEY, [{ root: { name: file.root.name, path: file.root.path }, rel: file.rel }, ...rest].slice(0, MAX_RECENT_FILES));
  },

  forget(file, cx) {
    setShared(RECENT_KEY, withoutFile(shared(RECENT_KEY) ?? [], file));
    this.refresh(cx);
  },

  openFile(file, line, side) {
    this.remember(file);
    const value = { root: file.root.path, on: file.on ?? null, rel: file.rel, ...(line ? { line } : {}) };
    if (!side) {
      showInViewer("herdr-vscode-files", value, baseName(file.rel));
      return;
    }
    const space = spaces().find((s) => s.active);
    run("pane.split", {
      direction: "right", mod: "herdr-vscode-files",
      props: { mode: "view", space: space?.id, fixed: true, file: { root: value.root, on: value.on, rel: value.rel }, ...(line ? { line } : {}) },
    });
  },

  choose(index, cx, side = false) {
    const rows = this.rowsCache;
    const row = rows[Math.min(index, rows.length - 1)];
    if (!row || row.kind === "note") {
      return;
    }
    if (row.kind === "help") {
      this.query.set_value(row.prefix);
      this.query.set_selected_range({ start: row.prefix.length, end: row.prefix.length });
      this.changed(cx);
      return;
    }
    this.close();
    if (row.kind === "file" || row.kind === "line") {
      return this.openFile(row.file, row.line, side);
    }
    if (row.kind !== "command") {
      return;
    }
    setShared(CMD_RECENT_KEY, [row.action, ...(shared(CMD_RECENT_KEY) ?? []).filter((action) => action !== row.action)].slice(0, MAX_RECENT_COMMANDS));
    const target = actionToRun(row.action, commands() ?? []);
    if (target) {
      run(target.name, target.args);
    }
  },

  move(to, count, cx) {
    if (!count) {
      return;
    }
    this.cursor = ((to % count) + count) % count;
    this.reveal();
    cx.notify();
  },

  // Rows are cached and elements are single-use, so rows keep a description and drawing makes the element.
  iconEl(t, icon) {
    if (icon.file) {
      return FileIcon(this.icons, icon.file, { size: 16 });
    }
    if (icon.ui) {
      return Icon(icon.ui, 14).text_color(t.dim);
    }
    return div().text_color(t[icon.color] ?? t.muted).font_medium().child(icon.glyph);
  },

  drawRow(t, row, index, cur, mac) {
    const runsEl = (runs, base, size) => h_flex().flex_none().min_w(0).overflow_hidden().whitespace_nowrap().text_size(size)
      .children(runs.filter((part) => part.text).map((part) => div().flex_none().whitespace_nowrap().text_color(part.hit ? t.accent : base).when(part.hit, (el) => el.font_semibold()).child(part.text)));
    const selected = index === cur && row.kind !== "note";
    const showActions = (selected || this.hovered === row.key) && (row.kind === "file" || row.kind === "line");
    const action = (id, icon, tip, handler) => div().id(`qa-${id}-${index}`).size(18).flex_none().flex().items_center().justify_center().rounded(3)
      .text_color(t.foreground).hover((s) => s.bg(tint(t.foreground, "22"))).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); handler(cx); }).child(Icon(icon, 13));
    return h_flex().id(`qo-${row.key}`).h(QO_ROW).w_full().px(5)
      .child(h_flex().id(`qi-${row.key}`).size_full().pl(6).pr(4).gap(6).items_center().rounded(4)
        .when(Boolean(row.group) && index > 0, (el) => el.border_t(1).border_color(t.border))
        .when(selected, (el) => el.bg(t.selected))
        .when(!selected && row.kind !== "note", (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(Boolean(row.tip), (el) => el.tooltip(row.tip))
        .on_hover((hovering, cx) => this.hoverRow(row.key, hovering, cx))
        .on_click((e, cx) => this.choose(index, cx, Boolean(e?.modifiers?.platform || e?.modifiers?.control)))
        .when(Boolean(row.icon), (el) => el.child(div().w(16).flex_none().flex().items_center().justify_center().child(this.iconEl(t, row.icon))))
        .child(runsEl(row.label, row.kind === "note" ? t.muted : t.foreground, 13))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().child(runsEl(row.desc, t.dim, 12)))
        .when(Boolean(row.right), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(row.right)))
        .when(Boolean(row.keys), (el) => el.child(div().flex_none().px(5).h(18).flex().items_center().rounded(3).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(keyLabel(row.keys, mac))))
        .when(Boolean(row.group), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(row.group)))
        .when(showActions, (el) => el
          .child(action("side", "split", "Open to the Side (⌘Enter)", () => { this.close(); this.openFile(row.file, row.line, true); }))
          .when(Boolean(row.recent), (inner) => inner.child(action("forget", "x", "Remove from Recently Opened", (cx) => this.forget(row.file, cx))))));
  },

  hoverRow(key, hovering, cx) {
    let next = this.hovered;
    if (hovering) {
      next = key;
    } else if (this.hovered === key) {
      next = null;
    }
    if (next === this.hovered) {
      return;
    }
    this.hovered = next;
    cx.notify();
  },

  onQuickKey(event, cur, count, cx) {
    const targets = {
      down: () => cur + 1,
      up: () => cur - 1,
      pagedown: () => Math.min(count - 1, cur + QO_ROWS - 1),
      pageup: () => Math.max(0, cur - QO_ROWS + 1),
    };
    if (targets[event.key]) {
      cx.stop_propagation();
      this.move(targets[event.key](), count, cx);
      return;
    }
    if (event.key === "escape") {
      cx.stop_propagation();
      this.close();
    }
  },

  renderQuick() {
    const t = theme();
    const rows = this.rowsCache;
    const cur = Math.min(this.cursor, Math.max(0, rows.length - 1));
    const mac = window()?.platform === "macos";
    const shown = Math.max(1, Math.min(rows.length, QO_ROWS));
    const listHeight = shown * QO_ROW;
    const top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - QO_ROWS)));
    return v_flex().id("herdr-vscode-quick").w_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focusHandle)
      .on_key_down((event, cx) => this.onQuickKey(event, cur, rows.length, cx))
      .child(div().flex_none().p(6)
        .child(h_flex().h(26).px(6).items_center().rounded(4).border_1().border_color(t.accent).bg(t.canvas ?? t.background)
          .child(Input.new(this.query).flex_1().h(24).text_size(13))))
      .child(v_flex().id("qo-rows").flex_none().w_full().h(listHeight).mb(6).relative().overflow_hidden()
        .on_scroll_wheel((event, cx) => this.scrollBy(event, cx))
        .children(rows.slice(top, top + QO_ROWS).map((row, offset) => this.drawRow(t, row, top + offset, cur, mac)))
        .when(rows.length > QO_ROWS, (el) => el.child(div().absolute().right(1).w(6).rounded(3).bg(tint(t.foreground, "30"))
          .top(Math.round((top / rows.length) * listHeight)).h(Math.max(MIN_THUMB_HEIGHT, Math.round((QO_ROWS / rows.length) * listHeight))))));
  },
};
