import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, panes, spaces, run, props, checking, watchFolder, home } from "herdr";
import { repoTop, baseName } from "./ws.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, IconButton, FileIcon, Dot, ConfirmView } from "./ui.js";
import { loadIcons } from "./icons.js";
import { groupRunning, sortFolders, buildTree, planClose, SORTS, GROUPINGS, CLOSE_MODES } from "./running-core.js";
import { loadPrefs, savePrefs, DEFAULT_PREFS } from "./running-prefs.js";

class VxRunning extends View {
  static MOD = "vx-running";
  static ROW_HEIGHT = { comfortable: 24, compact: 20 };
  static INDENT_PX = 14;
  static ICON_PX = 14;
  static CHEVRON_PX = 12;
  static ROOTS_REFRESH_MS = 2000;
  static STATE_DIR = ".local/state/herdr-folders";
  static HERDR_APP = "herdr-app";
  static DIR_KEY_PREFIX = "dir:";
  static SORT_LABELS = { opened: "Opened", status: "Status", name: "Name" };
  static CLOSE_LABELS = {
    "empty-folders": "Close idle folders",
    "idle-agents-and-empty-folders": "Close idle agents and idle folders",
    terminals: "Close every terminal",
    all: "Close everything",
  };

  static statusColor(status, colors) {
    const byStatus = { working: colors.working, blocked: colors.blocked, done: colors.done, idle: colors.idle, running: colors.ansi4 };
    return byStatus[status] ?? colors.dim;
  }

  static programIcon(program) {
    if (!program?.icon) {
      return Icon("terminal", VxRunning.ICON_PX);
    }
    const picture = program.tint ? svg(program.icon) : image(program.icon);
    return picture.size(VxRunning.ICON_PX).flex_none();
  }

  static closeAction(paneIds) {
    return {
      doing: "Closing",
      done: "Closed",
      steps: paneIds.map((pane) => ({ cmd: VxRunning.HERDR_APP, args: ["do", "pane.close", "--pane", pane] })),
    };
  }

  static plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  static counts(folder) {
    const parts = [];
    if (folder.agentCount > 0) {
      parts.push(VxRunning.plural(folder.agentCount, "agent"));
    }
    if (folder.terminalCount > 0) {
      parts.push(VxRunning.plural(folder.terminalCount, "terminal"));
    }
    return parts.join(" · ");
  }

  static next(list, value) {
    return list[(list.indexOf(value) + 1) % list.length];
  }

  static dirKeys(nodes) {
    return nodes.flatMap((node) => [...(node.type === "dir" ? [`${VxRunning.DIR_KEY_PREFIX}${node.path}`] : []), ...VxRunning.dirKeys(node.children)]);
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
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
    if (checking()) {
      return;
    }
    this.reloadPrefs(cx);
    this.watchPrefs(cx);
    this.refreshRoots(cx);
    cx.timer.every(VxRunning.ROOTS_REFRESH_MS, (cx) => this.refreshRoots(cx));
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
          await watchFolder(`${home()}/${VxRunning.STATE_DIR}`);
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
    const keys = [...folders.map((folder) => folder.path), ...VxRunning.dirKeys(tree)];
    const allCollapsed = keys.every((key) => this.prefs.collapsed[key]);
    this.setPref({ collapsed: allCollapsed ? {} : Object.fromEntries(keys.map((key) => [key, true])), collapsible: true }, cx);
  }

  machineOf(tab) {
    return spaces().find((space) => space.tabs.some((candidate) => candidate.id === tab))?.machine ?? null;
  }

