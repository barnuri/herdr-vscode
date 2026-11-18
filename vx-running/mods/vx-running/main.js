import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, panes, spaces, run, props, checking } from "herdr";
import { repoTop, baseName } from "./ws.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, IconButton, FileIcon, Dot, ConfirmView } from "./ui.js";
import { loadIcons } from "./icons.js";
import { groupRunning } from "./running-core.js";

class VxRunning extends View {
  static MOD = "vx-running";
  static ROW_HEIGHT = 22;
  static INDENT_PX = 18;
  static ICON_PX = 14;
  static ROOTS_REFRESH_MS = 2000;
  static COLLAPSED_KEY = "collapsed";
  static HERDR_APP = "herdr-app";

  static statusColor(status, colors) {
    return { working: colors.working, blocked: colors.blocked, done: colors.done, idle: colors.idle }[status] ?? colors.dim;
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

  static counts(folder) {
    const parts = [];
    if (folder.agentCount > 0) {
      parts.push(`${folder.agentCount} agent${folder.agentCount === 1 ? "" : "s"}`);
    }
    if (folder.terminalCount > 0) {
      parts.push(`${folder.terminalCount} terminal${folder.terminalCount === 1 ? "" : "s"}`);
    }
    return parts.join(" · ");
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    if (options.confirm) {
      this.initConfirm(options.confirm, cx);
      return;
    }
    loadIcons(this, cx);
    this.tops = new Map();
    this.roots = {};
    this.collapsed = new Set(this.readCollapsed());
    if (checking()) {
      return;
    }
    this.refreshRoots(cx);
    cx.timer.every(VxRunning.ROOTS_REFRESH_MS, (cx) => this.refreshRoots(cx));
  }

  initConfirm(spec, cx) {
    this.confirmSpec = spec;
    this.confirmFocus = cx.focus_handle();
    this.confirmFocus.focus();
  }

  readCollapsed() {
    try {
      return JSON.parse(localStorage.getItem(VxRunning.COLLAPSED_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  toggle(path) {
    if (this.collapsed.has(path)) {
      this.collapsed.delete(path);
    } else {
      this.collapsed.add(path);
    }
    localStorage.setItem(VxRunning.COLLAPSED_KEY, JSON.stringify([...this.collapsed]));
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

  askClose(title, rows) {
    askConfirm(VxRunning.MOD, {
      title,
      detail: rows.map((row) => `${row.label}${row.title ? `: ${row.title}` : ""}`).join("\n"),
      label: "Close",
      danger: true,
      action: VxRunning.closeAction(rows.map((row) => row.pane)),
    });
  }

  newTerminal(folder) {
    const space = folder.rows.find((row) => row.space)?.space;
    run("tab.new", space ? { folder: folder.path, space } : { folder: folder.path });
  }

  folderRow(folder, colors) {
    const open = !this.collapsed.has(folder.path);
    return h_flex().id(`f-${folder.path}`).h(VxRunning.ROW_HEIGHT).px(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => {
        this.toggle(folder.path);
        cx.notify();
      })
      .child(Icon(open ? "chevron-down" : "chevron-right", 12))
      .child(FileIcon(this.icons, folder.path, { dir: true, open, size: VxRunning.ICON_PX }))
      .child(div().min_w(0).truncate().font_semibold().text_color(folder.focused ? colors.accent : colors.foreground).child(folder.name))
      .when(Boolean(folder.branch), (el) => el.child(div().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(folder.branch)))
      .child(div().flex_1())
      .when(Boolean(folder.status), (el) => el.child(Dot(VxRunning.statusColor(folder.status, colors))))
      .child(div().text_size(TEXT.caption).text_color(colors.dim).child(VxRunning.counts(folder)))
      .child(IconButton({ id: `new-${folder.path}`, icon: "plus", label: "New terminal here", onClick: () => this.newTerminal(folder) }))
      .child(IconButton({ id: `close-${folder.path}`, icon: "x", label: "Close all", onClick: () => this.askClose(`Close everything in ${folder.name}?`, folder.rows) }));
  }

  paneRow(row, colors) {
    const name = row.title && row.title !== row.label ? row.title : baseName(row.cwd);
    return h_flex().id(`p-${row.pane}`).h(VxRunning.ROW_HEIGHT).pl(VxRunning.INDENT_PX + 6).pr(6).gap(6).items_center().cursor_pointer()
      .when(row.focused, (el) => el.bg(colors.selected))
      .hover((style) => style.bg(colors.hover))
      .on_click(() => this.focusRow(row))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        this.askClose(`Close ${row.label}?`, [row]);
      })
      .child(Dot(VxRunning.statusColor(row.status, colors)))
      .child(VxRunning.programIcon(row.program))
      .child(div().flex_none().text_color(row.focused ? colors.foreground : colors.muted).child(row.label))
      .child(div().flex_1().truncate().text_size(TEXT.caption).text_color(colors.dim).child(name))
      .child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(row.tabName));
  }

  render() {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    const colors = theme();
    const folders = groupRunning({ panes: panes(), spaces: spaces(), roots: this.roots });
    const rows = folders.flatMap((folder) => [
      this.folderRow(folder, colors),
      ...(this.collapsed.has(folder.path) ? [] : folder.rows.map((row) => this.paneRow(row, colors))),
    ]);
    return v_flex().id(VxRunning.MOD).size_full().bg(colors.chrome).text_size(TEXT.small).text_color(colors.foreground)
      .overflow_y_scrollbar()
      .when(folders.length === 0, (el) => el.child(div().p(12).text_color(colors.dim).child("Nothing running.")))
      .children(rows);
  }

  static {
    Object.assign(VxRunning.prototype, confirmMethods);
  }
}

export default VxRunning;
