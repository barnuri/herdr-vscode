import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, panes, terminals, spaces, run, props, checking, watchFolder, home } from "herdr";
import { repoTop, baseName } from "./ws.js";
import { confirmMethods } from "./actions.js";
import { TEXT, SPIN_MS, Icon, IconButton, FileIcon, Dot, ConfirmView } from "./ui.js";
import { loadIcons } from "./icons.js";
import { groupRunning, sortFolders, buildTree, planClose, SORTS, GROUPINGS, CLOSE_MODES } from "./running-core.js";
import { loadPrefs, savePrefs, DEFAULT_PREFS } from "./running-prefs.js";
import RunningMenu from "./running-menu.js";
import RunningProbe from "./running-probe.js";

class HerdrVscodeRunning extends View {
  static MOD = "herdr-vscode-running";
  static ROW_HEIGHT = { comfortable: 24, compact: 20 };
  static LINE_HEIGHT = 18;
  static CARD_PAD_PX = 3;
  static SPINNER_PX = 10;
  static SPINNING = new Set(["working", "orch"]);
  static INDENT_PX = 14;
  static ICON_PX = 14;
  static CHEVRON_PX = 12;
  static ROOTS_REFRESH_MS = 2000;
  static PANEL_LABEL = "herdr-vscode.panel";
  static SPACE_LABEL = "herdr-vscode.space";
  static STATE_DIR = ".local/state/herdr-folders";
  static DIR_KEY_PREFIX = "dir:";
  static SORT_LABELS = { opened: "Opened", status: "Status", name: "Name" };
  static CLOSE_LABELS = {
    "empty-folders": "Close idle folders",
    "idle-agents-and-empty-folders": "Close idle agents and idle folders",
    terminals: "Close every terminal",
    all: "Close everything",
  };

  static statusColor(status, colors) {
    const byStatus = { working: colors.working, orch: colors.ansi5, blocked: colors.blocked, done: colors.done, idle: colors.idle, running: colors.ansi4 };
    return byStatus[status] ?? colors.dim;
  }

  static programIcon(program) {
    if (!program?.icon) {
      return Icon("terminal", HerdrVscodeRunning.ICON_PX);
    }
    const picture = program.tint ? svg(program.icon) : image(program.icon);
    return picture.size(HerdrVscodeRunning.ICON_PX).flex_none();
  }

  static statusMark(status, colors) {
    const color = HerdrVscodeRunning.statusColor(status, colors);
    if (HerdrVscodeRunning.SPINNING.has(status)) {
      return Icon("spinner", HerdrVscodeRunning.SPINNER_PX).text_color(color).spin(SPIN_MS);
    }
    return Dot(color);
  }

  static plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  static counts(folder) {
    const parts = [];
    if (folder.agentCount > 0) {
      parts.push(HerdrVscodeRunning.plural(folder.agentCount, "agent"));
    }
    if (folder.terminalCount > 0) {
      parts.push(HerdrVscodeRunning.plural(folder.terminalCount, "terminal"));
    }
    return parts.join(" · ");
  }

  static next(list, value) {
    return list[(list.indexOf(value) + 1) % list.length];
  }