  refreshRoots(cx) {
    const unknown = panes().filter((pane) => pane.terminal && pane.cwd && !(pane.cwd in this.roots));
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

  focusRow(row) {
    if (row.space) {
      run("space.select", { id: row.space });
    }
    run("tab.select", { id: row.tab });
    run("pane.focus", { pane: row.pane });
  }

  closeRows(title, rows) {
    if (rows.length === 0) {
      return;
    }
    if (rows.length === 1 && !this.prefs.confirmKill) {
      run("pane.close", { pane: rows[0].pane });
      return;
    }
    askConfirm(VxRunning.MOD, {
      title,
      detail: rows.map((row) => `${row.label}${row.title ? `: ${row.title}` : ""}`).join(", "),
      label: "Close",
      danger: true,
      action: VxRunning.closeAction(rows.map((row) => row.pane)),
    });
  }

  closeMode(folders, mode, cx) {
    this.closeMenu = false;
    cx.notify();
    const rows = planClose(folders, mode);
    this.closeRows(`${VxRunning.CLOSE_LABELS[mode]}: ${VxRunning.plural(rows.length, "pane")}?`, rows);
  }

  newTerminal(folder) {
    const space = folder.rows.find((row) => row.space)?.space;
    run("tab.new", space ? { folder: folder.path, space } : { folder: folder.path });
  }

  rowHeight() {
    return VxRunning.ROW_HEIGHT[this.prefs.spacing] ?? VxRunning.ROW_HEIGHT.comfortable;
  }

  chevron(open) {
    if (!this.prefs.collapsible) {
      return div().w(VxRunning.CHEVRON_PX).flex_none();
    }
    return Icon(open ? "chevron-down" : "chevron-right", VxRunning.CHEVRON_PX);
  }

  toolbar(colors, folders, tree) {
    const textButton = (id, label, tip, onClick) => h_flex().id(id).h(20).px(6).items_center().rounded(4).cursor_pointer()
      .text_size(TEXT.caption).text_color(colors.muted).hover((style) => style.bg(colors.hover).text_color(colors.foreground))
      .tooltip(tip).on_click(onClick).child(label);
    return h_flex().h(28).flex_none().px(6).gap(2).items_center().border_b(1).border_color(colors.border)
      .child(textButton("sort", `Sort: ${VxRunning.SORT_LABELS[this.prefs.sort] ?? this.prefs.sort}`, "Change the sort order",
        (_event, cx) => this.setPref({ sort: VxRunning.next(SORTS, this.prefs.sort) }, cx)))
      .child(textButton("grouping", this.prefs.grouping === "tree" ? "Tree" : "Folders", "Group by folder or as a tree",
        (_event, cx) => this.setPref({ grouping: VxRunning.next(GROUPINGS, this.prefs.grouping) }, cx)))
      .child(div().flex_1())
      .child(IconButton({ id: "spacing", icon: "list", label: `Spacing: ${this.prefs.spacing}`,
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
          .child(div().flex_1().truncate().child(VxRunning.CLOSE_LABELS[mode]))
          .child(div().text_size(TEXT.caption).text_color(colors.dim).child(String(count)));
      }))
      .child(confirmRow);
  }

  folderRow(folder, colors, depth) {
    const open = !this.isCollapsed(folder.path);
    return h_flex().id(`f-${folder.path}`).h(this.rowHeight()).pl(6 + depth * VxRunning.INDENT_PX).pr(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => {
        if (this.prefs.collapsible) {
          this.toggle(folder.path, cx);
          return;
        }
        if (folder.rows[0]) {
          this.focusRow(folder.rows[0]);
        }
      })
      .child(this.chevron(open))
      .child(FileIcon(this.icons, folder.path, { dir: true, open, size: VxRunning.ICON_PX }))
      .child(div().min_w(0).truncate().font_semibold().text_color(folder.focused ? colors.accent : colors.foreground).child(folder.name))
      .when(Boolean(folder.branch), (el) => el.child(div().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(folder.branch)))
      .child(div().flex_1())
      .when(Boolean(folder.status), (el) => el.child(Dot(VxRunning.statusColor(folder.status, colors))))
      .child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(VxRunning.counts(folder)))
      .child(IconButton({ id: `new-${folder.path}`, icon: "plus", label: "New terminal here", onClick: () => this.newTerminal(folder) }))
      .child(IconButton({ id: `kill-${folder.path}`, icon: "x", label: "Close everything here", onClick: () => this.closeRows(`Close everything in ${folder.name}?`, folder.rows) }));
  }

  paneRow(row, colors, depth) {
    const name = row.title || baseName(row.cwd);
    return h_flex().id(`p-${row.pane}`).h(this.rowHeight()).pl(6 + (depth + 1) * VxRunning.INDENT_PX).pr(6).gap(6).items_center().cursor_pointer()
      .when(row.focused, (el) => el.bg(colors.selected))
      .hover((style) => style.bg(colors.hover))
      .on_click(() => this.focusRow(row))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        this.closeRows(`Close ${row.label}?`, [row]);
      })
      .child(Dot(VxRunning.statusColor(row.status, colors)))
      .child(VxRunning.programIcon(row.program))
      .child(div().flex_none().text_color(row.focused ? colors.foreground : colors.muted).child(row.label))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(name))
      .child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(row.tabName))
      .child(IconButton({ id: `kill-${row.pane}`, icon: "x", label: "Close", onClick: () => this.closeRows(`Close ${row.label}?`, [row]) }));
  }

  folderBlock(folder, colors, depth) {
    const rows = [this.folderRow(folder, colors, depth)];
    if (this.isCollapsed(folder.path)) {
      return rows;
    }
    return [...rows, ...folder.rows.map((row) => this.paneRow(row, colors, depth))];
  }

  dirRow(node, colors, depth) {
    const key = `${VxRunning.DIR_KEY_PREFIX}${node.path}`;
    const open = !this.isCollapsed(key);
    return h_flex().id(`d-${node.path}`).h(this.rowHeight()).pl(6 + depth * VxRunning.INDENT_PX).pr(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => this.toggle(key, cx))
      .child(this.chevron(open))
      .child(FileIcon(this.icons, node.path, { dir: true, open, size: VxRunning.ICON_PX }))
      .child(div().min_w(0).truncate().text_color(colors.muted).child(node.name));
  }

  treeRows(nodes, colors, depth) {
    return nodes.flatMap((node) => {
      if (node.type === "folder") {
        const own = this.folderBlock(node.folder, colors, depth);
        return this.isCollapsed(node.folder.path) ? own : [...own, ...this.treeRows(node.children, colors, depth + 1)];
      }
      const header = this.dirRow(node, colors, depth);
      return this.isCollapsed(`${VxRunning.DIR_KEY_PREFIX}${node.path}`) ? [header] : [header, ...this.treeRows(node.children, colors, depth + 1)];
    });
  }

  render() {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    const colors = theme();
    const folders = sortFolders(groupRunning({ panes: panes(), spaces: spaces(), roots: this.roots }), this.prefs.sort);
    const tree = this.prefs.grouping === "tree" ? buildTree(folders) : [];
    const rows = this.prefs.grouping === "tree"
      ? this.treeRows(tree, colors, 0)
      : folders.flatMap((folder) => this.folderBlock(folder, colors, 0));
    return v_flex().id(VxRunning.MOD).size_full().bg(colors.chrome).text_size(TEXT.small).text_color(colors.foreground)
      .child(this.toolbar(colors, folders, tree))
      .when(this.closeMenu, (el) => el.child(this.closeMenuRows(colors, folders)))
      .child(v_flex().id("running-body").flex_1().min_h(0).overflow_y_scrollbar()
        .when(folders.length === 0, (el) => el.child(div().p(12).text_color(colors.dim).child("Nothing running.")))
        .children(rows));
  }

  static {
    Object.assign(VxRunning.prototype, confirmMethods);
  }
}

export default VxRunning;
