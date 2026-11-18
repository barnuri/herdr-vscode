// The right-click menu of the Running view, drawn by a popup copy of herdr-vscode-running (props().menu)
// and the pane actions the view and the menu share. Menu items are plain data, so they cross
// into the popup copy: { label, icon, danger?, act: { type, ... } }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, props, closeOverlay, openOverlay } from "herdr";
import { setActive } from "./ws.js";
import { askConfirm } from "./actions.js";
import { TEXT, Icon } from "./ui.js";

class RunningMenu {
  static MOD = "herdr-vscode-running";
  static STACK = "sidebar-views";
  static SCM_VIEW = "scm";
  static SIDEBAR = "sidebar";
  static WIDTH = 240;
  static ROW_PX = 26;
  static HEAD_PX = 44;
  static PAD_PX = 8;
  static ICON_PX = 13;

  // Ending the terminal closes its pane, and its tab and space when it was the last one, so
  // closing many panes never stops on a "close the space?" question.
  static closeAction(rows) {
    return {
      doing: "Closing",
      done: "Closed",
      steps: rows.map((row) => (row.terminal ? { command: "terminal.kill", args: { terminal: row.terminal } } : { command: "pane.close", args: { pane: row.pane } })),
    };
  }

  // One pane closes at once unless confirmKill; more always ask.
  static closeRows(title, rows, confirmKill) {
    if (rows.length === 0) {
      return;
    }
    if (rows.length === 1 && !confirmKill) {
      const [step] = RunningMenu.closeAction(rows).steps;
      run(step.command, step.args);
      return;
    }
    askConfirm(RunningMenu.MOD, {
      title,
      detail: rows.map((row) => `${row.label}${row.title ? `: ${row.title}` : ""}`).join(", "),
      label: "Close",
      danger: true,
      action: RunningMenu.closeAction(rows),
    });
  }

  static focusRow(row) {
    if (row.space) {
      run("space.select", { id: row.space });
    }
    run("tab.select", { id: row.tab });
    run("pane.focus", { pane: row.pane });
  }

  static newTab(folder, space) {
    run("tab.new", space ? { folder, space } : { folder });
  }

  static showChanges(path, name) {
    setActive({ path, name });
    run("layout.select", { stack: RunningMenu.STACK, child: RunningMenu.SCM_VIEW });
    run("layout.show", { id: RunningMenu.SIDEBAR });
  }

  static brief(row) {
    return { pane: row.pane, tab: row.tab, space: row.space, label: row.label, title: row.title };
  }

  static paneItems(row, folder, confirmKill) {
    const items = [
      { label: "Focus", icon: "eye", act: { type: "focus", row: RunningMenu.brief(row) } },
      { label: "New tab here", icon: "plus", act: { type: "newTab", folder: folder.path, space: row.space } },
    ];
    if (folder.isRepo) {
      items.push({ label: "Show git changes", icon: "branch", act: { type: "scm", path: folder.path, name: folder.name } });
    }
    items.push({ label: "Close", icon: "x", danger: true, act: { type: "close", title: `Close ${row.label}?`, rows: [RunningMenu.brief(row)], confirmKill } });
    return items;
  }

  static folderItems(folder, confirmKill) {
    const space = folder.rows.find((row) => row.space)?.space ?? null;
    const items = [{ label: "New tab here", icon: "plus", act: { type: "newTab", folder: folder.path, space } }];
    if (folder.isRepo) {
      items.push({ label: "Show git changes", icon: "branch", act: { type: "scm", path: folder.path, name: folder.name } });
    }
    items.push({
      label: "Close all", icon: "trash", danger: true,
      act: { type: "close", title: `Close everything in ${folder.name}?`, rows: folder.rows.map(RunningMenu.brief), confirmKill },
    });
    return items;
  }

  static open(title, subtitle, items) {
    const height = RunningMenu.HEAD_PX + items.length * RunningMenu.ROW_PX + RunningMenu.PAD_PX;
    openOverlay({ mod: RunningMenu.MOD, kind: "popup", width: RunningMenu.WIDTH, height, props: { menu: { title, subtitle, items } } });
  }

  static fire(act) {
    const actions = {
      focus: () => RunningMenu.focusRow(act.row),
      newTab: () => RunningMenu.newTab(act.folder, act.space),
      scm: () => RunningMenu.showChanges(act.path, act.name),
      close: () => RunningMenu.closeRows(act.title, act.rows, act.confirmKill),
    };
    actions[act.type]?.();
  }

  constructor(menu, cx) {
    this.menu = menu;
    this.selected = 0;
    this.focus = cx.focus_handle();
    this.focus.focus();
  }

  choose(index) {
    const item = this.menu.items[index];
    closeOverlay(props()?.overlay);
    if (item) {
      RunningMenu.fire(item.act);
    }
  }

  onKey(event, cx) {
    const last = this.menu.items.length - 1;
    const moves = { down: 1, up: -1 };
    if (event.key in moves) {
      this.selected = Math.min(last, Math.max(0, this.selected + moves[event.key]));
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (event.key === "enter") {
      this.choose(this.selected);
    }
    if (event.key === "escape") {
      closeOverlay(props()?.overlay);
    }
  }

  row(t, item, index) {
    const color = item.danger ? t.ansi1 : t.foreground;
    return h_flex().id(`menu-${index}`).h(RunningMenu.ROW_PX).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover))
      .on_click(() => this.choose(index))
      .child(Icon(item.icon, RunningMenu.ICON_PX).text_color(item.danger ? t.ansi1 : t.muted))
      .child(div().flex_1().truncate().text_size(TEXT.body).text_color(color).child(item.label));
  }

  render() {
    const t = theme();
    return v_flex().id("running-menu").size_full().p(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(v_flex().px(8).pt(4).pb(6)
        .child(div().truncate().text_size(TEXT.small).font_semibold().child(this.menu.title ?? ""))
        .when(Boolean(this.menu.subtitle), (el) => el.child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(this.menu.subtitle))))
      .children(this.menu.items.map((item, index) => this.row(t, item, index)));
  }
}

export default RunningMenu;