  static dirKeys(nodes) {
    return nodes.flatMap((node) => [...(node.type === "dir" ? [`${HerdrVscodeRunning.DIR_KEY_PREFIX}${node.path}`] : []), ...HerdrVscodeRunning.dirKeys(node.children)]);
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    if (options.menu) {
      this.menu = new RunningMenu(options.menu, cx);
      return;
    }
    if (options.confirm) {
      this.confirmSpec = options.confirm;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    loadIcons(this, cx);
    this.tops = new Map();
    this.roots = {};
    this.prefs = { ...DEFAULT_PREFS };
    this.closeMenu = false;
    this.probe = new RunningProbe();
    if (checking()) {
      return;
    }
    this.probe.start(cx);
    this.reloadPrefs(cx);
    this.watchPrefs(cx);
    this.refreshRoots(cx);
    cx.timer.every(HerdrVscodeRunning.ROOTS_REFRESH_MS, (cx) => {
      this.refreshRoots(cx);
      this.probe.kick(cx);
    });
  }

  reloadPrefs(cx) {
    cx.spawn(async (cx) => {
      this.prefs = await loadPrefs();
      cx.notify();
    });
  }

  watchPrefs(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(`${home()}/${HerdrVscodeRunning.STATE_DIR}`);
        } catch {
          return;
        }
        this.prefs = await loadPrefs();
        cx.notify();
      }
    });
  }

  setPref(patch, cx) {
    this.prefs = { ...this.prefs, ...patch };
    cx.notify();
    cx.spawn(async () => {
      await savePrefs(patch);
    });
  }

  isCollapsed(key) {
    return this.prefs.collapsible && Boolean(this.prefs.collapsed[key]);
  }

  toggle(key, cx) {
    const collapsed = { ...this.prefs.collapsed };
    if (collapsed[key]) {
      delete collapsed[key];
    } else {
      collapsed[key] = true;
    }
    this.setPref({ collapsed }, cx);
  }

  collapseAll(folders, tree, cx) {
    const keys = [...folders.map((folder) => folder.path), ...HerdrVscodeRunning.dirKeys(tree)];
    const allCollapsed = keys.every((key) => this.prefs.collapsed[key]);
    this.setPref({ collapsed: allCollapsed ? {} : Object.fromEntries(keys.map((key) => [key, true])), collapsible: true }, cx);
  }

  machineOf(tab) {
    return spaces().find((space) => space.tabs.some((candidate) => candidate.id === tab))?.machine ?? null;
  }

  // Every running terminal: the panes of every tab, then the bottom panel's own shells, which have no pane.
  static runningPanes() {
    const shells = (terminals() ?? [])
      .filter((terminal) => terminal.labels?.[HerdrVscodeRunning.PANEL_LABEL] === "1" && terminal.state === "live")
      .map((terminal) => ({
        pane: terminal.address, terminal: terminal.address, tab: null, space: terminal.labels?.[HerdrVscodeRunning.SPACE_LABEL] ?? null,
        cwd: terminal.cwd ?? null, title: terminal.title ?? "", status: terminal.status ?? null, app: null,
        program: terminal.program ?? null, branch: null, focused: false,
      }));
    return [...panes(), ...shells];
  }

  refreshRoots(cx) {
    const unknown = HerdrVscodeRunning.runningPanes().filter((pane) => pane.terminal && pane.cwd && !(pane.cwd in this.roots));
    if (unknown.length === 0) {
      return;
    }
    cx.spawn(async (cx) => {
      for (const pane of unknown) {
        const top = await repoTop(this.tops, pane.cwd, this.machineOf(pane.tab)).catch(() => null);
        this.roots[pane.cwd] = top ?? pane.cwd;
      }
      cx.notify();
    });
  }

  closeRows(title, rows) {
    RunningMenu.closeRows(title, rows, this.prefs.confirmKill);
  }

  closeMode(folders, mode, cx) {
    this.closeMenu = false;
    cx.notify();
    const rows = planClose(folders, mode);
    this.closeRows(`${HerdrVscodeRunning.CLOSE_LABELS[mode]}: ${HerdrVscodeRunning.plural(rows.length, "pane")}?`, rows);
  }

  newTerminal(folder) {
    RunningMenu.newTab(folder.path, folder.rows.find((row) => row.space)?.space ?? null);
  }

  twoRows() {
    return this.prefs.spacing !== "compact";
  }

  rowHeight() {
    return HerdrVscodeRunning.ROW_HEIGHT[this.prefs.spacing] ?? HerdrVscodeRunning.ROW_HEIGHT.comfortable;
  }

  chevron(open) {
    if (!this.prefs.collapsible) {
      return div().w(HerdrVscodeRunning.CHEVRON_PX).flex_none();
    }
    return Icon(open ? "chevron-down" : "chevron-right", HerdrVscodeRunning.CHEVRON_PX);
  }

  toolbar(colors, folders, tree) {
    const textButton = (id, label, tip, onClick) => h_flex().id(id).h(20).px(6).items_center().rounded(4).cursor_pointer()
      .text_size(TEXT.caption).text_color(colors.muted).hover((style) => style.bg(colors.hover).text_color(colors.foreground))
      .tooltip(tip).on_click(onClick).child(label);
    return h_flex().h(28).flex_none().px(6).gap(2).items_center().border_b(1).border_color(colors.border)
      .child(textButton("sort", `Sort: ${HerdrVscodeRunning.SORT_LABELS[this.prefs.sort] ?? this.prefs.sort}`, "Change the sort order",
        (_event, cx) => this.setPref({ sort: HerdrVscodeRunning.next(SORTS, this.prefs.sort) }, cx)))
      .child(textButton("grouping", this.prefs.grouping === "tree" ? "Tree" : "Folders", "Group by folder or as a tree",
        (_event, cx) => this.setPref({ grouping: HerdrVscodeRunning.next(GROUPINGS, this.prefs.grouping) }, cx)))
      .child(div().flex_1())
      .child(IconButton({ id: "cards", icon: "layout", label: "Folder card backgrounds", active: this.prefs.cardBackgrounds,
        onClick: (cx) => this.setPref({ cardBackgrounds: !this.prefs.cardBackgrounds }, cx) }))
      .child(IconButton({ id: "spacing", icon: "list", label: this.twoRows() ? "Two-row items (click for one row)" : "One-row items (click for two rows)",
        onClick: (cx) => this.setPref({ spacing: this.prefs.spacing === "compact" ? "comfortable" : "compact" }, cx) }))
      .child(IconButton({ id: "collapse", icon: "collapse", label: "Collapse or expand all", onClick: (cx) => this.collapseAll(folders, tree, cx) }))
      .child(IconButton({ id: "close-menu", icon: "trash", label: "Close panes…", active: this.closeMenu,
        onClick: (cx) => {
          this.closeMenu = !this.closeMenu;
          cx.notify();
        } }));
  }

  closeMenuRows(colors, folders) {
    const confirmRow = h_flex().id("confirm-kill").h(22).px(10).gap(6).items_center().cursor_pointer().text_size(TEXT.caption)
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => this.setPref({ confirmKill: !this.prefs.confirmKill }, cx))
      .child(Icon(this.prefs.confirmKill ? "check" : "minus", 12))
      .child(div().text_color(colors.muted).child("Ask before closing one pane"));
    return v_flex().py(4).flex_none().border_b(1).border_color(colors.border).bg(colors.surface)
      .children(CLOSE_MODES.map((mode) => {
        const count = planClose(folders, mode).length;
        return h_flex().id(`close-${mode}`).h(22).px(10).gap(6).items_center().cursor_pointer().text_size(TEXT.small)
          .hover((style) => style.bg(colors.hover))
          .on_click((_event, cx) => this.closeMode(folders, mode, cx))
          .child(div().flex_1().truncate().child(HerdrVscodeRunning.CLOSE_LABELS[mode]))
          .child(div().text_size(TEXT.caption).text_color(colors.dim).child(String(count)));
      }))
      .child(confirmRow);
  }

  folderRow(folder, colors, depth) {
    const open = !this.isCollapsed(folder.path);
    if (folder.isRepo) {
      this.shownRepos.push({ path: folder.path, on: this.machineOf(folder.rows[0]?.tab) });
    }
    const gitLine = this.probe.lineOf(folder.path) ?? folder.branch;
    return h_flex().id(`f-${folder.path}`).h(this.rowHeight()).pl(6 + depth * HerdrVscodeRunning.INDENT_PX).pr(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => {
        if (this.prefs.collapsible) {
          this.toggle(folder.path, cx);
          return;
        }
        if (folder.rows[0]) {
          RunningMenu.focusRow(folder.rows[0]);
        }
      })
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        RunningMenu.open(folder.name, folder.path, RunningMenu.folderItems(folder, this.prefs.confirmKill));
      })
      .child(this.chevron(open))
      .child(FileIcon(this.icons, folder.path, { dir: true, open, size: HerdrVscodeRunning.ICON_PX }))
      .child(div().flex_none().font_semibold().text_color(folder.focused ? colors.accent : colors.foreground).child(folder.name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(gitLine ?? ""))
      .when(Boolean(folder.status), (el) => el.child(HerdrVscodeRunning.statusMark(folder.status, colors)))
      .child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(HerdrVscodeRunning.counts(folder)))
      .child(IconButton({ id: `new-${folder.path}`, icon: "plus", label: "New terminal here", onClick: () => this.newTerminal(folder) }))
      .child(IconButton({ id: `kill-${folder.path}`, icon: "x", label: "Close everything here", onClick: () => this.closeRows(`Close everything in ${folder.name}?`, folder.rows) }));
  }



  paneRow(row, folder, colors, depth) {
    // A second line only carries an orch summary; each terminal is one row.
    const twoRows = this.twoRows() && Boolean(row.orchSummary);
    // The program icon names the harness, so the row shows the session title in its place.
    const name = row.title || row.label;
    const head = h_flex().h(twoRows ? HerdrVscodeRunning.LINE_HEIGHT : this.rowHeight()).gap(6).items_center()
      .child(div().w(HerdrVscodeRunning.ICON_PX).flex_none().flex().justify_center().child(HerdrVscodeRunning.statusMark(row.status, colors)))
      .child(HerdrVscodeRunning.programIcon(row.program))
      .child(div().flex_1().min_w(0).truncate().text_color(row.focused ? colors.foreground : colors.muted).child(name))
      .child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(row.orchSummary ? "orch" : ""))
      .child(IconButton({ id: `kill-${row.pane}`, icon: "x", label: "Close", onClick: () => this.closeRows(`Close ${row.label}?`, [row]) }));
    const detailColor = row.orchSummary ? colors.ansi5 : colors.dim;
    return v_flex().id(`p-${row.pane}`).pl(6 + (depth + 1) * HerdrVscodeRunning.INDENT_PX).pr(6).cursor_pointer()
      .when(twoRows, (el) => el.py(HerdrVscodeRunning.CARD_PAD_PX))
      .when(row.focused, (el) => el.bg(colors.selected))
      .hover((style) => style.bg(colors.hover))
      .on_click(() => RunningMenu.focusRow(row))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        RunningMenu.open(row.label, row.title || folder.name, RunningMenu.paneItems(row, folder, this.prefs.confirmKill));
      })
      .child(head)
      .when(twoRows, (el) => el.child(div().h(HerdrVscodeRunning.LINE_HEIGHT).pl(HerdrVscodeRunning.ICON_PX * 2 + 12).truncate()
        .text_size(TEXT.caption).text_color(detailColor).child(row.orchSummary)));
  }

  folderBlock(folder, colors, depth) {
    const header = this.folderRow(folder, colors, depth);
    const rows = this.isCollapsed(folder.path) ? [header] : [header, ...folder.rows.map((row) => this.paneRow(row, folder, colors, depth))];
    if (!this.prefs.cardBackgrounds) {
      return rows;
    }
    return [v_flex().id(`card-${folder.path}`).mx(4).my(2).rounded(6).overflow_hidden().bg(colors.surface).children(rows)];
  }

  dirRow(node, colors, depth) {
    const key = `${HerdrVscodeRunning.DIR_KEY_PREFIX}${node.path}`;
    const open = !this.isCollapsed(key);
    return h_flex().id(`d-${node.path}`).h(this.rowHeight()).pl(6 + depth * HerdrVscodeRunning.INDENT_PX).pr(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => this.toggle(key, cx))
      .child(this.chevron(open))
      .child(FileIcon(this.icons, node.path, { dir: true, open, size: HerdrVscodeRunning.ICON_PX }))
      .child(div().min_w(0).truncate().text_color(colors.muted).child(node.name));
  }

  treeRows(nodes, colors, depth) {
    return nodes.flatMap((node) => {
      if (node.type === "folder") {
        const own = this.folderBlock(node.folder, colors, depth);
        return this.isCollapsed(node.folder.path) ? own : [...own, ...this.treeRows(node.children, colors, depth + 1)];
      }
      const header = this.dirRow(node, colors, depth);
      return this.isCollapsed(`${HerdrVscodeRunning.DIR_KEY_PREFIX}${node.path}`) ? [header] : [header, ...this.treeRows(node.children, colors, depth + 1)];
    });
  }

  render() {
    if (this.menu) {
      return this.menu.render();
    }
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    const colors = theme();
    const folders = sortFolders(groupRunning({ panes: HerdrVscodeRunning.runningPanes(), spaces: spaces(), roots: this.roots, orchOf: this.probe.orchOf() }), this.prefs.sort);
    this.shownRepos = [];
    const tree = this.prefs.grouping === "tree" ? buildTree(folders) : [];
    const rows = this.prefs.grouping === "tree"
      ? this.treeRows(tree, colors, 0)
      : folders.flatMap((folder) => this.folderBlock(folder, colors, 0));
    this.probe.want(this.shownRepos);
    return v_flex().id(HerdrVscodeRunning.MOD).size_full().bg(colors.chrome).text_size(TEXT.small).text_color(colors.foreground)
      .child(this.toolbar(colors, folders, tree))
      .when(this.closeMenu, (el) => el.child(this.closeMenuRows(colors, folders)))
      .child(v_flex().id("running-body").flex_1().min_h(0).overflow_y_scrollbar()
        .when(folders.length === 0, (el) => el.child(div().p(12).text_color(colors.dim).child("Nothing running.")))
        .children(rows));
  }

  static {
    Object.assign(HerdrVscodeRunning.prototype, confirmMethods);
  }
}

export default HerdrVscodeRunning;
